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
const triggerPayload = data.trigger_payload || data.trigger_data || null;

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

function getNestedValue(obj, pathStr) {
  const parts = pathStr.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    // Block localhost / loopback / standard unsafe addresses
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return false;
    }
    // Block AWS / Cloud metadata Link-local
    if (hostname === '169.254.169.254') {
      return false;
    }
    // Block private IP ranges
    if (
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      (hostname.startsWith('172.') && isPrivate172(hostname))
    ) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function isPrivate172(hostname) {
  const parts = hostname.split('.');
  if (parts.length < 2) return false;
  const secondOctet = parseInt(parts[1], 10);
  return secondOctet >= 16 && secondOctet <= 31;
}

function interpolate(value, nodeResults, escapeFn = null) {
  if (typeof value === 'string') {
    const singleMatch = value.match(/^\{\{\s*nodes\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_\.-]+)\s*\}\}$/);
    if (singleMatch) {
      const nodeId = singleMatch[1];
      const path = singleMatch[2];
      const nodeRes = nodeResults[nodeId];
      if (nodeRes && nodeRes.outputs) {
        const val = getNestedValue(nodeRes.outputs, path);
        if (val !== undefined) {
          if (escapeFn) {
            return escapeFn(val, nodeRes.type);
          }
          return val;
        }
      }
      return undefined;
    }

    return value.replace(/\{\{\s*nodes\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_\.-]+)\s*\}\}/g, (match, nodeId, path) => {
      const nodeRes = nodeResults[nodeId];
      if (nodeRes && nodeRes.outputs) {
        const val = getNestedValue(nodeRes.outputs, path);
        if (val !== undefined) {
          const rawVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
          if (escapeFn) {
            return escapeFn(rawVal, nodeRes.type);
          }
          return rawVal;
        }
      }
      return match;
    });
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(item, nodeResults, escapeFn));
  } else if (value !== null && typeof value === 'object') {
    const res = {};
    for (const k of Object.keys(value)) {
      res[k] = interpolate(value[k], nodeResults, escapeFn);
    }
    return res;
  }
  return value;
}

async function runNode(node, index, nodeResults, triggerPayload) {
  const entry = { id: node.id, index, type: node.type, started_at: new Date().toISOString() };

  if (!ALLOWED_TYPES.has(node.type)) {
    entry.status = 'failed';
    entry.error = `Unknown node type: ${node.type}`;
    entry.finished_at = new Date().toISOString();
    throw Object.assign(new Error(entry.error), { entry });
  }

  // Interpolate inputs and config using outputs from previously executed nodes
  const resolvedInputs = node.inputs ? interpolate(node.inputs, nodeResults) : {};
  let resolvedConfig;

  if (node.type === 'http') {
    resolvedConfig = {};
    const configKeys = Object.keys(node.config || {});
    for (const key of configKeys) {
      if (key === 'url') {
        const isSingleTemplate = /^\{\{\s*nodes\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_\.-]+\s*\}\}$/.test((node.config.url || '').trim());
        if (isSingleTemplate) {
          resolvedConfig.url = interpolate(node.config.url, nodeResults);
        } else {
          const escapeUrlParam = (val, nodeType) => {
            const isTrigger = ['webhook_trigger', 'cron_trigger', 'telegram_event_trigger'].includes(nodeType);
            if (isTrigger) {
              return encodeURIComponent(String(val));
            }
            return val;
          };
          resolvedConfig.url = interpolate(node.config.url, nodeResults, escapeUrlParam);
        }

        // Always check that resolved URL is safe (blocking SSRF loopback/private IPs/unsafe protocols)
        if (resolvedConfig.url && !isSafeUrl(resolvedConfig.url)) {
          throw new Error(`SSRF Block: The URL "${resolvedConfig.url}" is unsafe or resolves to a local/private address.`);
        }
      } else if (key === 'headers') {
        const escapeHeaderValue = (val, nodeType) => {
          const isTrigger = ['webhook_trigger', 'cron_trigger', 'telegram_event_trigger'].includes(nodeType);
          if (isTrigger) {
            return String(val).replace(/[\r\n\x00-\x1F\x7F]/g, '');
          }
          return val;
        };
        resolvedConfig.headers = interpolate(node.config.headers, nodeResults, escapeHeaderValue);
      } else {
        resolvedConfig[key] = interpolate(node.config[key], nodeResults);
      }
    }
  } else if (node.type === 'run') {
    resolvedConfig = {};
    const configKeys = Object.keys(node.config || {});
    for (const key of configKeys) {
      if (key === 'command') {
        const shellEscape = (val, nodeType) => {
          const isTrigger = ['webhook_trigger', 'cron_trigger', 'telegram_event_trigger'].includes(nodeType);
          if (isTrigger) {
            // Safely wrap the string in single quotes, escaping any single quotes inside.
            return "'" + String(val).replace(/'/g, "'\\''") + "'";
          }
          return val;
        };
        resolvedConfig.command = interpolate(node.config.command, nodeResults, shellEscape);
      } else {
        resolvedConfig[key] = interpolate(node.config[key], nodeResults);
      }
    }
  } else {
    resolvedConfig = interpolate(node.config || {}, nodeResults);
  }

  entry.inputs = node.inputs || {};
  entry.resolved_inputs = resolvedInputs;
  entry.resolved_config = resolvedConfig;

  const step = resolvedConfig;

  try {
    if (node.type === 'run') {
      const timeoutMs = step.timeout_ms || DEFAULT_RUN_TIMEOUT_MS;
      const output = execSync(step.command, {
        encoding: 'utf8',
        shell: '/bin/bash',
        timeout: timeoutMs,
      });
      entry.output = truncate(output);
      entry.outputs = { output: truncate(output).trim() };
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
          body: step.body ? (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      entry.http_status = res.status;
      entry.response = truncate(text);

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(text);
      } catch (e) {
        parsedResponse = text;
      }
      entry.outputs = {
        response: parsedResponse,
        status: res.status
      };

      entry.status = res.ok ? 'success' : 'failed';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (node.type === 'delay') {
      const ms = Math.min(step.ms || 0, 5 * 60_000); // cap at 5 minutes
      await withTimeout(new Promise((r) => setTimeout(r, ms)), ms + 1000, 'delay');
      entry.outputs = { ms };
      entry.status = 'success';
    } else if (node.type === 'notify') {
      await sendTelegramMessage(step.message);
      entry.outputs = { message: step.message };
      entry.status = 'success';
    } else if (node.type === 'webhook_trigger' || node.type === 'cron_trigger' || node.type === 'telegram_event_trigger') {
      entry.outputs = triggerPayload || {};
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
      entry = await runNode(node, index++, nodeResults, triggerPayload);
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
