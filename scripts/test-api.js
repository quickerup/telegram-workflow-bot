const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (e) {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
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
  console.log('Creating worker/.dev.vars for test environment...');
  fs.writeFileSync('worker/.dev.vars', 'TELEGRAM_BOT_TOKEN=123456:fake-token\nTELEGRAM_WEBHOOK_SECRET=secret\nGITHUB_PAT=github_pat_fake\nALLOWED_CHAT_IDS=12345\n');

  function cleanup() {
    try {
      if (fs.existsSync('worker/.dev.vars')) {
        fs.unlinkSync('worker/.dev.vars');
      }
    } catch (e) {}
  }

  console.log('Initializing local test D1 database schema...');
  try {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'telegram-workflow-bot-db', '--local', '--file=./schema.sql'],
      { cwd: 'worker', stdio: 'inherit' }
    );
  } catch (e) {
    console.error('Failed to apply local D1 schema:', e.message);
    process.exit(1);
  }

  console.log('Writing temporary worker/.dev.vars...');
  fs.writeFileSync('worker/.dev.vars', `
TELEGRAM_BOT_TOKEN=123456:fake-token
TELEGRAM_WEBHOOK_SECRET=secret
GITHUB_PAT=github_pat_fake
ALLOWED_CHAT_IDS=12345
  `.trim());

  console.log('Starting wrangler dev server...');
  const killDevServer = () => {
    try { process.kill(-devServer.pid, 'SIGKILL'); } catch (e) { try { devServer.kill('SIGKILL'); } catch (e2) {} }
  };

  const devServer = spawn('npx', ['wrangler', 'dev', '--port', '8787'], {
    detached: true,
    cwd: 'worker',
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: '123456:fake-token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      GITHUB_PAT: 'github_pat_fake',
      ALLOWED_CHAT_IDS: '12345',
    }
  });

  // Log output for debugging
  devServer.stdout.on('data', (data) => {
    console.log(`[wrangler] ${data}`);
  });
  devServer.stderr.on('data', (data) => {
    console.error(`[wrangler err] ${data}`);
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
    killDevServer();
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

    // 9. Test Webhook trigger: POST workflow with webhook_trigger containing a secret, then trigger via webhook with correct header
    console.log('Test 9: Webhook trigger test with configured secret...');
    const webhookWorkflow = {
      name: "Webhook Test Workflow",
      nodes: [
        {
          id: "node_webhook",
          type: "webhook_trigger",
          position: { x: 100, y: 150 },
          config: {
            secret: "my-webhook-secret"
          }
        },
        {
          id: "node_notify",
          type: "notify",
          position: { x: 300, y: 150 },
          config: { message: "Webhook triggered successfully!" }
        }
      ],
      edges: [
        {
          source: "node_webhook",
          target: "node_notify",
          sourceHandle: "success"
        }
      ]
    };

    // Save webhook workflow
    const resSaveWebhook = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, webhookWorkflow);

    if (resSaveWebhook.statusCode !== 200) {
      throw new Error(`Expected 200 saving webhook workflow, got ${resSaveWebhook.statusCode}`);
    }
    const webhookWfId = resSaveWebhook.body.workflow.id;
    console.log(`Saved webhook workflow with ID: ${webhookWfId}`);

    // POST to /webhooks/:id with valid X-Workflow-Secret
    const resTriggerWebhook = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/webhooks/${webhookWfId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workflow-Secret': 'my-webhook-secret'
      }
    }, { test: "payload", chat_id: 99999 }); // Supplying a chat_id to test trust removal

    if (resTriggerWebhook.statusCode === 500 && resTriggerWebhook.body.error && resTriggerWebhook.body.error.includes('GitHub dispatch failed')) {
      console.log('Test 9 passed (attempted GitHub dispatch as expected)!');
    } else if (resTriggerWebhook.statusCode === 200 && resTriggerWebhook.body.ok) {
      console.log('Test 9 passed (webhook dispatch succeeded)!');
    } else {
      throw new Error(`Expected webhook trigger to attempt Actions dispatch, but got status ${resTriggerWebhook.statusCode} with body: ${JSON.stringify(resTriggerWebhook.body)}`);
    }

    // 9a. Test Webhook trigger: request with invalid secret is rejected (401)
    console.log('Test 9a: Webhook trigger with invalid secret...');
    const resTriggerWebhookInvalid = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/webhooks/${webhookWfId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workflow-Secret': 'wrong-secret'
      }
    }, { test: "payload" });

    if (resTriggerWebhookInvalid.statusCode !== 401) {
      throw new Error(`Expected 401 for invalid secret, got ${resTriggerWebhookInvalid.statusCode}`);
    }
    console.log('Test 9a passed!');

    // 9b. Test Webhook trigger: request with missing secret is rejected (401)
    console.log('Test 9b: Webhook trigger with missing secret header...');
    const resTriggerWebhookMissing = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/webhooks/${webhookWfId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, { test: "payload" });

    if (resTriggerWebhookMissing.statusCode !== 401) {
      throw new Error(`Expected 401 for missing secret, got ${resTriggerWebhookMissing.statusCode}`);
    }
    console.log('Test 9b passed!');

    // 9c. Test Webhook trigger: workflow with no configured secret is rejected entirely (403)
    console.log('Test 9c: Webhook trigger with no secret configured on node...');
    const noSecretWorkflow = {
      name: "No Secret Webhook Workflow",
      nodes: [
        {
          id: "node_webhook",
          type: "webhook_trigger",
          position: { x: 100, y: 150 },
          config: {} // No secret config
        }
      ],
      edges: []
    };

    const resSaveNoSecret = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, noSecretWorkflow);

    const noSecretWfId = resSaveNoSecret.body.workflow.id;

    const resTriggerNoSecret = await request({
      hostname: 'localhost',
      port: 8787,
      path: `/webhooks/${noSecretWfId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workflow-Secret': 'some-secret'
      }
    });

    if (resTriggerNoSecret.statusCode !== 403) {
      throw new Error(`Expected 403 for unconfigured secret on node, got ${resTriggerNoSecret.statusCode}`);
    }
    console.log('Test 9c passed!');

    // 9d. Test Webhook trigger: Rate limiting blocks high frequency spam (429)
    console.log('Test 9d: Webhook trigger rate limiting...');
    // We already fired 1 valid request for `webhookWfId` in Test 9. Let's fire 5 more to exceed the 5 reqs/60s limit.
    let hitRateLimit = false;
    for (let i = 0; i < 6; i++) {
      const resSpam = await request({
        hostname: 'localhost',
        port: 8787,
        path: `/webhooks/${webhookWfId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workflow-Secret': 'my-webhook-secret'
        }
      }, { test: "payload" });

      if (resSpam.statusCode === 429) {
        hitRateLimit = true;
        break;
      }
    }

    if (!hitRateLimit) {
      throw new Error('Expected to hit 429 Too Many Requests during rate limiting test, but did not');
    }
    console.log('Test 9d passed!');

    // 10. Test Telegram Event trigger: POST workflow with telegram_event_trigger (edited_message), then POST Telegram update to /
    console.log('Test 10: Telegram event trigger test...');
    const telegramEventWorkflow = {
      name: "Telegram Event Test Workflow",
      nodes: [
        {
          id: "node_tg_trigger",
          type: "telegram_event_trigger",
          position: { x: 100, y: 150 },
          config: {
            event_type: "edited_message"
          }
        },
        {
          id: "node_notify",
          type: "notify",
          position: { x: 300, y: 150 },
          config: { message: "Telegram event triggered!" }
        }
      ],
      edges: [
        {
          source: "node_tg_trigger",
          target: "node_notify",
          sourceHandle: "success"
        }
      ]
    };

    // Save Telegram event workflow
    const resSaveTg = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, telegramEventWorkflow);

    if (resSaveTg.statusCode !== 200) {
      throw new Error(`Expected 200 saving Telegram event workflow, got ${resSaveTg.statusCode}`);
    }
    const tgWfId = resSaveTg.body.workflow.id;
    console.log(`Saved telegram_event workflow with ID: ${tgWfId}`);

    // POST Telegram update (edited_message) to main bot webhook /
    const resTriggerTg = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret'
      }
    }, {
      update_id: 99991,
      edited_message: {
        message_id: 123,
        chat: { id: 12345 },
        text: "edited text"
      }
    });

    if (resTriggerTg.statusCode !== 200) {
      throw new Error(`Expected 200 from Telegram webhook, got ${resTriggerTg.statusCode}`);
    }
    console.log('Test 10 passed (Telegram webhook responded 200 OK)!');

    // 11. Test Scheduled/Cron trigger: POST workflow with cron_trigger (* * * * *), then invoke scheduled endpoint
    console.log('Test 11: Cron/scheduled trigger test...');
    const cronWorkflow = {
      name: "Cron Test Workflow",
      nodes: [
        {
          id: "node_cron",
          type: "cron_trigger",
          position: { x: 100, y: 150 },
          config: {
            cron: "* * * * *"
          }
        },
        {
          id: "node_notify",
          type: "notify",
          position: { x: 300, y: 150 },
          config: { message: "Cron triggered!" }
        }
      ],
      edges: [
        {
          source: "node_cron",
          target: "node_notify",
          sourceHandle: "success"
        }
      ]
    };

    // Save cron workflow
    const resSaveCron = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/api/workflows',
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'user@example.com',
        'Content-Type': 'application/json'
      }
    }, cronWorkflow);

    if (resSaveCron.statusCode !== 200) {
      throw new Error(`Expected 200 saving cron workflow, got ${resSaveCron.statusCode}`);
    }
    const cronWfId = resSaveCron.body.workflow.id;
    console.log(`Saved cron workflow with ID: ${cronWfId}`);

    // Trigger scheduled endpoint: GET /__scheduled
    const resTriggerCron = await request({
      hostname: 'localhost',
      port: 8787,
      path: '/__scheduled',
      method: 'GET'
    });

    if (resTriggerCron.statusCode !== 200 && resTriggerCron.statusCode !== 202) {
      throw new Error(`Expected 200/202 from __scheduled, got ${resTriggerCron.statusCode}`);
    }
    console.log('Test 11 passed (__scheduled responded successfully)!');

    console.log('\nAll integration tests passed successfully!');
    try { fs.unlinkSync('worker/.dev.vars'); } catch (e) {}
    killDevServer();
    process.exit(0);

  } catch (err) {
    console.error('\nTest suite failed:', err);
    try { fs.unlinkSync('worker/.dev.vars'); } catch (e) {}
    killDevServer();
    process.exit(1);
  }
})();
