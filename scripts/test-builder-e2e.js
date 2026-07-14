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
          body: data
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
  console.log('Starting wrangler dev server for builder test on port 8790...');
  const devServer = spawn('npx', ['wrangler', 'dev', '--port', '8790'], {
    cwd: 'worker'
  });

  // Wait for wrangler dev to be ready
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get('http://localhost:8790/', (res) => {
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
    console.error('Wrangler dev failed to start on port 8790.');
    devServer.kill();
    process.exit(1);
  }

  console.log('Wrangler dev is ready. Running interactive builder webhook tests...');

  const reqOptions = {
    hostname: 'localhost',
    port: 8790,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'secret'
    }
  };

  try {
    // 1. Send /newworkflow command with no name
    console.log('\n--- Test 1: Start building new workflow (no name) ---');
    let res = await request(reqOptions, {
      update_id: 1001,
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
    res = await request(reqOptions, {
      update_id: 1002,
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
    res = await request(reqOptions, {
      update_id: 1003,
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
    res = await request(reqOptions, {
      update_id: 1004,
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
    res = await request(reqOptions, {
      update_id: 1005,
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
    res = await request(reqOptions, {
      update_id: 1006,
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
    res = await request(reqOptions, {
      update_id: 1007,
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
    res = await request(reqOptions, {
      update_id: 1008,
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

    console.log('\nAll interactive builder tests passed successfully!');
    devServer.kill();
    process.exit(0);
  } catch (err) {
    console.error('\nInteractive builder test suite failed:', err);
    devServer.kill();
    process.exit(1);
  }
})();
