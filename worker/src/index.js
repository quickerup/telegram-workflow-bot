const ALLOWED_STEP_TYPES = new Set([
  'run',
  'http',
  'delay',
  'notify',
  'webhook_trigger',
  'cron_trigger',
  'telegram_event_trigger'
]);
const MAX_NODES = 50;
const MAX_FILE_SIZE_BYTES = 200_000; // 200 KB — plenty for a workflow definition
const CONFIRM_TTL_SECONDS = 300; // pending workflows expire after 5 minutes
const DEDUPE_TTL_SECONDS = 3600; // remember update_ids for an hour

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook Trigger Endpoint: POST /webhooks/:workflowId
    if (request.method === 'POST' && url.pathname.startsWith('/webhooks/')) {
      const parts = url.pathname.split('/');
      if (parts.length === 3) {
        const id = parts[2];
        try {
          if (!env.DB) {
            throw new Error('Database is not configured');
          }

          const workflowRow = await env.DB.prepare(
            `SELECT id, name FROM workflows WHERE id = ?`
          ).bind(id).first();

          if (!workflowRow) {
            return new Response(JSON.stringify({ ok: false, error: 'Workflow not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const { results: nodesRows } = await env.DB.prepare(
            `SELECT id, type, config FROM nodes WHERE workflow_id = ?`
          ).bind(id).all();

          const webhookNodes = nodesRows.filter(row => row.type === 'webhook_trigger');
          if (webhookNodes.length === 0) {
            return new Response(JSON.stringify({ ok: false, error: 'This workflow does not have a webhook trigger' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const querySecret = url.searchParams.get('secret');
          const headerSecret = request.headers.get('X-Webhook-Secret');

          let validated = false;
          for (const nodeRow of webhookNodes) {
            const config = JSON.parse(nodeRow.config);
            if (!config.secret) {
              validated = true;
              break;
            }
            if (config.secret === querySecret || config.secret === headerSecret) {
              validated = true;
              break;
            }
          }

          if (!validated) {
            return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing webhook secret' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const { results: edgesRows } = await env.DB.prepare(
            `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
          ).bind(id).all();

          const nodes = nodesRows.map(row => ({
            id: row.id,
            type: row.type,
            position: { x: 0, y: 0 },
            config: JSON.parse(row.config)
          }));

          const edges = edgesRows.map(row => ({
            source: row.source,
            target: row.target,
            sourceHandle: row.source_handle || 'success'
          }));

          const workflowObj = {
            id: workflowRow.id,
            name: workflowRow.name,
            nodes,
            edges
          };

          let postBody = null;
          try {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
              postBody = await request.json();
            } else {
              postBody = await request.text();
            }
          } catch (e) {}

          const executionId = crypto.randomUUID();

          await env.DB.prepare(
            `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
          ).bind(
            executionId,
            id,
            new Date().toISOString()
          ).run();

          let chatId = null;
          const allowList = (env.ALLOWED_CHAT_IDS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (allowList.length > 0) {
            chatId = allowList[0];
          }

          const workerUrl = `${url.protocol}//${url.host}`;
          await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, {
            trigger_type: 'webhook',
            payload: postBody,
            headers: Object.fromEntries(request.headers.entries()),
            query: Object.fromEntries(url.searchParams.entries())
          });

          return new Response(JSON.stringify({ ok: true, execution_id: executionId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // Support execution feedback API: POST /executions/:id
    if (request.method === 'POST' && url.pathname.startsWith('/executions/')) {
      const execId = url.pathname.split('/').pop();
      try {
        const body = await request.json();
        const { status, started_at, finished_at, log } = body;

        if (env.DB) {
          await env.DB.prepare(
            `UPDATE executions
             SET status = ?, started_at = ?, finished_at = ?, log = ?
             WHERE id = ?`
          )
            .bind(
              status || 'success',
              started_at || null,
              finished_at || null,
              log ? JSON.stringify(log) : null,
              execId
            )
            .run();
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // --- Cloudflare Access Protection for Editor routes ---
    if (url.pathname.startsWith('/api/')) {
      const isDevBypass = env.DEV_BYPASS_ACCESS === 'true';
      if (!isDevBypass) {
        const jwtAssertion = request.headers.get('Cf-Access-Jwt-Assertion');
        const userEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
        if (!jwtAssertion && !userEmail) {
          return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Cloudflare Access authentication required.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // GET /api/workflows
    if (url.pathname === '/api/workflows' && request.method === 'GET') {
      try {
        if (!env.DB) {
          throw new Error('Database is not configured');
        }
        const { results } = await env.DB.prepare(
          `SELECT id, name, created_at FROM workflows ORDER BY created_at DESC`
        ).all();
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /api/workflows/:id
    if (url.pathname.startsWith('/api/workflows/') && request.method === 'GET') {
      const parts = url.pathname.split('/');
      if (parts.length === 4) {
        const id = parts[3];
        try {
          if (!env.DB) {
            throw new Error('Database is not configured');
          }
          const workflowRow = await env.DB.prepare(
            `SELECT id, name, created_at FROM workflows WHERE id = ?`
          ).bind(id).first();

          if (!workflowRow) {
            return new Response(JSON.stringify({ ok: false, error: 'Workflow not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const { results: nodesRows } = await env.DB.prepare(
            `SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ?`
          ).bind(id).all();

          const { results: edgesRows } = await env.DB.prepare(
            `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
          ).bind(id).all();

          const nodes = nodesRows.map(row => {
            const nodeObj = {
              id: row.id,
              type: row.type,
              position: { x: row.position_x, y: row.position_y },
              config: JSON.parse(row.config)
            };
            if (row.inputs !== null && row.inputs !== undefined) {
              nodeObj.inputs = JSON.parse(row.inputs);
            }
            if (row.outputs !== null && row.outputs !== undefined) {
              nodeObj.outputs = JSON.parse(row.outputs);
            }
            return nodeObj;
          });

          const edges = edgesRows.map(row => ({
            source: row.source,
            target: row.target,
            sourceHandle: row.source_handle || 'success'
          }));

          const workflowObj = {
            id: workflowRow.id,
            name: workflowRow.name,
            created_at: workflowRow.created_at,
            nodes,
            edges
          };

          return new Response(JSON.stringify(workflowObj), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // POST /api/workflows
    if (url.pathname === '/api/workflows' && request.method === 'POST') {
      try {
        if (!env.DB) {
          throw new Error('Database is not configured');
        }
        let workflow;
        try {
          workflow = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const errors = validateWorkflow(workflow);
        if (errors.length > 0) {
          return new Response(JSON.stringify({ ok: false, errors }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const workflowId = workflow.id || workflow.name.replace(/[^a-z0-9_-]/gi, '_');
        if (!/^[a-z0-9_-]+$/i.test(workflowId)) {
          return new Response(JSON.stringify({ ok: false, error: 'Invalid workflow ID generated/provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const statements = [
          env.DB.prepare(`INSERT OR REPLACE INTO workflows (id, name) VALUES (?, ?)`).bind(workflowId, workflow.name),
          env.DB.prepare(`DELETE FROM nodes WHERE workflow_id = ?`).bind(workflowId),
          env.DB.prepare(`DELETE FROM edges WHERE workflow_id = ?`).bind(workflowId)
        ];

        for (const node of workflow.nodes) {
          const posX = (node.position && typeof node.position.x === 'number') ? node.position.x : 0;
          const posY = (node.position && typeof node.position.y === 'number') ? node.position.y : 0;
          const inputsStr = node.inputs ? JSON.stringify(node.inputs) : null;
          const outputsStr = node.outputs ? JSON.stringify(node.outputs) : null;
          statements.push(
            env.DB.prepare(
              `INSERT INTO nodes (id, workflow_id, type, position_x, position_y, config, inputs, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(node.id, workflowId, node.type, posX, posY, JSON.stringify(node.config || {}), inputsStr, outputsStr)
          );
        }

        const edges = workflow.edges || [];
        for (const edge of edges) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO edges (workflow_id, source, target, source_handle) VALUES (?, ?, ?, ?)`
            ).bind(workflowId, edge.source, edge.target, edge.sourceHandle || 'success')
          );
        }

        await env.DB.batch(statements);

        return new Response(JSON.stringify({
          ok: true,
          workflow: {
            id: workflowId,
            name: workflow.name,
            nodes: workflow.nodes.map(n => {
              const resNode = {
                id: n.id,
                type: n.type,
                position: n.position || { x: 0, y: 0 },
                config: n.config || {}
              };
              if (n.inputs) resNode.inputs = n.inputs;
              if (n.outputs) resNode.outputs = n.outputs;
              return resNode;
            }),
            edges: edges.map(e => ({
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle || 'success'
            }))
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // POST /api/workflows/:id/execute
    if (url.pathname.startsWith('/api/workflows/') && url.pathname.endsWith('/execute') && request.method === 'POST') {
      const parts = url.pathname.split('/');
      if (parts.length === 5) {
        const id = parts[3];
        try {
          if (!env.DB) {
            throw new Error('Database is not configured');
          }

          const workflowRow = await env.DB.prepare(
            `SELECT id, name FROM workflows WHERE id = ?`
          ).bind(id).first();

          if (!workflowRow) {
            return new Response(JSON.stringify({ ok: false, error: 'Workflow not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const { results: nodesRows } = await env.DB.prepare(
            `SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ?`
          ).bind(id).all();

          const { results: edgesRows } = await env.DB.prepare(
            `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
          ).bind(id).all();

          const nodes = nodesRows.map(row => {
            const nodeObj = {
              id: row.id,
              type: row.type,
              position: { x: row.position_x, y: row.position_y },
              config: JSON.parse(row.config)
            };
            if (row.inputs !== null && row.inputs !== undefined) {
              nodeObj.inputs = JSON.parse(row.inputs);
            }
            if (row.outputs !== null && row.outputs !== undefined) {
              nodeObj.outputs = JSON.parse(row.outputs);
            }
            return nodeObj;
          });

          const edges = edgesRows.map(row => ({
            source: row.source,
            target: row.target,
            sourceHandle: row.source_handle || 'success'
          }));

          const workflowObj = {
            id: workflowRow.id,
            name: workflowRow.name,
            nodes,
            edges
          };

          const executionId = crypto.randomUUID();

          await env.DB.prepare(
            `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
          ).bind(
            executionId,
            id,
            new Date().toISOString()
          ).run();

          // Get chat ID from optional body or default to ALLOWED_CHAT_IDS
          let chatId = null;
          try {
            const body = await request.json().catch(() => ({}));
            chatId = body.chat_id || null;
          } catch (e) {}

          if (!chatId) {
            const allowList = (env.ALLOWED_CHAT_IDS || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (allowList.length > 0) {
              chatId = allowList[0];
            }
          }

          const workerUrl = `${url.protocol}//${url.host}`;
          await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl);

          return new Response(JSON.stringify({ ok: true, execution_id: executionId }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // POST /api/workflows/:id/nodes/:nodeId/execute
    if (url.pathname.startsWith('/api/workflows/') && url.pathname.includes('/nodes/') && url.pathname.endsWith('/execute') && request.method === 'POST') {
      const parts = url.pathname.split('/');
      if (parts.length === 7 && parts[4] === 'nodes' && parts[6] === 'execute') {
        const id = parts[3];
        const nodeId = parts[5];

        try {
          if (!env.DB) {
            throw new Error('Database is not configured');
          }

          const workflowRow = await env.DB.prepare(
            `SELECT id, name FROM workflows WHERE id = ?`
          ).bind(id).first();

          if (!workflowRow) {
            return new Response(JSON.stringify({ ok: false, error: 'Workflow not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const nodeRow = await env.DB.prepare(
            `SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ? AND id = ?`
          ).bind(id, nodeId).first();

          if (!nodeRow) {
            return new Response(JSON.stringify({ ok: false, error: 'Node not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const node = {
            id: nodeRow.id,
            type: nodeRow.type,
            position: { x: nodeRow.position_x, y: nodeRow.position_y },
            config: JSON.parse(nodeRow.config)
          };
          if (nodeRow.inputs !== null && nodeRow.inputs !== undefined) {
            node.inputs = JSON.parse(nodeRow.inputs);
          }
          if (nodeRow.outputs !== null && nodeRow.outputs !== undefined) {
            node.outputs = JSON.parse(nodeRow.outputs);
          }

          // Get chat ID from optional body or default to ALLOWED_CHAT_IDS
          let chatId = null;
          try {
            const body = await request.json().catch(() => ({}));
            chatId = body.chat_id || null;
          } catch (e) {}

          if (!chatId) {
            const allowList = (env.ALLOWED_CHAT_IDS || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (allowList.length > 0) {
              chatId = allowList[0];
            }
          }

          const isSimpleStep = ['http', 'delay', 'notify'].includes(node.type);

          if (isSimpleStep) {
            // Run inside the Worker immediately!
            const result = await executeSimpleNodeInWorker(env, node, chatId);
            return new Response(JSON.stringify({
              ok: true,
              executed_inside: 'worker',
              result
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } else if (node.type === 'run') {
            // Construct a temporary single-node workflow and dispatch to GitHub Actions!
            const tempWorkflow = {
              name: `Test Node ${nodeId}`,
              nodes: [node],
              edges: []
            };

            const executionId = crypto.randomUUID();

            await env.DB.prepare(
              `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
            ).bind(
              executionId,
              id,
              new Date().toISOString()
            ).run();

            const workerUrl = `${url.protocol}//${url.host}`;
            await dispatchWorkflow(env, tempWorkflow, chatId, executionId, workerUrl);

            return new Response(JSON.stringify({
              ok: true,
              executed_inside: 'actions',
              execution_id: executionId
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } else {
            return new Response(JSON.stringify({ ok: false, error: `Unsupported node type: ${node.type}` }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    // Telegram sends this header if you set a secret_token on the webhook.
    // Compared in constant time so a timing attack can't help an attacker
    // brute-force the secret.
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!timingSafeEqual(secretHeader, env.TELEGRAM_WEBHOOK_SECRET || '')) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('OK'); // malformed body — nothing to do, don't leak details
    }

    // Telegram retries webhook deliveries that don't get a fast 2xx. Without
    // this, a slow response (e.g. a hung GitHub API call) could cause the
    // *same* workflow confirmation or dispatch to fire twice.
    if (env.WORKFLOW_STATE && update.update_id != null) {
      const dedupeKey = `seen:${update.update_id}`;
      const alreadySeen = await env.WORKFLOW_STATE.get(dedupeKey);
      if (alreadySeen) return new Response('OK');
      await env.WORKFLOW_STATE.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
    }

    // Telegram Event Triggers: Check if this update matches any telegram_event_trigger workflow
    if (env.DB) {
      try {
        await handleTelegramEventTriggers(env, update, request.url);
      } catch (err) {
        console.error("Telegram event trigger error:", err);
      }
    }

    const message = update.message;
    if (!message) return new Response('OK');

    const chatId = message.chat.id;

    // --- Authorization: only allowlisted chat IDs may trigger workflows ---
    const allowList = (env.ALLOWED_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const isAllowed = allowList.length === 0 || allowList.includes(String(chatId));

    if (!isAllowed) {
      // Deliberately vague — don't reveal the allowlist or dispatch mechanics
      // to an unauthorized sender.
      await sendMessage(env, chatId, 'This bot is not configured for your account.');
      return new Response('OK');
    }

    try {
      if (message.document) {
        await handleDocument(message, env, chatId);
      } else if (message.text && message.text.startsWith('/confirm')) {
        await handleConfirm(env, chatId, message.text, request.url);
      } else if (message.text === '/cancel') {
        await handleCancel(env, chatId);
      } else if (message.text === '/whoami' || message.text === '/start') {
        await sendMessage(
          env, chatId,
          `Your Telegram chat ID is: ${chatId}\n` +
          `Add it to ALLOWED_CHAT_IDS in wrangler.toml if it isn't already, then redeploy.`
        );
      } else if (message.text) {
        await sendMessage(env, chatId,
          "Send me a workflow as a .json file attachment. I'll validate it and show you " +
          "a summary — nothing runs until you reply /confirm <token>. Send /whoami to see your chat ID.");
      }
    } catch (err) {
      await sendMessage(env, chatId, `Error: ${err.message}`);
    }

    return new Response('OK');
  },

  // Cron/Schedule Trigger Handler via Scheduled Events
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const now = new Date(event.scheduledTime || Date.now());
    ctx.waitUntil(handleScheduledTriggers(env, now));
  }
};

function validateWorkflow(workflow) {
  const errors = [];
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    errors.push('workflow.name must be a non-empty string');
  }

  if (!Array.isArray(workflow.nodes)) {
    errors.push('workflow.nodes must be an array');
    return errors;
  }
  if (workflow.nodes.length === 0) {
    errors.push('workflow.nodes must not be empty');
    return errors;
  }
  if (workflow.nodes.length > MAX_NODES) {
    errors.push(`too many nodes (max ${MAX_NODES})`);
  }

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

    if (!ALLOWED_STEP_TYPES.has(node.type)) {
      errors.push(`node ${i} (${node.id || 'unnamed'}): unknown type "${node.type}" (allowed: ${[...ALLOWED_STEP_TYPES].join(', ')})`);
    }

    if (!node.position || typeof node.position !== 'object') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): missing or invalid "position" object`);
    } else {
      if (typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
        errors.push(`node ${i} (${node.id || 'unnamed'}): position "x" and "y" must be numbers`);
      }
    }

    if (node.inputs !== undefined && (typeof node.inputs !== 'object' || node.inputs === null)) {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "inputs" must be an object`);
    }

    if (node.outputs !== undefined && (typeof node.outputs !== 'object' || node.outputs === null)) {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "outputs" must be an object`);
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
    if (node.type === 'webhook_trigger') {
      if (config.secret !== undefined && typeof config.secret !== 'string') {
        errors.push(`node ${i} (${node.id || 'unnamed'}): "webhook_trigger" config "secret" must be a string`);
      }
    }
    if (node.type === 'cron_trigger' && typeof config.cron !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "cron_trigger" config needs a string "cron"`);
    }
    if (node.type === 'telegram_event_trigger' && typeof config.event_type !== 'string') {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "telegram_event_trigger" config needs a string "event_type"`);
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

  return errors;
}

function summarizeWorkflow(workflow) {
  let summary = `Nodes:\n`;
  workflow.nodes.forEach((n, i) => {
    if (n.type === 'run') summary += `  - [${n.id}] run: ${n.config.command}\n`;
    else if (n.type === 'http') summary += `  - [${n.id}] http: ${n.config.method || 'GET'} ${n.config.url}\n`;
    else if (n.type === 'delay') summary += `  - [${n.id}] delay: ${n.config.ms}ms\n`;
    else if (n.type === 'notify') summary += `  - [${n.id}] notify: "${n.config.message}"\n`;
    else if (n.type === 'webhook_trigger') summary += `  - [${n.id}] webhook_trigger: ${n.config.secret ? '(has secret)' : '(no secret)'}\n`;
    else if (n.type === 'cron_trigger') summary += `  - [${n.id}] cron_trigger: "${n.config.cron}"\n`;
    else if (n.type === 'telegram_event_trigger') summary += `  - [${n.id}] telegram_event_trigger: "${n.config.event_type}"\n`;
  });
  if (workflow.edges && workflow.edges.length > 0) {
    summary += `Edges:\n`;
    workflow.edges.forEach((e) => {
      summary += `  - ${e.source} -> ${e.target} (${e.sourceHandle || 'success'})\n`;
    });
  }
  return summary;
}

async function handleDocument(message, env, chatId) {
  const doc = message.document;
  if (!doc.file_name || !doc.file_name.endsWith('.json')) {
    await sendMessage(env, chatId, 'Please send a .json file.');
    return;
  }
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE_BYTES) {
    await sendMessage(env, chatId, `File too large (max ${MAX_FILE_SIZE_BYTES / 1000}KB).`);
    return;
  }

  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${doc.file_id}`
  );
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) {
    await sendMessage(env, chatId, 'Could not fetch that file from Telegram.');
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
  const contentRes = await fetch(fileUrl);
  const rawText = await contentRes.text();

  let workflow;
  try {
    workflow = JSON.parse(rawText);
  } catch (e) {
    await sendMessage(env, chatId, `Invalid JSON: ${e.message}`);
    return;
  }

  const errors = validateWorkflow(workflow);
  if (errors.length) {
    await sendMessage(env, chatId, `Workflow rejected:\n- ${errors.join('\n- ')}`);
    return;
  }

  // Stage workflow and require explicit /confirm
  const token = crypto.randomUUID().slice(0, 8);
  const pendingKey = `pending:${chatId}`;
  await env.WORKFLOW_STATE.put(
    pendingKey,
    JSON.stringify({ workflow, token, created_at: Date.now() }),
    { expirationTtl: CONFIRM_TTL_SECONDS }
  );

  const summary = summarizeWorkflow(workflow);
  await sendMessage(
    env, chatId,
    `Received "${workflow.name}" (${workflow.nodes.length} node(s)):\n\n${summary}\n\n` +
    `Reply "/confirm ${token}" within ${CONFIRM_TTL_SECONDS / 60} minutes to run it, or /cancel to discard.`
  );
}

async function handleConfirm(env, chatId, text, requestUrl) {
  const token = text.trim().split(/\s+/)[1];
  const pendingKey = `pending:${chatId}`;
  const raw = await env.WORKFLOW_STATE.get(pendingKey);
  if (!raw) {
    await sendMessage(env, chatId, 'Nothing pending to confirm (it may have expired — send the file again).');
    return;
  }
  const pending = JSON.parse(raw);
  if (!token || !timingSafeEqual(token, pending.token)) {
    await sendMessage(env, chatId, 'That confirmation token did not match. Copy it exactly from my previous message.');
    return;
  }

  await env.WORKFLOW_STATE.delete(pendingKey);

  const workflow = pending.workflow;
  const workflowId = workflow.name.replace(/[^a-z0-9_-]/gi, '_');

  // Insert/Replace workflow, nodes, and edges in D1
  if (env.DB) {
    // We transactionally save or just execute sequentially since Cloudflare DB handles statements in order
    await env.DB.prepare(`INSERT OR REPLACE INTO workflows (id, name) VALUES (?, ?)`).bind(workflowId, workflow.name).run();

    // Clear old nodes and edges
    await env.DB.prepare(`DELETE FROM nodes WHERE workflow_id = ?`).bind(workflowId).run();
    await env.DB.prepare(`DELETE FROM edges WHERE workflow_id = ?`).bind(workflowId).run();

    // Insert new nodes
    const nodeStmts = workflow.nodes.map(node => {
      const inputsStr = node.inputs ? JSON.stringify(node.inputs) : null;
      const outputsStr = node.outputs ? JSON.stringify(node.outputs) : null;
      return env.DB.prepare(
        `INSERT INTO nodes (id, workflow_id, type, position_x, position_y, config, inputs, outputs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        node.id,
        workflowId,
        node.type,
        node.position.x,
        node.position.y,
        JSON.stringify(node.config),
        inputsStr,
        outputsStr
      );
    });

    // Insert new edges
    const edgeStmts = workflow.edges.map(edge => {
      return env.DB.prepare(
        `INSERT INTO edges (workflow_id, source, target, source_handle) VALUES (?, ?, ?, ?)`
      ).bind(
        workflowId,
        edge.source,
        edge.target,
        edge.sourceHandle || 'success'
      );
    });

    if (nodeStmts.length > 0) {
      await env.DB.batch(nodeStmts);
    }
    if (edgeStmts.length > 0) {
      await env.DB.batch(edgeStmts);
    }
  }

  const executionId = crypto.randomUUID();

  // Create execution record in D1
  if (env.DB) {
    await env.DB.prepare(
      `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
    ).bind(
      executionId,
      workflowId,
      new Date().toISOString()
    ).run();
  }

  // Get current worker domain / origin
  const parsedUrl = new URL(requestUrl);
  const workerUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  await dispatchWorkflow(env, workflow, chatId, executionId, workerUrl);
  await sendMessage(env, chatId, `Dispatched "${workflow.name}" to GitHub Actions — you'll get a message when it finishes.`);
}

async function handleCancel(env, chatId) {
  await env.WORKFLOW_STATE.delete(`pending:${chatId}`);
  await sendMessage(env, chatId, 'Discarded.');
}

async function dispatchWorkflow(env, workflow, chatId, executionId, workerUrl, triggerData = null) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'telegram-workflow-bot',
      },
      body: JSON.stringify({
        event_type: 'run-workflow',
        client_payload: {
          payload: workflow,
          chat_id: chatId,
          execution_id: executionId,
          worker_url: workerUrl,
          trigger_data: triggerData
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

async function sendMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Constant-time string compare — used for the webhook secret and the
// /confirm token so equality checks can't leak timing information.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function executeSimpleNodeInWorker(env, node, chatId) {
  const entry = { id: node.id, type: node.type, started_at: new Date().toISOString() };
  const step = node.config || {};

  try {
    if (node.type === 'http') {
      const timeoutMs = step.timeout_ms || 15000;
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
      entry.response = text.length > 4000 ? text.slice(0, 4000) + '…[truncated]' : text;
      entry.status = res.ok ? 'success' : 'failed';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (node.type === 'delay') {
      const ms = Math.min(step.ms || 0, 5 * 60_000); // cap at 5 minutes
      await new Promise((r) => setTimeout(r, ms));
      entry.status = 'success';
    } else if (node.type === 'notify') {
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw new Error("Telegram bot token is not configured");
      }
      if (!chatId) {
        throw new Error("Telegram chat ID is missing");
      }
      await sendMessage(env, chatId, step.message);
      entry.status = 'success';
    } else {
      throw new Error(`Unsupported simple node type: ${node.type}`);
    }
  } catch (err) {
    entry.status = step.continue_on_error ? 'failed_ignored' : 'failed';
    entry.error = err.message;
  }
  entry.finished_at = new Date().toISOString();
  return entry;
}

async function getWorkflowObj(env, id) {
  const workflowRow = await env.DB.prepare(
    `SELECT id, name, created_at FROM workflows WHERE id = ?`
  ).bind(id).first();

  if (!workflowRow) return null;

  const { results: nodesRows } = await env.DB.prepare(
    `SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ?`
  ).bind(id).all();

  const { results: edgesRows } = await env.DB.prepare(
    `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
  ).bind(id).all();

  const nodes = nodesRows.map(row => {
    const nodeObj = {
      id: row.id,
      type: row.type,
      position: { x: row.position_x, y: row.position_y },
      config: JSON.parse(row.config)
    };
    if (row.inputs !== null && row.inputs !== undefined) {
      nodeObj.inputs = JSON.parse(row.inputs);
    }
    if (row.outputs !== null && row.outputs !== undefined) {
      nodeObj.outputs = JSON.parse(row.outputs);
    }
    return nodeObj;
  });

  const edges = edgesRows.map(row => ({
    source: row.source,
    target: row.target,
    sourceHandle: row.source_handle || 'success'
  }));

  return {
    id: workflowRow.id,
    name: workflowRow.name,
    created_at: workflowRow.created_at,
    nodes,
    edges
  };
}

async function handleTelegramEventTriggers(env, update, requestUrl) {
  const allowList = (env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chatId = getChatIdFromUpdate(update);
  const isAllowed = allowList.length === 0 || (chatId && allowList.includes(String(chatId)));
  if (!isAllowed) return;

  const matchedEventTypes = getEventType(update);
  if (matchedEventTypes.length === 0) return;

  const { results: matchedNodes } = await env.DB.prepare(
    `SELECT DISTINCT workflow_id FROM nodes WHERE type = 'telegram_event_trigger'`
  ).all();

  for (const row of matchedNodes) {
    const workflowObj = await getWorkflowObj(env, row.workflow_id);
    if (!workflowObj) continue;

    const eventNodes = workflowObj.nodes.filter(n => n.type === 'telegram_event_trigger');
    let triggerData = null;
    for (const node of eventNodes) {
      if (node.config && matchedEventTypes.includes(node.config.event_type)) {
        triggerData = {
          trigger_type: 'telegram',
          event_type: node.config.event_type,
          payload: update
        };
        break;
      }
    }

    if (triggerData) {
      const executionId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
      ).bind(
        executionId,
        row.workflow_id,
        new Date().toISOString()
      ).run();

      const parsedUrl = new URL(requestUrl);
      const workerUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

      await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, triggerData);
    }
  }
}

function getEventType(update) {
  const types = [];
  for (const key of Object.keys(update)) {
    if (key !== 'update_id') {
      types.push(key);
    }
  }
  if (update.message) {
    for (const key of Object.keys(update.message)) {
      if (typeof update.message[key] !== 'undefined') {
        types.push(key);
      }
    }
  }
  return types;
}

function getChatIdFromUpdate(update) {
  if (update.message?.chat?.id) return update.message.chat.id;
  if (update.edited_message?.chat?.id) return update.edited_message.chat.id;
  if (update.channel_post?.chat?.id) return update.channel_post.chat.id;
  if (update.edited_channel_post?.chat?.id) return update.edited_channel_post.chat.id;
  if (update.callback_query?.message?.chat?.id) return update.callback_query.message.chat.id;
  if (update.my_chat_member?.chat?.id) return update.my_chat_member.chat.id;
  if (update.chat_member?.chat?.id) return update.chat_member.chat.id;
  if (update.chat_join_request?.chat?.id) return update.chat_join_request.chat.id;
  return null;
}

async function handleScheduledTriggers(env, now) {
  const { results: matchedNodes } = await env.DB.prepare(
    `SELECT DISTINCT workflow_id FROM nodes WHERE type = 'cron_trigger'`
  ).all();

  let chatId = null;
  const allowList = (env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.length > 0) {
    chatId = allowList[0];
  }

  for (const row of matchedNodes) {
    const workflowObj = await getWorkflowObj(env, row.workflow_id);
    if (!workflowObj) continue;

    const cronNodes = workflowObj.nodes.filter(n => n.type === 'cron_trigger');
    let triggerData = null;
    for (const node of cronNodes) {
      if (node.config && node.config.cron && cronMatches(node.config.cron, now)) {
        triggerData = {
          trigger_type: 'cron',
          cron: node.config.cron,
          payload: { scheduled_time: now.toISOString() }
        };
        break;
      }
    }

    if (triggerData) {
      const executionId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
      ).bind(
        executionId,
        row.workflow_id,
        new Date().toISOString()
      ).run();

      const workerUrl = env.WORKER_URL || `https://${env.WORKER_NAME || 'telegram-workflow-bot'}.workers.dev`;
      await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, triggerData);
    }
  }
}

function cronMatches(cronExpression, date) {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

  const minutes = date.getUTCMinutes();
  const hours = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-12
  const dow = date.getUTCDay(); // 0-6 (Sunday is 0)

  return (
    matchField(minStr, minutes, 0, 59) &&
    matchField(hourStr, hours, 0, 23) &&
    matchField(domStr, dom, 1, 31) &&
    matchField(monthStr, month, 1, 12) &&
    matchField(dowStr, dow, 0, 6)
  );
}

function matchField(pattern, val, min, max) {
  if (pattern === '*') return true;

  if (pattern.includes(',')) {
    return pattern.split(',').some(p => matchField(p, val, min, max));
  }

  let rangePattern = pattern;
  let step = 1;
  if (pattern.includes('/')) {
    const parts = pattern.split('/');
    rangePattern = parts[0] === '' || parts[0] === '*' ? `${min}-${max}` : parts[0];
    step = parseInt(parts[1], 10);
    if (isNaN(step)) return false;
  }

  let start = min;
  let end = max;
  if (rangePattern.includes('-')) {
    const parts = rangePattern.split('-');
    start = parseInt(parts[0], 10);
    end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end)) return false;
  } else {
    const single = parseInt(rangePattern, 10);
    if (!isNaN(single)) {
      if (step === 1) {
        return single === val;
      }
      start = single;
      end = max;
    }
  }

  if (val < start || val > end) return false;
  return (val - start) % step === 0;
}
