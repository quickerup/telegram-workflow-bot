#!/usr/bin/env node
// Reads a client_payload JSON file (from repository_dispatch), executes the
// steps in order, and writes an execution log to executions/.
//
// Supported step types:
//   { "type": "run",    "command": "...", "timeout_ms": 60000, "continue_on_error": false }
//   { "type": "http",   "method": "GET|POST|...", "url": "...", "headers": {...}, "body": {...}, "timeout_ms": 15000 }
//   { "type": "delay",  "ms": 1000 }
//   { "type": "notify", "message": "..." }   // requires TELEGRAM_BOT_TOKEN + chat_id
//
// Add new step types by extending runStep() below.

const fs = require('fs');
const { execSync } = require('child_process');

const ALLOWED_TYPES = new Set(['run', 'http', 'delay', 'notify']);
const MAX_STEPS = 50;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const OUTPUT_CHAR_LIMIT = 4000;

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node executor.js <payload.json>');
  process.exit(1);
}

const raw = fs.readFileSync(inputFile, 'utf8');
const data = JSON.parse(raw);

// The Worker sends { payload: <workflow JSON>, chat_id, message_id }.
// Support being handed the workflow JSON directly too, for local testing.
const workflow = data.payload || data;
const chatId = data.chat_id;
const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
const name = workflow.name || 'unnamed-workflow';

if (steps.length > MAX_STEPS) {
  console.error(`Refusing to run: ${steps.length} steps exceeds max of ${MAX_STEPS}`);
  process.exit(1);
}

const log = {
  name,
  started_at: new Date().toISOString(),
  steps: [],
};

function truncate(str) {
  if (typeof str !== 'string') return str;
  return str.length > OUTPUT_CHAR_LIMIT ? str.slice(0, OUTPUT_CHAR_LIMIT) + '…[truncated]' : str;
}

async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return; // silently skip if not configured
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStep(step, index) {
  const entry = { index, type: step.type, started_at: new Date().toISOString() };

  if (!ALLOWED_TYPES.has(step.type)) {
    entry.status = 'failed';
    entry.error = `Unknown step type: ${step.type}`;
    entry.finished_at = new Date().toISOString();
    throw Object.assign(new Error(entry.error), { entry });
  }

  try {
    if (step.type === 'run') {
      const timeoutMs = step.timeout_ms || DEFAULT_RUN_TIMEOUT_MS;
      const output = execSync(step.command, {
        encoding: 'utf8',
        shell: '/bin/bash',
        timeout: timeoutMs,
      });
      entry.output = truncate(output);
      entry.status = 'success';
    } else if (step.type === 'http') {
      const timeoutMs = step.timeout_ms || DEFAULT_HTTP_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(step.url, {
          method: step.method || 'GET',
          headers: step.headers || {},
          body: step.body ? JSON.stringify(step.body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      entry.http_status = res.status;
      entry.response = truncate(text);
      entry.status = res.ok ? 'success' : 'failed';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (step.type === 'delay') {
      const ms = Math.min(step.ms || 0, 5 * 60_000); // cap at 5 minutes
      await withTimeout(new Promise((r) => setTimeout(r, ms)), ms + 1000, 'delay');
      entry.status = 'success';
    } else if (step.type === 'notify') {
      await sendTelegramMessage(step.message);
      entry.status = 'success';
    }
  } catch (err) {
    entry.status = step.continue_on_error ? 'failed_ignored' : (entry.status || 'failed');
    entry.error = err.message;
    entry.finished_at = new Date().toISOString();
    if (step.continue_on_error) return entry; // swallow, don't throw
    throw Object.assign(err, { entry });
  }
  entry.finished_at = new Date().toISOString();
  return entry;
}

(async () => {
  let overallStatus = 'success';

  for (let i = 0; i < steps.length; i++) {
    try {
      const entry = await runStep(steps[i], i);
      log.steps.push(entry);
      if (entry.status === 'failed_ignored') overallStatus = 'partial_failure';
    } catch (err) {
      log.steps.push(err.entry || { index: i, status: 'failed', error: err.message });
      overallStatus = 'failed';
      break; // stop on first (non-ignored) failure
    }
  }

  log.status = overallStatus;
  log.finished_at = new Date().toISOString();

  fs.mkdirSync('executions', { recursive: true });
  const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
  const filename = `executions/${safeName}-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(log, null, 2));

  console.log(`Execution log written to ${filename}`);
  console.log(JSON.stringify(log, null, 2));

  if (overallStatus === 'failed') process.exit(1);
})();
