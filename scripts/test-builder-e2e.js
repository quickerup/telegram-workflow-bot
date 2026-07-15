const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// HTTP request with timeout to prevent hanging tests
async function request(options, body = null, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = http.request(options, (res) => {
      clearTimeout(timer);
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

(async () => {
  console.log('Writing temporary worker/.dev.vars...');
  fs.writeFileSync('worker/.dev.vars', `
TELEGRAM_BOT_TOKEN=123456:fake-token
TELEGRAM_WEBHOOK_SECRET=secret
GITHUB_PAT=github_pat_fake
ALLOWED_CHAT_IDS=12345
  `.trim());

  console.log('Initializing local test D1 database schema...');
  try {
    require('child_process').execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'telegram-workflow-bot-db', '--local', '--file=./schema.sql'],
      { cwd: 'worker', stdio: 'inherit' }
    );
  } catch (e) {
    console.error('Failed to apply local D1 schema:', e.message);
    process.exit(1);
  }

  console.log('Starting wrangler dev server for builder test on port 8790...');
  const devServer = spawn('npx', ['wrangler', 'dev', '--port', '8790'], {
    cwd: 'worker',
    detached: true
  });

  const killDevServer = () => {
    try { process.kill(-devServer.pid, 'SIGKILL'); } catch (e) { try { devServer.kill('SIGKILL'); } catch (e2) {} }
  };

  // Wait for wrangler dev to be ready with a timeout
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error('Readiness probe timed out'));
        }, 2000);

        const req = http.get('http://localhost:8790/', (res) => {
          clearTimeout(timer);
          ready = true;
          resolve();
        });

        req.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      break;
    } catch (e) {
      await wait(500);
    }
  }

  if (!ready) {
    console.error('Wrangler dev failed to start on port 8790.');
    killDevServer();
    process.exit(1);
  }

  console.log('Wrangler dev is ready. Running interactive builder webhook tests...');

  const webhookOptions = {
    hostname: 'localhost',
    port: 8790,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret'
    }
  };

  const apiOptions = {
    hostname: 'localhost',
    port: 8790,
    headers: {
      'Cf-Access-Authenticated-User-Email': 'test-user@example.com'
    }
  };

  try {
    const baseId = Date.now();
    // 1. Send /newworkflow command with no name
    console.log('\n--- Test 1: Start building new workflow (no name) ---');
    let res = await request(webhookOptions, {
      update_id: baseId + 1,
      message: {
        chat: { id: 12345 },
        text: '/newworkflow'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 1 passed: ${res.body}`);

    // 2. Supply workflow name
    console.log('\n--- Test 2: Supply workflow name "Conversational Workflow" ---');
    res = await request(webhookOptions, {
      update_id: baseId + 2,
      message: {
        chat: { id: 12345 },
        text: 'Conversational Workflow'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 2 passed: ${res.body}`);

    // 3. Select node type: delay
    console.log('\n--- Test 3: Callback selection node type: delay ---');
    res = await request(webhookOptions, {
      update_id: baseId + 3,
      callback_query: {
        id: 'cb_1',
        message: { chat: { id: 12345 } },
        data: 'type:delay'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 3 passed: ${res.body}`);

    // 4. Enter delay milliseconds
    console.log('\n--- Test 4: Enter delay configuration (5000 ms) ---');
    res = await request(webhookOptions, {
      update_id: baseId + 4,
      message: {
        chat: { id: 12345 },
        text: '5000'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 4 passed: ${res.body}`);

    // 5. Select "Add Next Node" option
    console.log('\n--- Test 5: Callback selection: builder:add_node ---');
    res = await request(webhookOptions, {
      update_id: baseId + 5,
      callback_query: {
        id: 'cb_2',
        message: { chat: { id: 12345 } },
        data: 'builder:add_node'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 5 passed: ${res.body}`);

    // 6. Select node type: notify
    console.log('\n--- Test 6: Callback selection node type: notify ---');
    res = await request(webhookOptions, {
      update_id: baseId + 6,
      callback_query: {
        id: 'cb_3',
        message: { chat: { id: 12345 } },
        data: 'type:notify'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 6 passed: ${res.body}`);

    // 7. Enter notification message
    console.log('\n--- Test 7: Enter notify configuration ("Flow Done!") ---');
    res = await request(webhookOptions, {
      update_id: baseId + 7,
      message: {
        chat: { id: 12345 },
        text: 'Flow Done!'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 7 passed: ${res.body}`);

    // 8. Select "Save & Finish" option
    console.log('\n--- Test 8: Callback selection: builder:finish ---');
    res = await request(webhookOptions, {
      update_id: baseId + 8,
      callback_query: {
        id: 'cb_4',
        message: { chat: { id: 12345 } },
        data: 'builder:finish'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 8 passed: ${res.body}`);

    // 9. Fetch the staged workflow side effects from the Cloudflare Worker KV
    console.log('\n--- Test 9: Fetch and Assert the Staged Workflow from KV ---');
    res = await request({
      ...apiOptions,
      path: '/api/test-get-pending/12345',
      method: 'GET'
    });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to fetch pending workflow: ${res.statusCode} - ${res.body}`);
    }

    const pendingData = JSON.parse(res.body);
    console.log('Staged workflow fetched successfully:', JSON.stringify(pendingData, null, 2));

    // Assert side-effects: structural correctness of nodes, config, positioning, edges
    const workflow = pendingData.workflow;
    const token = pendingData.token;

    if (!token) {
      throw new Error('Expected staged workflow to contain a confirmation token.');
    }
    if (workflow.name !== 'Conversational Workflow') {
      throw new Error(`Unexpected workflow name: ${workflow.name}`);
    }
    if (workflow.nodes.length !== 2) {
      throw new Error(`Expected 2 nodes, found ${workflow.nodes.length}`);
    }

    const node1 = workflow.nodes[0];
    const node2 = workflow.nodes[1];

    if (node1.type !== 'delay' || node1.config.ms !== 5000) {
      throw new Error(`Node 1 (delay) assertion failed: ${JSON.stringify(node1)}`);
    }
    if (node2.type !== 'notify' || node2.config.message !== 'Flow Done!') {
      throw new Error(`Node 2 (notify) assertion failed: ${JSON.stringify(node2)}`);
    }

    // Visual auto-position check
    if (node1.position.x !== 100 || node1.position.y !== 100) {
      throw new Error(`Node 1 position is incorrect: ${JSON.stringify(node1.position)}`);
    }
    if (node2.position.x !== 100 || node2.position.y !== 250) {
      throw new Error(`Node 2 position is incorrect: ${JSON.stringify(node2.position)}`);
    }

    // Edge check
    if (workflow.edges.length !== 1) {
      throw new Error(`Expected exactly 1 edge, found ${workflow.edges.length}`);
    }
    const edge = workflow.edges[0];
    if (edge.source !== 'node_1' || edge.target !== 'node_2' || edge.sourceHandle !== 'success') {
      throw new Error(`Edge linkage assertion failed: ${JSON.stringify(edge)}`);
    }

    console.log('Test 9 passed: Staged workflow structure is perfectly correct!');

    // 10. Send /confirm <token>
    console.log(`\n--- Test 10: Send /confirm ${token} to save and dispatch ---`);
    res = await request(webhookOptions, {
      update_id: baseId + 9,
      message: {
        chat: { id: 12345 },
        text: `/confirm ${token}`
      }
    });
    if (res.statusCode !== 200) {
      if (res.statusCode === 500 && res.body.includes("GitHub dispatch failed (401)")) {
        console.log("Test 10 passed (GitHub dispatch reached and failed with expected unauthorized status).");
      } else {
        throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
      }
    } else {
      console.log(`Test 10 passed: /confirm handled successfully.`);
    }

    // 11. Assert that the workflow is now fully saved/persisted in D1
    console.log('\n--- Test 11: Assert workflow is saved in D1 Database ---');
    res = await request({
      ...apiOptions,
      path: '/api/workflows/Conversational_Workflow',
      method: 'GET'
    });
    if (res.statusCode !== 200) {
      throw new Error(`Workflow was not found in D1: ${res.statusCode} - ${res.body}`);
    }
    const dbWorkflow = JSON.parse(res.body);
    console.log('Persisted workflow in D1:', JSON.stringify(dbWorkflow, null, 2));

    if (dbWorkflow.name !== 'Conversational Workflow' || dbWorkflow.nodes.length !== 2 || dbWorkflow.edges.length !== 1) {
      throw new Error('Persisted workflow properties do not match assertion specs!');
    }
    console.log('Test 11 passed: Conversational Workflow successfully validated and persisted in database!');

    // 12. Test list workflows via /workflows
    console.log('\n--- Test 12: List workflows via /workflows command ---');
    res = await request(webhookOptions, {
      update_id: baseId + 11,
      message: {
        chat: { id: 12345 },
        text: '/workflows'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 12 passed.`);

    // 13. Test select workflow to start browsing
    console.log('\n--- Test 13: Callback select workflow to browse ---');
    res = await request(webhookOptions, {
      update_id: baseId + 12,
      callback_query: {
        id: 'cb_sel_wf',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_sel:Conversational_Workflow'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 13 passed.`);

    // 14. Test navigate next in pager
    console.log('\n--- Test 14: Callback navigate next in pager ---');
    res = await request(webhookOptions, {
      update_id: baseId + 13,
      callback_query: {
        id: 'cb_nav_next',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_nav:next'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 14 passed.`);

    // 15. Test navigate prev in pager
    console.log('\n--- Test 15: Callback navigate prev in pager ---');
    res = await request(webhookOptions, {
      update_id: baseId + 14,
      callback_query: {
        id: 'cb_nav_prev',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_nav:prev'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 15 passed.`);

    // 16. Test edit node config trigger
    console.log('\n--- Test 16: Callback trigger edit node config ---');
    res = await request(webhookOptions, {
      update_id: baseId + 15,
      callback_query: {
        id: 'cb_nav_edit',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_nav:edit'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 16 passed.`);

    // 17. Submit new configuration value for delay node (ms = 3000)
    console.log('\n--- Test 17: Submit new configuration value for delay node ---');
    res = await request(webhookOptions, {
      update_id: baseId + 16,
      message: {
        chat: { id: 12345 },
        text: '3000'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 17 passed.`);

    // 18. Test Run from here trigger
    console.log('\n--- Test 18: Callback trigger Run from here ---');
    res = await request(webhookOptions, {
      update_id: baseId + 17,
      callback_query: {
        id: 'cb_nav_run',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_nav:run'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 18 passed.`);

    // 19. Fetch and verify the newly staged start_node_id workflow
    console.log('\n--- Test 19: Fetch and assert staged starting-node workflow from KV ---');
    res = await request({
      ...apiOptions,
      path: '/api/test-get-pending/12345',
      method: 'GET'
    });
    if (res.statusCode !== 200) {
      throw new Error(`Failed to fetch pending starting-node workflow: ${res.statusCode} - ${res.body}`);
    }
    const browsePending = JSON.parse(res.body);
    if (browsePending.start_node_id !== 'node_1') {
      throw new Error(`Expected start_node_id to be node_1, found: ${browsePending.start_node_id}`);
    }
    const browseToken = browsePending.token;
    console.log(`Test 19 passed. Token: ${browseToken}`);

    // 20. Confirm the browsed start_node_id execution
    console.log(`\n--- Test 20: Send /confirm ${browseToken} for starting-node execution ---`);
    res = await request(webhookOptions, {
      update_id: baseId + 18,
      message: {
        chat: { id: 12345 },
        text: `/confirm ${browseToken}`
      }
    });
    if (res.statusCode !== 200) {
      if (res.statusCode === 500 && res.body.includes("GitHub dispatch failed (401)")) {
        console.log("Test 20 passed (GitHub dispatch reached and failed with expected unauthorized status).");
      } else {
        throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
      }
    } else {
      console.log(`Test 20 passed: /confirm start_node_id execution completed.`);
    }

    // 21. Delete first node
    console.log('\n--- Test 21: Callback delete selected node ---');
    res = await request(webhookOptions, {
      update_id: baseId + 19,
      callback_query: {
        id: 'cb_nav_delete',
        message: { chat: { id: 12345 }, message_id: 9999 },
        data: 'wf_nav:delete'
      }
    });
    if (res.statusCode !== 200) {
      throw new Error(`Expected 200, got ${res.statusCode} with body: ${res.body}`);
    }
    console.log(`Test 21 passed.`);

    // 22. Verify node deletion and edge cleanup
    console.log('\n--- Test 22: Assert workflow nodes updated in D1 ---');
    res = await request({
      ...apiOptions,
      path: '/api/workflows/Conversational_Workflow',
      method: 'GET'
    });
    if (res.statusCode !== 200) {
      throw new Error(`Workflow was not found in D1: ${res.statusCode} - ${res.body}`);
    }
    const dbWorkflowDeleted = JSON.parse(res.body);
    if (dbWorkflowDeleted.nodes.length !== 1) {
      throw new Error(`Expected 1 node remaining, found: ${dbWorkflowDeleted.nodes.length}`);
    }
    if (dbWorkflowDeleted.edges.length !== 0) {
      throw new Error(`Expected 0 edges remaining, found: ${dbWorkflowDeleted.edges.length}`);
    }
    console.log(`Test 22 passed: Deletion and cascade edge cleanup confirmed in database.`);

    console.log('\nAll advanced conversational builder tests passed successfully!');
    try { fs.unlinkSync('worker/.dev.vars'); } catch (e) {}
    killDevServer();
    process.exit(0);
  } catch (err) {
    console.error('\nInteractive builder test suite failed:', err);
    try { fs.unlinkSync('worker/.dev.vars'); } catch (e) {}
    killDevServer();
    process.exit(1);
  }
})();