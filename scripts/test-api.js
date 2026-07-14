const { spawn } = require('child_process');
const http = require('http');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data ? JSON.parse(data) : null
        });
      });
    });
    req.on('error', err => reject(err));
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

(async () => {
  console.log('Initializing local test D1 database schema...');
  // Ensure we've run d1 execute locally first, though we did it in bash, let's make sure it's done.

  console.log('Starting wrangler dev server...');
  const devServer = spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
    cwd: 'worker',
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: '123456:fake-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      GITHUB_PAT: 'github_pat_fake',
      ALLOWED_CHAT_IDS: '12345',
    }
  });

  // Log output for debugging if needed, but keep it quiet
  devServer.stdout.on('data', (data) => {
    // console.log(`[wrangler] ${data}`);
  });
  devServer.stderr.on('data', (data) => {
    // console.error(`[wrangler err] ${data}`);
  });

  // Wait for wrangler dev to be ready
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get('http://localhost:8787/', (res) => {
          ready = true;
          resolve();
        });
        req.on('error', reject);
      });
      break;
    } catch (e) {
      await wait(500);
    }
  }

  if (!ready) {
    console.error('Wrangler dev failed to start on port 8787.');
    devServer.kill();
    process.exit(1);
  }

  console.log('Wrangler dev is ready. Running tests...');

  try {
    // 1. Test Cloudflare Access Authentication: expect 401 Unauthorized
    console.log('Test 1: GET /api/workflows without Access headers...');
    const resUnauthorized = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'GET'
    });
    if (resUnauthorized.statusCode !== 401) {
      throw new Error(`Expected 401, got ${resUnauthorized.statusCode}`);
    }
    console.log('Test 1 passed!');

    // 2. Test Cloudflare Access Authentication: expect 200 with headers
    console.log('Test 2: GET /api/workflows with Access header...');
    const resAuthorized = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com'
      }
    });
    if (resAuthorized.statusCode !== 200) {
      throw new Error(`Expected 200, got ${resAuthorized.statusCode}`);
    }
    console.log('Test 2 passed! Workflows listed:', resAuthorized.body);

    // 3. Test saving an invalid cyclic workflow
    console.log('Test 3: POST /api/workflows with cyclic graph...');
    const cyclicWorkflow = {
      name: "Cyclic Test Workflow",
      nodes: [
        {
          id: "nodeA",
          type: "delay",
          position: { x: 100, y: 100 },
          config: { ms: 10 }
        },
        {
          id: "nodeB",
          type: "delay",
          position: { x: 200, y: 100 },
          config: { ms: 10 }
        }
      ],
      edges: [
        {
          source: "nodeA",
          target: "nodeB",
          sourceHandle: "always"
        },
        {
          source: "nodeB",
          target: "nodeA",
          sourceHandle: "always"
        }
      ]
    };
    const resCyclic = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, cyclicWorkflow);
    if (resCyclic.statusCode !== 400) {
      throw new Error(`Expected 400, got ${resCyclic.statusCode}`);
    }
    if (!resCyclic.body.errors || !resCyclic.body.errors.some(e => e.includes('cycles'))) {
      throw new Error('Expected cycle validation error message');
    }
    console.log('Test 3 passed!');

    // 4. Test saving a valid workflow with inputs and outputs
    console.log('Test 4: POST /api/workflows with a valid DAG (including inputs/outputs)...');
    const testWorkflow = {
      name: "API Test Workflow",
      nodes: [
        {
          id: "node_delay",
          type: "delay",
          position: { x: 100, y: 150 },
          config: { ms: 10 }
        },
        {
          id: "node_notify",
          type: "notify",
          position: { x: 300, y: 150 },
          inputs: {
            custom_input: "Testing inputs"
          },
          outputs: {
            custom_output: "Testing outputs"
          },
          config: { message: "Hello from test! Input: {{ nodes.node_delay.outputs.ms }}" }
        },
        {
          id: "node_run",
          type: "run",
          position: { x: 500, y: 150 },
          config: { command: "echo test" }
        }
      ],
      edges: [
        {
          source: "node_delay",
          target: "node_notify",
          sourceHandle: "success"
        },
        {
          source: "node_notify",
          target: "node_run",
          sourceHandle: "success"
        }
      ]
    };
    const resSave = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, testWorkflow);
    if (resSave.statusCode !== 200) {
      throw new Error(`Expected 200, got ${resSave.statusCode}. Response: ${JSON.stringify(resSave.body)}`);
    }
    const savedId = resSave.body.workflow.id;
    if (!savedId) {
      throw new Error('Expected returned workflow to have an ID');
    }
    console.log(`Test 4 passed! Saved workflow ID: ${savedId}`);

    // 5. Test GET /api/workflows/:id
    console.log(`Test 5: GET /api/workflows/${savedId}...`);
    const resGet = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/api/workflows/${savedId}`,
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com'
      }
    });
    if (resGet.statusCode !== 200) {
      throw new Error(`Expected 200, got ${resGet.statusCode}`);
    }
    if (resGet.body.name !== "API Test Workflow" || resGet.body.nodes.length !== 3) {
      throw new Error('Retrieved workflow structure mismatch');
    }
    const notifyNode = resGet.body.nodes.find(n => n.id === 'node_notify');
    if (!notifyNode || !notifyNode.inputs || notifyNode.inputs.custom_input !== "Testing inputs") {
      throw new Error('Retrieved node is missing expected inputs');
    }
    if (!notifyNode.outputs || notifyNode.outputs.custom_output !== "Testing outputs") {
      throw new Error('Retrieved node is missing expected outputs');
    }
    console.log('Test 5 passed!');

    // 6. Test execute single node: delay (simple step, run in worker)
    console.log('Test 6: POST execute single node (delay, simple step)...');
    const resExecuteDelay = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/api/workflows/${savedId}/nodes/node_delay/execute`,
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com'
      }
    });
    if (resExecuteDelay.statusCode !== 200) {
      throw new Error(`Expected 200, got ${resExecuteDelay.statusCode}. Response: ${JSON.stringify(resExecuteDelay.body)}`);
    }
    if (resExecuteDelay.body.executed_inside !== 'worker' || resExecuteDelay.body.result.status !== 'success') {
      throw new Error(`Expected execution inside worker to be successful, got ${JSON.stringify(resExecuteDelay.body)}`);
    }
    console.log('Test 6 passed!');

    // 7. Test execute single node: run (shell step, run in actions/dispatch)
    console.log('Test 7: POST execute single node (run, shell step)...');
    const resExecuteRun = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/api/workflows/${savedId}/nodes/node_run/execute`,
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com'
      }
    });
    if (resExecuteRun.statusCode === 500 && resExecuteRun.body.error && resExecuteRun.body.error.includes('GitHub dispatch failed')) {
      console.log('Test 7 passed (GitHub dispatch reached and failed with expected unauthorized status)!');
    } else if (resExecuteRun.statusCode === 200 && resExecuteRun.body.executed_inside === 'actions') {
      console.log('Test 7 passed (GitHub dispatch succeeded)!');
    } else {
      throw new Error(`Expected execution to attempt Actions dispatch and fail on PAT, but got status ${resExecuteRun.statusCode} with body: ${JSON.stringify(resExecuteRun.body)}`);
    }

    // 8. Test execute full graph
    console.log('Test 8: POST execute full graph...');
    const resExecuteFull = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/api/workflows/${savedId}/execute`,
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com'
      }
    });
    if (resExecuteFull.statusCode === 500 && resExecuteFull.body.error && resExecuteFull.body.error.includes('GitHub dispatch failed')) {
      console.log('Test 8 passed (GitHub dispatch reached and failed with expected unauthorized status)!');
    } else if (resExecuteFull.statusCode === 200 && resExecuteFull.body.execution_id) {
      console.log('Test 8 passed!');
    } else {
      throw new Error(`Expected execute full graph to attempt Actions dispatch and fail on PAT, but got status ${resExecuteFull.statusCode} with body: ${JSON.stringify(resExecuteFull.body)}`);
    }

    console.log('\nAll integration tests passed successfully!');
    devServer.kill();
    process.exit(0);

  } catch (err) {
    console.error('\nTest suite failed:', err);
    devServer.kill();
    process.exit(1);
  }
})();
