#!/usr/bin/env node
// Reads a client_payload JSON file (from repository_dispatch), executes the
// nodes as a graph based on edges and handles, and writes an execution log to executions/.
//
// Supported node types (placed inside config):
//   { "type": "run",    "config": { "command": "...", "timeout_ms": 60000, "continue_on_error": false } }
//   { "type": "http",   "config": { "method": "GET|POST|...", "url": "...", "headers": {...}, "body": {...}, "timeout_ms": 15000 } }
//   { "type": "delay",  "config": { "ms": 1000 } }
//   { "type": "notify", "config": { "message": "..." } }   // requires TELEGRAM_BOT_TOKEN + chat_id

const fs = require('fs');
const { execSync } = require('child_process');

const ALLOWED_TYPES = new Set(['run', 'http', 'delay', 'notify', 'webhook_trigger', 'cron_trigger', 'telegram_event_trigger']);
const MAX_NODES = 50;
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

// The Worker sends { payload: <workflow JSON>, chat_id, execution_id, worker_url }.
// Support being handed the workflow JSON directly too, for local testing.
const workflow = data.payload || data;
const chatId = data.chat_id;
const executionId = data.execution_id;
const workerUrl = data.worker_url;

const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
const name = workflow.name || 'unnamed-workflow';

if (nodes.length > MAX_NODES) {
  console.error(`Refusing to run: ${nodes.length} nodes exceeds max of ${MAX_NODES}`);
  process.exit(1);
}

const log = {
  name,
  started_at: new Date().toISOString(),
  steps: [], // Keep steps array for log consistency / schema compat
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

async function runNode(node, index) {
  const entry = { id: node.id, index, type: node.type, started_at: new Date().toISOString() };
  const step = node.config || {};

  if (!ALLOWED_TYPES.has(node.type)) {
    entry.status = 'failed';
    entry.error = `Unknown node type: ${node.type}`;
    entry.finished_at = new Date().toISOString();
    throw Object.assign(new Error(entry.error), { entry });
  }

  try {
    if (node.type === 'run') {
      const timeoutMs = step.timeout_ms || DEFAULT_RUN_TIMEOUT_MS;
      const output = execSync(step.command, {
        encoding: 'utf8',
        shell: '/bin/bash',
        timeout: timeoutMs,
      });
      entry.output = truncate(output);
      entry.status = 'success';
    } else if (node.type === 'http') {
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
    } else if (node.type === 'delay') {
      const ms = Math.min(step.ms || 0, 5 * 60_000); // cap at 5 minutes
      await withTimeout(new Promise((r) => setTimeout(r, ms)), ms + 1000, 'delay');
      entry.status = 'success';
    } else if (node.type === 'notify') {
      await sendTelegramMessage(step.message);
      entry.status = 'success';
    } else if (node.type === 'webhook_trigger' || node.type === 'cron_trigger' || node.type === 'telegram_event_trigger') {
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

  // Build graph representations
  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  // Outgoing edges per node
  const outgoing = {};
  nodes.forEach(n => { outgoing[n.id] = []; });
  edges.forEach(e => {
    if (outgoing[e.source]) {
      outgoing[e.source].push(e);
    }
  });

  // Find start nodes (nodes with no incoming edges)
  const incomingCount = {};
  nodes.forEach(n => { incomingCount[n.id] = 0; });
  edges.forEach(e => {
    if (incomingCount[e.target] !== undefined) {
      incomingCount[e.target]++;
    }
  });

  const startNodes = nodes.filter(n => incomingCount[n.id] === 0);

  // If there's no node with 0 incoming count but we have nodes, default to the first node
  let queue = [];
  if (startNodes.length > 0) {
    queue = startNodes.map(n => n.id);
  } else if (nodes.length > 0) {
    queue = [nodes[0].id];
  }

  const executed = new Set();
  const nodeResults = {}; // maps nodeId to its execution entry

  let index = 0;
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (executed.has(currentId)) continue;

    // Ensure all incoming dependency nodes that were actually reached have executed.
    // However, in standard workflow branch execution, some incoming paths might never execute.
    // We proceed to run the node.
    const node = nodeMap[currentId];
    if (!node) continue;

    let entry;
    try {
      entry = await runNode(node, index++);
      log.steps.push(entry);
      nodeResults[currentId] = entry;
      executed.add(currentId);
      if (entry.status === 'failed_ignored') {
        if (overallStatus === 'success') overallStatus = 'partial_failure';
      }
    } catch (err) {
      entry = err.entry || { id: currentId, index, status: 'failed', error: err.message };
      log.steps.push(entry);
      nodeResults[currentId] = entry;
      executed.add(currentId);
      overallStatus = 'failed';
    }

    // Determine next nodes to queue based on edges
    const outEdges = outgoing[currentId] || [];
    outEdges.forEach(edge => {
      const handle = edge.sourceHandle || 'success';
      const status = entry.status; // 'success', 'failed', 'failed_ignored'

      let follow = false;
      if (handle === 'always') {
        follow = true;
      } else if (handle === 'success') {
        follow = (status === 'success' || status === 'failed_ignored');
      } else if (handle === 'failure') {
        follow = (status === 'failed');
      }

      if (follow) {
        queue.push(edge.target);
      }
    });

    // If a node fails without continue_on_error and there is no failure branch, we abort the entire run.
    if (entry.status === 'failed' && !outEdges.some(e => e.sourceHandle === 'failure' || e.sourceHandle === 'always')) {
      break;
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

  // If worker_url and executionId are provided, call back to Cloudflare D1
  if (workerUrl && executionId) {
    const reportUrl = `${workerUrl.replace(/\/$/, '')}/executions/${executionId}`;
    console.log(`Reporting execution status to ${reportUrl}...`);
    try {
      const response = await fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: overallStatus,
          started_at: log.started_at,
          finished_at: log.finished_at,
          log: log,
        }),
      });
      if (response.ok) {
        console.log('Execution successfully reported to D1.');
      } else {
        console.error(`Failed to report execution to D1: ${response.status} ${await response.text()}`);
      }
    } catch (e) {
      console.error(`Error reporting execution to D1: ${e.message}`);
    }
  }

  if (overallStatus === 'failed') process.exit(1);
})();
