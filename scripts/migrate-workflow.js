#!/usr/bin/env node
// Usage: node scripts/migrate-workflow.js <input_workflow.json> <output_workflow.json>
// Converts an old linear step-based workflow to the new graph-based workflow format.

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile || !outputFile) {
  console.error('Usage: node scripts/migrate-workflow.js <input.json> <output.json>');
  process.exit(1);
}

let oldData;
try {
  oldData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
} catch (e) {
  console.error(`Failed to read or parse input file: ${e.message}`);
  process.exit(1);
}

// Check if it's already in the new format
if (Array.isArray(oldData.nodes) && Array.isArray(oldData.edges)) {
  console.log('Workflow is already in the graph format. Copying as is.');
  fs.writeFileSync(outputFile, JSON.stringify(oldData, null, 2));
  process.exit(0);
}

if (!Array.isArray(oldData.steps)) {
  console.error('Input JSON is not a valid old-format workflow (missing "steps" array).');
  process.exit(1);
}

const nodes = [];
const edges = [];

oldData.steps.forEach((step, idx) => {
  const id = `node_${idx + 1}`;
  const { type, ...restConfig } = step;

  // Position them sequentially downwards
  const position = {
    x: 100,
    y: 100 + idx * 150
  };

  nodes.push({
    id,
    type,
    position,
    config: restConfig,
    inputs: {},
    outputs: {}
  });

  if (idx > 0) {
    edges.push({
      source: `node_${idx}`,
      target: id,
      sourceHandle: 'success'
    });
  }
});

const newWorkflow = {
  $schema: './workflow.schema.json',
  name: oldData.name || 'migrated-workflow',
  nodes,
  edges
};

fs.writeFileSync(outputFile, JSON.stringify(newWorkflow, null, 2));
console.log(`Successfully migrated workflow to graph format and saved to ${outputFile}`);
