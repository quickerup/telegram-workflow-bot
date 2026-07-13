#!/usr/bin/env node
// Usage: node scripts/validate.js workflows/example.json
// Validates workflow shape locally, without needing Telegram/GitHub round-trips.

const fs = require('fs');

const ALLOWED_TYPES = new Set(['run', 'http', 'delay', 'notify']);
const MAX_STEPS = 50;

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
if (!Array.isArray(workflow.steps)) {
  errors.push('workflow.steps must be an array');
} else {
  if (workflow.steps.length === 0) errors.push('workflow.steps must not be empty');
  if (workflow.steps.length > MAX_STEPS) errors.push(`too many steps (max ${MAX_STEPS})`);

  workflow.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') {
      errors.push(`step ${i}: must be an object`);
      return;
    }
    if (!ALLOWED_TYPES.has(step.type)) {
      errors.push(`step ${i}: unknown type "${step.type}" (allowed: ${[...ALLOWED_TYPES].join(', ')})`);
    }
    if (step.type === 'run' && typeof step.command !== 'string') {
      errors.push(`step ${i}: "run" steps need a string "command"`);
    }
    if (step.type === 'http' && typeof step.url !== 'string') {
      errors.push(`step ${i}: "http" steps need a string "url"`);
    }
    if (step.type === 'delay' && typeof step.ms !== 'number') {
      errors.push(`step ${i}: "delay" steps need a numeric "ms"`);
    }
    if (step.type === 'notify' && typeof step.message !== 'string') {
      errors.push(`step ${i}: "notify" steps need a string "message"`);
    }
  });
}

if (errors.length) {
  console.error('Validation failed:');
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

console.log(`OK: "${workflow.name}" — ${workflow.steps.length} step(s) look valid.`);
