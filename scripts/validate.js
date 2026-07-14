#!/usr/bin/env node
// Usage: node scripts/validate.js workflows/example.json
// Validates graph-based workflow shape locally, without needing Telegram/GitHub round-trips.

const fs = require('fs');

const ALLOWED_TYPES = new Set(['run', 'http', 'delay', 'notify', 'webhook_trigger', 'cron_trigger', 'telegram_event_trigger']);
const MAX_NODES = 50;

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/validate.js <workflow.json>');
  process.exit(1);
}

let workflow;
try {
  workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Invalid JSON: ${e.message}`);
  process.exit(1);
}

const errors = [];

if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
  errors.push('workflow.name must be a non-empty string');
}

if (!Array.isArray(workflow.nodes)) {
  errors.push('workflow.nodes must be an array');
} else {
  if (workflow.nodes.length === 0) errors.push('workflow.nodes must not be empty');
  if (workflow.nodes.length > MAX_NODES) errors.push(`too many nodes (max ${MAX_NODES})`);

  const nodeIds = new Set();

  workflow.nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') {
      errors.push(`node ${i}: must be an object`);
      return;
    }
    if (typeof node.id !== 'string' || !node.id.trim()) {
      errors.push(`node ${i}: "id" must be a non-empty string`);
    } else {
      if (nodeIds.has(node.id)) {
        errors.push(`node ${i}: duplicate "id" "${node.id}"`);
      }
      nodeIds.add(node.id);
    }

    if (!ALLOWED_TYPES.has(node.type)) {
      errors.push(`node ${i} (${node.id || 'unnamed'}): unknown type "${node.type}" (allowed: ${[...ALLOWED_TYPES].join(', ')})`);
    }

    if (!node.position || typeof node.position !== 'object') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): missing or invalid "position" object`);
    } else {
      if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
        errors.push(`node ${i} (${node.id || 'unnamed'}): position "x" and "y" must be numbers`);
      }
    }

    if (!node.config || typeof node.config !== 'object') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): missing or invalid "config" object`);
      return;
    }

    const { config } = node;
    if (node.type === 'run' && typeof config.command !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "run" config needs a string "command"`);
    }
    if (node.type === 'http' && typeof config.url !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "http" config needs a string "url"`);
    }
    if (node.type === 'delay' && typeof config.ms !== 'number') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "delay" config needs a numeric "ms"`);
    }
    if (node.type === 'notify' && typeof config.message !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "notify" config needs a string "message"`);
    }
    if (node.type === 'cron_trigger' && typeof config.cron !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "cron_trigger" config needs a string "cron"`);
    }
    if (node.type === 'telegram_event_trigger') {
      if (typeof config.event_type !== 'string' && !Array.isArray(config.event_type)) {
        errors.push(`node ${i} (${node.id || 'unnamed'}): "telegram_event_trigger" config needs a string or array "event_type"`);
      }
    }
  });

  if (Array.isArray(workflow.edges)) {
    workflow.edges.forEach((edge, i) => {
      if (!edge || typeof edge !== 'object') {
        errors.push(`edge ${i}: must be an object`);
        return;
      }
      if (typeof edge.source !== 'string' || !edge.source.trim()) {
        errors.push(`edge ${i}: "source" must be a non-empty string`);
      } else if (!nodeIds.has(edge.source)) {
        errors.push(`edge ${i}: source node "${edge.source}" does not exist`);
      }

      if (typeof edge.target !== 'string' || !edge.target.trim()) {
        errors.push(`edge ${i}: "target" must be a non-empty string`);
      } else if (!nodeIds.has(edge.target)) {
        errors.push(`edge ${i}: target node "${edge.target}" does not exist`);
      }

      if (edge.sourceHandle && !['success', 'failure', 'always'].includes(edge.sourceHandle)) {
        errors.push(`edge ${i}: sourceHandle "${edge.sourceHandle}" is invalid (must be "success", "failure", or "always")`);
      }
    });

    // Cycle detection using DFS
    const adj = {};
    nodeIds.forEach(id => { adj[id] = []; });
    workflow.edges.forEach(edge => {
      if (adj[edge.source] && edge.target) {
        adj[edge.source].push(edge.target);
      }
    });

    const visited = {};
    const recStack = {};

    function hasCycle(nodeId) {
      if (!visited[nodeId]) {
        visited[nodeId] = true;
        recStack[nodeId] = true;

        const neighbors = adj[nodeId] || [];
        for (const neighbor of neighbors) {
          if (!visited[neighbor] && hasCycle(neighbor)) {
            return true;
          } else if (recStack[neighbor]) {
            return true;
          }
        }
      }
      recStack[nodeId] = false;
      return false;
    }

    let cycleDetected = false;
    for (const nodeId of nodeIds) {
      if (hasCycle(nodeId)) {
        cycleDetected = true;
        break;
      }
    }

    if (cycleDetected) {
      errors.push('workflow has cycles, but must be a Directed Acyclic Graph (DAG)');
    }
  } else {
    errors.push('workflow.edges must be an array');
  }
}

if (errors.length) {
  console.error('Validation failed:');
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

console.log(`OK: "${workflow.name}" — ${workflow.nodes.length} node(s) and ${(workflow.edges || []).length} edge(s) look valid.`);
