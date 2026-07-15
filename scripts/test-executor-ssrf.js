const { execSync } = require('child_process');
const fs = require('fs');

console.log('Running Executor SSRF and Injection Security Tests...');

// Helper to run executor on a payload and return its log
function runExecutor(payload) {
  const tmpFile = `tmp-test-payload-${Date.now()}.json`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  let log = null;
  let error = null;
  try {
    execSync(`node scripts/executor.js ${tmpFile}`, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    error = err;
  } finally {
    // Find the latest execution log in executions/
    try {
      const files = fs.readdirSync('executions').map(f => ({
        name: f,
        mtime: fs.statSync(`executions/${f}`).mtime
      })).sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        log = JSON.parse(fs.readFileSync(`executions/${files[0].name}`, 'utf8'));
      }
    } catch (e) {}

    // Clean up
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    try {
      const files = fs.readdirSync('executions');
      for (const f of files) {
        fs.unlinkSync(`executions/${f}`);
      }
    } catch (e) {}
  }
  return { log, error };
}

// Test Case 1: Block SSRF URL (localhost)
console.log('Test Case 1: SSRF Block (localhost)...');
const payloadLocalhost = {
  payload: {
    name: "SSRF Localhost Test",
    nodes: [
      {
        id: "webhook",
        type: "webhook_trigger",
        position: { x: 0, y: 0 },
        config: {}
      },
      {
        id: "http_step",
        type: "http",
        position: { x: 0, y: 0 },
        config: {
          url: "http://localhost:8787/api/workflows"
        }
      }
    ],
    edges: [
      { source: "webhook", target: "http_step", sourceHandle: "success" }
    ]
  },
  trigger_payload: {}
};

const resultLocalhost = runExecutor(payloadLocalhost);
if (!resultLocalhost.error) {
  throw new Error('Expected executor to fail on SSRF localhost URL, but it succeeded.');
}
const httpStepLocal = resultLocalhost.log?.steps.find(s => s.id === 'http_step');
if (!httpStepLocal || httpStepLocal.status !== 'failed' || !httpStepLocal.error.includes('SSRF Block')) {
  throw new Error(`Expected http_step to fail with SSRF Block, got: ${JSON.stringify(httpStepLocal)}`);
}
console.log('Test Case 1 Passed!');

// Test Case 2: URL Parameter Escaping (path traversal attempt)
console.log('Test Case 2: Path traversal parameter escaping...');
const payloadTraversal = {
  payload: {
    name: "SSRF Path Traversal Test",
    nodes: [
      {
        id: "webhook",
        type: "webhook_trigger",
        position: { x: 0, y: 0 },
        config: {}
      },
      {
        id: "http_step",
        type: "http",
        position: { x: 0, y: 0 },
        config: {
          url: "https://api.github.com/repos/{{ nodes.webhook.outputs.repo }}"
        }
      }
    ],
    edges: [
      { source: "webhook", target: "http_step", sourceHandle: "success" }
    ]
  },
  trigger_payload: {
    repo: "owner/../traversal"
  }
};

const resultTraversal = runExecutor(payloadTraversal);
// It should attempt to make a request to https://api.github.com/repos/owner%2F..%2Ftraversal
// (since it contains %2F, it does not do traversal and is a safe URL structure, although GitHub API will return 404/403)
const httpStep = resultTraversal.log?.steps.find(s => s.id === 'http_step');
if (!httpStep) {
  throw new Error('Expected http_step to be logged');
}
if (!httpStep.resolved_config.url.includes('owner%2F..%2Ftraversal')) {
  throw new Error(`Expected URL to have encoded parameter, got: ${httpStep.resolved_config.url}`);
}
console.log('Test Case 2 Passed!');

// Test Case 3: Header Sanitization (CRLF Injection block)
console.log('Test Case 3: CRLF Injection in Header value...');
const payloadHeader = {
  payload: {
    name: "Header CRLF Test",
    nodes: [
      {
        id: "webhook",
        type: "webhook_trigger",
        position: { x: 0, y: 0 },
        config: {}
      },
      {
        id: "http_step",
        type: "http",
        position: { x: 0, y: 0 },
        config: {
          url: "https://example.com",
          headers: {
            "X-Test-Header": "{{ nodes.webhook.outputs.malicious_header }}"
          }
        }
      }
    ],
    edges: [
      { source: "webhook", target: "http_step", sourceHandle: "success" }
    ]
  },
  trigger_payload: {
    malicious_header: "safe_value\r\nInjected-Header: evil"
  }
};

const resultHeader = runExecutor(payloadHeader);
const httpStepHeader = resultHeader.log?.steps.find(s => s.id === 'http_step');
if (!httpStepHeader) {
  throw new Error('Expected http_step to be logged');
}
const resolvedHeaderVal = httpStepHeader.resolved_config.headers["X-Test-Header"];
if (resolvedHeaderVal.includes('\r') || resolvedHeaderVal.includes('\n')) {
  throw new Error(`Expected CRLF to be stripped from header value, got: ${JSON.stringify(resolvedHeaderVal)}`);
}
if (resolvedHeaderVal !== "safe_valueInjected-Header: evil") {
  throw new Error(`Expected cleaned header value, got: ${resolvedHeaderVal}`);
}
console.log('Test Case 3 Passed!');

console.log('\nAll Executor SSRF and Injection Security Tests Passed Successfully!');
process.exit(0);
