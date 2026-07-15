const ALLOWED_STEP_TYPES = new Set(['run', 'http', 'delay', 'notify', 'webhook_trigger', 'cron_trigger', 'telegram_event_trigger']);
const MAX_NODES = 50;
const MAX_FILE_SIZE_BYTES = 200_000; // 200 KB — plenty for a workflow definition
const CONFIRM_TTL_SECONDS = 300; // pending workflows expire after 5 minutes
const DEDUPE_TTL_SECONDS = 3600; // remember update_ids for an hour

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // POST /webhooks/:id
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
            `SELECT id, type, position_x, position_y, config FROM nodes WHERE workflow_id = ?`
          ).bind(id).all();

          // Check if there is a webhook_trigger node
          const hasWebhookTrigger = nodesRows.some(row => row.type === 'webhook_trigger');
          if (!hasWebhookTrigger) {
            return new Response(JSON.stringify({ ok: false, error: 'Workflow does not have a webhook trigger' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const { results: edgesRows } = await env.DB.prepare(
            `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
          ).bind(id).all();

          const nodes = nodesRows.map(row => ({
            id: row.id,
            type: row.type,
            position: { x: row.position_x, y: row.position_y },
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
          let triggerPayload = null;
          try {
            triggerPayload = await request.json().catch(() => null);
            if (triggerPayload && triggerPayload.chat_id) {
              chatId = triggerPayload.chat_id;
            }
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
          await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, triggerPayload);

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

    // GET /api/test-get-pending/:chatId
    if (url.pathname.startsWith('/api/test-get-pending/') && request.method === 'GET') {
      const parts = url.pathname.split('/');
      const chatId = parts[3];
      try {
        const raw = await env.WORKFLOW_STATE.get(`pending:${chatId}`);
        if (!raw) {
          return new Response(JSON.stringify({ ok: false, error: 'No pending workflow for this chat' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(raw, {
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

    // --- Telegram Event Triggers ---
    if (env.DB) {
      try {
        const { results: workflows } = await env.DB.prepare(
          `SELECT id, name FROM workflows`
        ).all();

        for (const wf of workflows) {
          const { results: nodesRows } = await env.DB.prepare(
            `SELECT id, type, config FROM nodes WHERE workflow_id = ?`
          ).bind(wf.id).all();

          const eventTriggers = nodesRows.filter(row => row.type === 'telegram_event_trigger');
          if (eventTriggers.length === 0) continue;

          let shouldTrigger = false;
          for (const trigger of eventTriggers) {
            const config = JSON.parse(trigger.config);
            if (config && config.event_type) {
              const eventTypes = Array.isArray(config.event_type) ? config.event_type : [config.event_type];
              if (eventTypes.some(et => matchTelegramEvent(update, et))) {
                shouldTrigger = true;
                break;
              }
            }
          }

          if (shouldTrigger) {
            const { results: edgesRows } = await env.DB.prepare(
              `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
            ).bind(wf.id).all();

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
              id: wf.id,
              name: wf.name,
              nodes,
              edges
            };

            const executionId = crypto.randomUUID();

            await env.DB.prepare(
              `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
            ).bind(
              executionId,
              wf.id,
              new Date().toISOString()
            ).run();

            let chatId = null;
            if (update.message && update.message.chat) {
              chatId = update.message.chat.id;
            } else if (update.edited_message && update.edited_message.chat) {
              chatId = update.edited_message.chat.id;
            } else if (update.my_chat_member && update.my_chat_member.chat) {
              chatId = update.my_chat_member.chat.id;
            } else if (update.chat_member && update.chat_member.chat) {
              chatId = update.chat_member.chat.id;
            } else if (update.chat_join_request && update.chat_join_request.chat) {
              chatId = update.chat_join_request.chat.id;
            }

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
            await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, { telegram_update: update });
          }
        }
      } catch (err) {
        console.error('Error matching telegram_event_trigger:', err);
      }
    }

    const message = update.message;
    const callbackQuery = update.callback_query;
    if (!message && !callbackQuery) return new Response('OK');

    const chatId = message ? message.chat.id : callbackQuery.message.chat.id;

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
      if (callbackQuery) {
        await answerCallbackQuery(env, callbackQuery.id);
        await handleBuilderCallback(env, chatId, callbackQuery);
      } else if (message.document) {
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
      } else if (message.text && message.text.startsWith('/newworkflow')) {
        await handleNewWorkflow(env, chatId, message.text);
      } else {
        const handled = await handleBuilderState(env, chatId, message.text);
        if (!handled) {
          if (message.text) {
            await sendMessage(env, chatId,
              "Send me a workflow as a .json file attachment. I'll validate it and show you " +
              "a summary — nothing runs until you reply /confirm <token>. Send /whoami to see your chat ID.\n\n" +
              "Or design a workflow directly in Telegram using: /newworkflow");
          }
        }
      }
    } catch (err) {
      await sendMessage(env, chatId, `Error: ${err.message}`);
    }

    return new Response('OK');
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) {
      console.error('Database is not configured');
      return;
    }

    try {
      const date = new Date(event.scheduledTime || Date.now());

      const { results: workflows } = await env.DB.prepare(
        `SELECT id, name FROM workflows`
      ).all();

      for (const wf of workflows) {
        const { results: nodesRows } = await env.DB.prepare(
          `SELECT id, type, config FROM nodes WHERE workflow_id = ?`
        ).bind(wf.id).all();

        // Check if there are cron_trigger nodes
        const cronTriggers = nodesRows.filter(row => row.type === 'cron_trigger');
        if (cronTriggers.length === 0) continue;

        let shouldTrigger = false;
        for (const trigger of cronTriggers) {
          const config = JSON.parse(trigger.config);
          if (config && config.cron && matchCron(config.cron, date)) {
            shouldTrigger = true;
            break;
          }
        }

        if (shouldTrigger) {
          const { results: edgesRows } = await env.DB.prepare(
            `SELECT source, target, source_handle FROM edges WHERE workflow_id = ?`
          ).bind(wf.id).all();

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
            id: wf.id,
            name: wf.name,
            nodes,
            edges
          };

          const executionId = crypto.randomUUID();

          await env.DB.prepare(
            `INSERT INTO executions (id, workflow_id, status, started_at) VALUES (?, ?, 'pending', ?)`
          ).bind(
            executionId,
            wf.id,
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

          const workerUrl = env.WORKER_URL || 'http://localhost:8787';
          await dispatchWorkflow(env, workflowObj, chatId, executionId, workerUrl, { scheduled_time: date.toISOString() });
        }
      }
    } catch (err) {
      console.error('Error during scheduled execution:', err);
    }
  },
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

  return errors;
}

function summarizeWorkflow(workflow) {
  let summary = `Nodes:\n`;
  workflow.nodes.forEach((n, i) => {
    if (n.type === 'run') summary += `  - [${n.id}] run: ${n.config.command}\n`;
    else if (n.type === 'http') summary += `  - [${n.id}] http: ${n.config.method || 'GET'} ${n.config.url}\n`;
    else if (n.type === 'delay') summary += `  - [${n.id}] delay: ${n.config.ms}ms\n`;
    else if (n.type === 'notify') summary += `  - [${n.id}] notify: "${n.config.message}"\n`;
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
  await env.WORKFLOW_STATE.delete(`builder:${chatId}`);
  await sendMessage(env, chatId, 'Discarded.');
}

async function getBuilderState(env, chatId) {
  const data = await env.WORKFLOW_STATE.get(`builder:${chatId}`);
  return data ? JSON.parse(data) : null;
}

async function setBuilderState(env, chatId, state) {
  await env.WORKFLOW_STATE.put(`builder:${chatId}`, JSON.stringify(state));
}

async function clearBuilderState(env, chatId) {
  await env.WORKFLOW_STATE.delete(`builder:${chatId}`);
}

async function handleNewWorkflow(env, chatId, text) {
  const parts = text.trim().split(/\s+/);
  let name = parts.slice(1).join(' ').trim();

  if (name) {
    const state = {
      state: 'AWAITING_NODE_TYPE',
      workflow: {
        name,
        nodes: [],
        edges: []
      }
    };
    await setBuilderState(env, chatId, state);
    await promptNodeType(env, chatId, state);
  } else {
    const state = {
      state: 'AWAITING_NAME',
      workflow: {
        name: '',
        nodes: [],
        edges: []
      }
    };
    await setBuilderState(env, chatId, state);
    await sendMessage(env, chatId, "Let's build a new workflow! What should we name it?\n(Or send /cancel to abort)");
  }
}

async function promptNodeType(env, chatId, state) {
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: 'Run Command (run)', callback_data: 'type:run' },
        { text: 'HTTP Request (http)', callback_data: 'type:http' }
      ],
      [
        { text: 'Delay (delay)', callback_data: 'type:delay' },
        { text: 'Telegram Notify (notify)', callback_data: 'type:notify' }
      ],
      [
        { text: '❌ Cancel Builder', callback_data: 'builder:cancel' }
      ]
    ]
  };
  await sendMessage(env, chatId, `Select the type for node #${state.workflow.nodes.length + 1}:`, inlineKeyboard);
}

async function handleBuilderCallback(env, chatId, callbackQuery) {
  const data = callbackQuery.data;
  let state = await getBuilderState(env, chatId);
  if (!state) {
    await sendMessage(env, chatId, "No active workflow builder session. Send /newworkflow to start.");
    return;
  }

  if (data === 'builder:cancel') {
    await clearBuilderState(env, chatId);
    await sendMessage(env, chatId, "Workflow builder canceled.");
    return;
  }

  // Reject action buttons if they are clicked out-of-order/stale while in the middle of configuring a node
  if ((data === 'builder:add_node' || data === 'builder:finish') && state.state !== 'AWAITING_NEXT_ACTION') {
    await sendMessage(env, chatId, "⚠️ Please finish configuring the current node first or cancel the builder with /cancel.");
    return;
  }

  if (data === 'builder:add_node') {
    state.state = 'AWAITING_NODE_TYPE';
    await setBuilderState(env, chatId, state);
    await promptNodeType(env, chatId, state);
    return;
  }

  if (data === 'builder:finish') {
    await finalizeAndStageWorkflow(env, chatId, state);
    return;
  }

  if (state.state === 'AWAITING_NODE_TYPE' && data.startsWith('type:')) {
    const nodeType = data.substring(5);
    state.currentNode = {
      id: `node_${state.workflow.nodes.length + 1}`,
      type: nodeType,
      config: {}
    };

    if (nodeType === 'run') {
      state.state = 'AWAITING_RUN_COMMAND';
      await setBuilderState(env, chatId, state);
      await sendMessage(env, chatId, `Node [${state.currentNode.id}]: Enter the shell command to execute:`);
    } else if (nodeType === 'http') {
      state.state = 'AWAITING_HTTP_URL';
      await setBuilderState(env, chatId, state);
      await sendMessage(env, chatId, `Node [${state.currentNode.id}]: Enter the target HTTP URL:`);
    } else if (nodeType === 'delay') {
      state.state = 'AWAITING_DELAY_MS';
      await setBuilderState(env, chatId, state);
      await sendMessage(env, chatId, `Node [${state.currentNode.id}]: Enter the delay in milliseconds (e.g. 5000):`);
    } else if (nodeType === 'notify') {
      state.state = 'AWAITING_NOTIFY_MESSAGE';
      await setBuilderState(env, chatId, state);
      await sendMessage(env, chatId, `Node [${state.currentNode.id}]: Enter the message to notify/send to Telegram:`);
    }
    return;
  }

  if (state.state === 'AWAITING_HTTP_METHOD' && data.startsWith('method:')) {
    const method = data.substring(7);
    state.currentNode.config.method = method;
    await commitCurrentNode(env, chatId, state);
  }
}

async function handleBuilderState(env, chatId, text) {
  const state = await getBuilderState(env, chatId);
  if (!state) return false;

  if (typeof text !== 'string' || !text) {
    await sendMessage(env, chatId, "⚠️ Unexpected message type. Please enter text configuration or /cancel.");
    return true; // We handled/consumed it so it doesn't trigger the default help text
  }

  if (state.state === 'AWAITING_NAME') {
    const name = text.trim();
    if (!name) {
      await sendMessage(env, chatId, "Name cannot be empty. Please enter a workflow name:");
      return true;
    }
    state.workflow.name = name;
    state.state = 'AWAITING_NODE_TYPE';
    await setBuilderState(env, chatId, state);
    await promptNodeType(env, chatId, state);
    return true;
  }

  if (state.state === 'AWAITING_RUN_COMMAND') {
    const command = text.trim();
    if (!command) {
      await sendMessage(env, chatId, "Command cannot be empty. Please enter a shell command:");
      return true;
    }
    state.currentNode.config.command = command;
    await commitCurrentNode(env, chatId, state);
    return true;
  }

  if (state.state === 'AWAITING_HTTP_URL') {
    const url = text.trim();
    if (!url) {
      await sendMessage(env, chatId, "URL cannot be empty. Please enter an HTTP URL:");
      return true;
    }
    state.currentNode.config.url = url;
    state.state = 'AWAITING_HTTP_METHOD';
    await setBuilderState(env, chatId, state);

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'GET', callback_data: 'method:GET' },
          { text: 'POST', callback_data: 'method:POST' }
        ],
        [
          { text: 'PUT', callback_data: 'method:PUT' },
          { text: 'DELETE', callback_data: 'method:DELETE' }
        ]
      ]
    };
    await sendMessage(env, chatId, `Node [${state.currentNode.id}]: Select the HTTP Method:`, inlineKeyboard);
    return true;
  }

  if (state.state === 'AWAITING_DELAY_MS') {
    const ms = parseInt(text.trim(), 10);
    if (isNaN(ms) || ms < 0) {
      await sendMessage(env, chatId, "Please enter a valid non-negative number for milliseconds delay:");
      return true;
    }
    state.currentNode.config.ms = ms;
    await commitCurrentNode(env, chatId, state);
    return true;
  }

  if (state.state === 'AWAITING_NOTIFY_MESSAGE') {
    const message = text.trim();
    if (!message) {
      await sendMessage(env, chatId, "Message cannot be empty. Please enter a notification message:");
      return true;
    }
    state.currentNode.config.message = message;
    await commitCurrentNode(env, chatId, state);
    return true;
  }

  return false;
}

async function commitCurrentNode(env, chatId, state) {
  const node = state.currentNode;
  node.position = {
    x: 100,
    y: 100 + state.workflow.nodes.length * 150
  };

  const previousNode = state.workflow.nodes[state.workflow.nodes.length - 1];
  state.workflow.nodes.push(node);

  if (previousNode) {
    state.workflow.edges.push({
      source: previousNode.id,
      target: node.id,
      sourceHandle: 'success'
    });
  }

  delete state.currentNode;
  state.state = 'AWAITING_NEXT_ACTION';
  await setBuilderState(env, chatId, state);

  let currentSummary = `Successfully added Node [${node.id}] (${node.type}).\n\nCurrent Workflow structure:\n`;
  state.workflow.nodes.forEach((n) => {
    currentSummary += `- [${n.id}] ${n.type}\n`;
  });

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '➕ Add Next Node', callback_data: 'builder:add_node' },
        { text: '💾 Save & Finish', callback_data: 'builder:finish' }
      ],
      [
        { text: '❌ Cancel Builder', callback_data: 'builder:cancel' }
      ]
    ]
  };

  await sendMessage(env, chatId, currentSummary + `\nWhat would you like to do next?`, inlineKeyboard);
}

async function finalizeAndStageWorkflow(env, chatId, state) {
  const workflow = state.workflow;
  if (!workflow.nodes || workflow.nodes.length === 0) {
    await sendMessage(env, chatId, "Cannot finalize workflow with no nodes. Add at least one node or /cancel.");
    return;
  }

  const errors = validateWorkflow(workflow);
  if (errors.length > 0) {
    await sendMessage(env, chatId, `Workflow validation failed:\n- ${errors.join('\n- ')}\n\nCancel builder with /cancel.`);
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
    `Workflow builder finished! Staged "${workflow.name}" (${workflow.nodes.length} node(s)):\n\n${summary}\n\n` +
    `Reply "/confirm ${token}" within ${CONFIRM_TTL_SECONDS / 60} minutes to run it, or /cancel to discard.`
  );

  // Clear builder state only after the staging and confirmation message is successful
  await clearBuilderState(env, chatId);
}

async function dispatchWorkflow(env, workflow, chatId, executionId, workerUrl, triggerPayload = null) {
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
          trigger_payload: triggerPayload
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

async function sendMessage(env, chatId, text, replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const body = { chat_id: chatId, text };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`Telegram sendMessage failed with status ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Telegram sendMessage network error: ${err.message}`);
  }
}

async function answerCallbackQuery(env, callbackQueryId) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!res.ok) {
      console.error(`Telegram answerCallbackQuery failed with status ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Telegram answerCallbackQuery network error: ${err.message}`);
  }
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

function matchCron(cron, date) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const mins = date.getUTCMinutes();
  const hours = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // getUTCMonth is 0-indexed (0 = January)
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday

  const matchField = (field, value, minVal, maxVal) => {
    if (field === '*') return true;

    // Normalize dayOfWeek: 7 becomes 0
    if (maxVal === 6 && field === '7') {
      field = '0';
    }

    // Handle comma-separated values
    const parts = field.split(',');
    if (parts.length > 1) {
      return parts.some(p => matchField(p, value, minVal, maxVal));
    }

    // Handle step values, e.g., */5 or 1-10/2
    if (field.includes('/')) {
      const [range, stepStr] = field.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step)) return false;

      let start = minVal;
      let end = maxVal;
      if (range !== '*') {
        if (range.includes('-')) {
          const [startStr, endStr] = range.split('-');
          start = parseInt(startStr, 10);
          end = parseInt(endStr, 10);
        } else {
          start = parseInt(range, 10);
        }
      }
      if (isNaN(start) || isNaN(end)) return false;
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    // Handle ranges, e.g., 1-5
    if (field.includes('-')) {
      const [startStr, endStr] = field.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) return false;
      return value >= start && value <= end;
    }

    // Handle single number
    const num = parseInt(field, 10);
    return num === value;
  };

  return (
    matchField(fields[0], mins, 0, 59) &&
    matchField(fields[1], hours, 0, 23) &&
    matchField(fields[2], dayOfMonth, 1, 31) &&
    matchField(fields[3], month, 1, 12) &&
    matchField(fields[4], dayOfWeek, 0, 6)
  );
}

function matchTelegramEvent(update, eventType) {
  if (!update) return false;

  const type = eventType.toLowerCase();

  if (type === 'edited_message') {
    return !!update.edited_message;
  }
  if (type === 'new_chat_members') {
    return !!(update.message && update.message.new_chat_members);
  }
  if (type === 'left_chat_member') {
    return !!(update.message && update.message.left_chat_member);
  }
  if (type === 'callback_query') {
    return !!update.callback_query;
  }
  if (type === 'inline_query') {
    return !!update.inline_query;
  }
  if (type === 'poll') {
    return !!update.poll;
  }
  if (type === 'poll_answer') {
    return !!update.poll_answer;
  }
  if (type === 'chat_member') {
    return !!update.chat_member;
  }
  if (type === 'my_chat_member') {
    return !!update.my_chat_member;
  }
  if (type === 'chat_join_request') {
    return !!update.chat_join_request;
  }
  if (type === 'message') {
    return !!update.message;
  }

  return false;
}
