import crypto from 'node:crypto';

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

          const clientSecret = request.headers.get('X-Workflow-Secret');

          const safeCompare = (a, b) => {
            if (typeof a !== 'string' || typeof b !== 'string') return false;
            const aBuf = new TextEncoder().encode(a);
            const bBuf = new TextEncoder().encode(b);
            if (aBuf.byteLength !== bBuf.byteLength) return false;
            return crypto.timingSafeEqual(aBuf, bBuf);
          };

          let hasConfiguredSecret = false;
          let isAuthorized = false;

          for (const row of nodesRows) {
            if (row.type === 'webhook_trigger') {
              const config = JSON.parse(row.config || '{}');
              if (config && typeof config.secret === 'string' && config.secret.trim() !== '') {
                hasConfiguredSecret = true;
                if (clientSecret && safeCompare(clientSecret, config.secret)) {
                  isAuthorized = true;
                }
              }
            }
          }

          if (!hasConfiguredSecret) {
            return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Webhook trigger has no configured secret' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (!isAuthorized) {
            return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid X-Workflow-Secret' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Rate Limiting using WORKFLOW_STATE KV per workflow ID (limit to 5 requests per 60s)
          if (env.WORKFLOW_STATE) {
            const limitKey = `ratelimit:${id}`;
            const limitInfoRaw = await env.WORKFLOW_STATE.get(limitKey);
            let limitInfo = { count: 0, reset: Date.now() + 60000 };
            if (limitInfoRaw) {
              try {
                limitInfo = JSON.parse(limitInfoRaw);
              } catch (e) {}
            }

            if (Date.now() > limitInfo.reset) {
              limitInfo.count = 0;
              limitInfo.reset = Date.now() + 60000;
            }

            const RATE_LIMIT_THRESHOLD = 5;
            if (limitInfo.count >= RATE_LIMIT_THRESHOLD) {
              return new Response(JSON.stringify({ ok: false, error: 'Too Many Requests: Rate limit exceeded.' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            limitInfo.count++;
            await env.WORKFLOW_STATE.put(limitKey, JSON.stringify(limitInfo), { expirationTtl: 60 });
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

          // Sanitize the incoming trigger payload to ensure it is strictly treated as data
          // and can never be interpreted as executable code/shell commands when passed to GitHub Actions.
          const sanitizeValue = (val) => {
            if (typeof val === 'string') {
              return val.replace(/[;&|`$><\\\r\n]/g, '');
            } else if (Array.isArray(val)) {
              return val.map(sanitizeValue);
            } else if (val !== null && typeof val === 'object') {
              const cleanObj = {};
              for (const [k, v] of Object.entries(val)) {
                cleanObj[k] = sanitizeValue(v);
              }
              return cleanObj;
            }
            return val;
          };

          // Force all notify dispatches to resolve the chat_id exclusively from server-side stored owner data
          let triggerPayload = null;
          try {
            triggerPayload = await request.json().catch(() => null);
            if (triggerPayload && typeof triggerPayload === 'object') {
              delete triggerPayload.chat_id;
              triggerPayload = sanitizeValue(triggerPayload);
            }
          } catch (e) {}

          const allowList = (env.ALLOWED_CHAT_IDS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const chatId = allowList[0] || null;

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
        const userId = (callbackQuery.from && callbackQuery.from.id) || (callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id);
        if (!isUserAllowed(userId, env)) {
          await answerCallbackQuery(env, callbackQuery.id, {
            text: "You are not authorized to interact with this bot.",
            show_alert: true
          });
          return new Response('OK');
        }

        const data = callbackQuery.data;
        try {
          if (data.startsWith('wf_sel:') || data.startsWith('wf_nav:')) {
            await handleBrowserCallback(env, chatId, callbackQuery);
          } else if (data.startsWith('random_media:next:') || data.startsWith('rm_next:')) {
            await handleRandomMediaCallback(env, chatId, callbackQuery);
          } else {
            await answerCallbackQuery(env, callbackQuery.id);
            await handleBuilderCallback(env, chatId, callbackQuery);
          }
        } catch (err) {
          console.error("Error in callbackQuery handler:", err);
          throw err;
        }
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
      } else if (message.text && (message.text.startsWith('/workflows') || message.text === '📋 Workflows')) {
        await handleListWorkflows(env, chatId);
      } else if (message.text && message.text.startsWith('/browse')) {
        const parts = message.text.trim().split(/\s+/);
        const workflowId = parts[1];
        if (!workflowId) {
          await sendMessage(env, chatId, "Usage: /browse <workflow_id>");
        } else {
          await startBrowsing(env, chatId, workflowId);
        }
      } else {
        const editHandled = await handleNodeConfigEdit(env, chatId, message.text);
        if (!editHandled) {
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
    if (node.type === 'notify' && typeof config.message !== 'string' && getRandomMediaItems(config).length === 0) {
      errors.push(`node ${i} (${node.id || 'unnamed'}): "notify" config needs a string "message" or a non-empty random media list`);
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
    else if (n.type === 'notify') {
      const mediaCount = getRandomMediaItems(n.config).length;
      summary += mediaCount > 0
        ? `  - [${n.id}] notify: random media (${mediaCount} item(s))\n`
        : `  - [${n.id}] notify: "${n.config.message}"\n`;
    }
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

  const startNodeId = pending.start_node_id || null;
  await dispatchWorkflow(env, workflow, chatId, executionId, workerUrl, null, startNodeId);
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

async function handleListWorkflows(env, chatId) {
  if (!env.DB) {
    await sendMessage(env, chatId, "Database is not configured.");
    return;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, name FROM workflows ORDER BY created_at DESC"
  ).all();

  if (!results || results.length === 0) {
    await sendMessage(env, chatId, "No workflows found. Use /newworkflow to create one, or upload a JSON workflow file.");
    return;
  }

  const inlineKeyboard = {
    inline_keyboard: results.map(row => [
      { text: row.name, callback_data: `wf_sel:${row.id}` }
    ])
  };

  await sendMessage(env, chatId, "Select a workflow to browse:", inlineKeyboard);
}

function isUserAllowed(userId, env) {
  const allowList = (env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowList.length === 0 || allowList.includes(String(userId));
}

async function sendMessageAndReturn(env, chatId, text, replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
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
    if (res.ok) {
      return await res.json();
    } else {
      console.error(`Telegram sendMessage failed with status ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Telegram sendMessage network error: ${err.message}`);
  }
  return null;
}

async function editMessage(env, chatId, messageId, text, replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'Token missing' };
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return await res.json();
    } else {
      const errText = await res.text();
      console.error(`Telegram editMessageText failed with status ${res.status}: ${errText}`);
      return { ok: false, error: errText, status: res.status };
    }
  } catch (err) {
    console.error(`Telegram editMessageText network error: ${err.message}`);
  }
  return { ok: false, error: 'Network error' };
}

async function startBrowsing(env, chatId, workflowId, messageIdToEdit = null) {
  if (!env.DB) {
    await sendMessage(env, chatId, "Database is not configured.");
    return;
  }

  const workflow = await env.DB.prepare(
    "SELECT id, name FROM workflows WHERE id = ?"
  ).bind(workflowId).first();

  if (!workflow) {
    await sendMessage(env, chatId, `Workflow with ID "${workflowId}" not found.`);
    return;
  }

  const nodes = await env.DB.prepare(
    "SELECT id FROM nodes WHERE workflow_id = ? ORDER BY id ASC"
  ).bind(workflowId).all();

  if (!nodes.results || nodes.results.length === 0) {
    await sendMessage(env, chatId, `Workflow "${workflow.name}" has no nodes to browse.`);
    return;
  }

  const browseState = {
    workflow_id: workflowId,
    node_index: 0,
    message_id: messageIdToEdit
  };

  const rendered = await renderNodeBrowser(env, chatId, workflowId, 0);
  if (!rendered) return;

  if (messageIdToEdit) {
    await editMessage(env, chatId, messageIdToEdit, rendered.text, rendered.reply_markup);
  } else {
    const sentMsg = await sendMessageAndReturn(env, chatId, rendered.text, rendered.reply_markup);
    if (sentMsg && sentMsg.result) {
      browseState.message_id = sentMsg.result.message_id;
    }
  }

  await env.WORKFLOW_STATE.put(`browse:${chatId}`, JSON.stringify(browseState));
}

async function renderNodeBrowser(env, chatId, workflowId, nodeIndex) {
  if (!env.DB) return null;

  const workflow = await env.DB.prepare(
    "SELECT id, name FROM workflows WHERE id = ?"
  ).bind(workflowId).first();

  if (!workflow) return null;

  const { results: nodesRows } = await env.DB.prepare(
    "SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ? ORDER BY id ASC"
  ).bind(workflowId).all();

  if (!nodesRows || nodesRows.length === 0) {
    return {
      text: `🔧 ${workflow.name} has no nodes.`,
      reply_markup: { inline_keyboard: [] }
    };
  }

  if (nodeIndex < 0) nodeIndex = 0;
  if (nodeIndex >= nodesRows.length) nodeIndex = nodesRows.length - 1;

  const selectedNode = nodesRows[nodeIndex];
  const totalNodes = nodesRows.length;

  const { results: edgesRows } = await env.DB.prepare(
    "SELECT source, target, source_handle FROM edges WHERE workflow_id = ?"
  ).bind(workflowId).all();

  const parents = edgesRows.filter(e => e.target === selectedNode.id).map(e => e.source);
  const children = edgesRows.filter(e => e.source === selectedNode.id);

  const parentsPrefix = parents.length > 0 ? `${parents.join(', ')} → ` : '';
  let graphText = `${parentsPrefix}[● ${selectedNode.id}: ${selectedNode.type}]\n`;

  const indent = ' '.repeat(parentsPrefix.length + 2);
  children.forEach((child, idx) => {
    const isLast = idx === children.length - 1;
    const branchPrefix = isLast ? '└─' : '├─';
    const targetNode = nodesRows.find(n => n.id === child.target);
    const targetType = targetNode ? targetNode.type : 'unknown';
    const handle = child.source_handle || 'success';
    graphText += `${indent}${branchPrefix}${handle}→ ${child.target} (${targetType})\n`;
  });

  const config = JSON.parse(selectedNode.config || '{}');
  let detailsText = '';
  if (selectedNode.type === 'run') {
    detailsText = `Command: \`${config.command || ''}\``;
  } else if (selectedNode.type === 'http') {
    detailsText = `${config.method || 'GET'} ${config.url || ''}`;
  } else if (selectedNode.type === 'delay') {
    detailsText = `Delay: ${config.ms || 0}ms`;
  } else if (selectedNode.type === 'notify') {
    detailsText = `Message: "${config.message || ''}"`;
  } else if (selectedNode.type === 'webhook_trigger') {
    detailsText = `Secret: ${config.secret ? '(has secret)' : '(no secret)'}`;
  } else if (selectedNode.type === 'cron_trigger') {
    detailsText = `Cron: "${config.cron || ''}"`;
  } else if (selectedNode.type === 'telegram_event_trigger') {
    detailsText = `Events: "${config.event_type || ''}"`;
  }

  const messageText =
`🔧 ${workflow.name} — Node ${nodeIndex + 1} of ${totalNodes}

${graphText}
Selected: ${selectedNode.id} (${selectedNode.type})
${detailsText}`;

  const inlineKeyboard = [
    [
      { text: '◀ Prev', callback_data: 'wf_nav:prev' },
      { text: 'Run from here', callback_data: 'wf_nav:run' },
      { text: 'Next ▶', callback_data: 'wf_nav:next' }
    ],
    [
      { text: 'Edit config', callback_data: 'wf_nav:edit' },
      { text: 'Delete node', callback_data: 'wf_nav:delete' }
    ]
  ];

  return {
    text: messageText,
    reply_markup: { inline_keyboard: inlineKeyboard }
  };
}

async function handleBrowserCallback(env, chatId, callbackQuery) {
  const data = callbackQuery.data;

  if (data.startsWith('wf_sel:')) {
    const workflowId = data.substring(7);
    await startBrowsing(env, chatId, workflowId, callbackQuery.message.message_id);
    await answerCallbackQuery(env, callbackQuery.id, { text: "Workflow opened." });
    return;
  }

  const rawState = await env.WORKFLOW_STATE.get(`browse:${chatId}`);
  if (!rawState) {
    await answerCallbackQuery(env, callbackQuery.id, {
      text: "No active browsing session. Send /workflows to start.",
      show_alert: true
    });
    return;
  }

  const browseState = JSON.parse(rawState);
  const workflowId = browseState.workflow_id;
  let nodeIndex = browseState.node_index;

  if (!env.DB) {
    await answerCallbackQuery(env, callbackQuery.id, {
      text: "Database is not configured.",
      show_alert: true
    });
    return;
  }

  const workflow = await env.DB.prepare(
    "SELECT id, name FROM workflows WHERE id = ?"
  ).bind(workflowId).first();

  if (!workflow) {
    await answerCallbackQuery(env, callbackQuery.id, {
      text: "Workflow not found.",
      show_alert: true
    });
    return;
  }

  const { results: nodesRows } = await env.DB.prepare(
    "SELECT id, type, config FROM nodes WHERE workflow_id = ? ORDER BY id ASC"
  ).bind(workflowId).all();

  if (!nodesRows || nodesRows.length === 0) {
    await answerCallbackQuery(env, callbackQuery.id, {
      text: "This workflow has no nodes.",
      show_alert: true
    });
    return;
  }

  if (data === 'wf_nav:prev') {
    if (nodeIndex <= 0) {
      await answerCallbackQuery(env, callbackQuery.id, { text: "Already at the first node!" });
      return;
    }
    nodeIndex--;
  } else if (data === 'wf_nav:next') {
    if (nodeIndex >= nodesRows.length - 1) {
      await answerCallbackQuery(env, callbackQuery.id, { text: "Already at the last node!" });
      return;
    }
    nodeIndex++;
  } else if (data === 'wf_nav:run') {
    const selectedNode = nodesRows[nodeIndex];
    const token = crypto.randomUUID().slice(0, 8);
    const pendingKey = `pending:${chatId}`;

    const { results: fullNodes } = await env.DB.prepare(
      "SELECT id, type, position_x, position_y, config, inputs, outputs FROM nodes WHERE workflow_id = ?"
    ).bind(workflowId).all();

    const { results: fullEdges } = await env.DB.prepare(
      "SELECT source, target, source_handle FROM edges WHERE workflow_id = ?"
    ).bind(workflowId).all();

    const workflowObj = {
      id: workflow.id,
      name: workflow.name,
      nodes: fullNodes.map(r => ({
        id: r.id,
        type: r.type,
        position: { x: r.position_x, y: r.position_y },
        config: JSON.parse(r.config),
        inputs: r.inputs ? JSON.parse(r.inputs) : undefined,
        outputs: r.outputs ? JSON.parse(r.outputs) : undefined
      })),
      edges: fullEdges.map(r => ({
        source: r.source,
        target: r.target,
        sourceHandle: r.source_handle || 'success'
      }))
    };

    await env.WORKFLOW_STATE.put(
      pendingKey,
      JSON.stringify({
        workflow: workflowObj,
        token,
        start_node_id: selectedNode.id,
        created_at: Date.now()
      }),
      { expirationTtl: CONFIRM_TTL_SECONDS }
    );

    await answerCallbackQuery(env, callbackQuery.id, { text: "Run staged!" });
    await sendMessage(
      env, chatId,
      `Staged "${workflow.name}" to run starting from node "${selectedNode.id}".\n\n` +
      `Reply "/confirm ${token}" within ${CONFIRM_TTL_SECONDS / 60} minutes to run it, or /cancel to discard.`
    );
    return;
  } else if (data === 'wf_nav:edit') {
    const selectedNode = nodesRows[nodeIndex];
    const editState = {
      workflow_id: workflowId,
      node_id: selectedNode.id,
      state: 'EDITING_NODE_CONFIG',
      message_id: callbackQuery.message.message_id
    };

    await env.WORKFLOW_STATE.put(`edit_state:${chatId}`, JSON.stringify(editState));
    await answerCallbackQuery(env, callbackQuery.id, { text: "Editing node..." });
    await sendMessage(
      env, chatId,
      `Editing configuration for node [${selectedNode.id}] (${selectedNode.type}).\n` +
      `Send the new configuration as a JSON object, or a single text/numeric value (e.g., the URL, command, ms, or message):`
    );
    return;
  } else if (data === 'wf_nav:delete') {
    const selectedNode = nodesRows[nodeIndex];

    await env.DB.prepare(
      "DELETE FROM nodes WHERE workflow_id = ? AND id = ?"
    ).bind(workflowId, selectedNode.id).run();

    await env.DB.prepare(
      "DELETE FROM edges WHERE workflow_id = ? AND (source = ? OR target = ?)"
    ).bind(workflowId, selectedNode.id, selectedNode.id).run();

    await answerCallbackQuery(env, callbackQuery.id, { text: "Node deleted!" });

    const { results: remainingNodes } = await env.DB.prepare(
      "SELECT id FROM nodes WHERE workflow_id = ? ORDER BY id ASC"
    ).bind(workflowId).all();

    if (!remainingNodes || remainingNodes.length === 0) {
      await env.WORKFLOW_STATE.delete(`browse:${chatId}`);
      await editMessage(env, chatId, callbackQuery.message.message_id, `🔧 ${workflow.name} has no nodes left.`);
      return;
    }

    if (nodeIndex >= remainingNodes.length) {
      nodeIndex = remainingNodes.length - 1;
    }
  }

  browseState.node_index = nodeIndex;
  await env.WORKFLOW_STATE.put(`browse:${chatId}`, JSON.stringify(browseState));

  const rendered = await renderNodeBrowser(env, chatId, workflowId, nodeIndex);
  if (rendered) {
    const editRes = await editMessage(env, chatId, callbackQuery.message.message_id, rendered.text, rendered.reply_markup);
    if (editRes && !editRes.ok && editRes.status === 429) {
      await answerCallbackQuery(env, callbackQuery.id, {
        text: "Too fast! Please wait a moment...",
        show_alert: true
      });
    } else {
      await answerCallbackQuery(env, callbackQuery.id, { text: `Paged to node ${nodeIndex + 1}` });
    }
  }
}

async function handleNodeConfigEdit(env, chatId, text) {
  const rawState = await env.WORKFLOW_STATE.get(`edit_state:${chatId}`);
  if (!rawState) return false;

  const editState = JSON.parse(rawState);
  const { workflow_id, node_id, message_id } = editState;

  if (!env.DB) {
    await sendMessage(env, chatId, "Database is not configured.");
    await env.WORKFLOW_STATE.delete(`edit_state:${chatId}`);
    return true;
  }

  const nodeRow = await env.DB.prepare(
    "SELECT type, config FROM nodes WHERE workflow_id = ? AND id = ?"
  ).bind(workflow_id, node_id).first();

  if (!nodeRow) {
    await sendMessage(env, chatId, `Node [${node_id}] not found.`);
    await env.WORKFLOW_STATE.delete(`edit_state:${chatId}`);
    return true;
  }

  let newConfig = {};
  const inputStr = text.trim();

  try {
    if (inputStr.startsWith('{') && inputStr.endsWith('}')) {
      newConfig = JSON.parse(inputStr);
    } else {
      if (nodeRow.type === 'run') {
        newConfig = { command: inputStr };
      } else if (nodeRow.type === 'http') {
        newConfig = { url: inputStr };
      } else if (nodeRow.type === 'delay') {
        const ms = parseInt(inputStr, 10);
        if (isNaN(ms) || ms < 0) {
          await sendMessage(env, chatId, "⚠️ Delay must be a valid non-negative number.");
          return true;
        }
        newConfig = { ms };
      } else if (nodeRow.type === 'notify') {
        newConfig = { message: inputStr };
      } else if (nodeRow.type === 'cron_trigger') {
        newConfig = { cron: inputStr };
      } else if (nodeRow.type === 'telegram_event_trigger') {
        newConfig = { event_type: inputStr };
      } else {
        newConfig = { value: inputStr };
      }
    }
  } catch (err) {
    await sendMessage(env, chatId, `⚠️ Invalid JSON: ${err.message}. Please enter a valid JSON object or plain value:`);
    return true;
  }

  await env.DB.prepare(
    "UPDATE nodes SET config = ? WHERE workflow_id = ? AND id = ?"
  ).bind(JSON.stringify(newConfig), workflow_id, node_id).run();

  await env.WORKFLOW_STATE.delete(`edit_state:${chatId}`);

  await sendMessage(env, chatId, `Configuration for node [${node_id}] updated successfully!`);

  const rawBrowseState = await env.WORKFLOW_STATE.get(`browse:${chatId}`);
  if (rawBrowseState) {
    const browseState = JSON.parse(rawBrowseState);
    if (browseState.workflow_id === workflow_id) {
      const rendered = await renderNodeBrowser(env, chatId, workflow_id, browseState.node_index);
      if (rendered) {
        await editMessage(env, chatId, message_id, rendered.text, rendered.reply_markup);
      }
    }
  }

  return true;
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

async function dispatchWorkflow(env, workflow, chatId, executionId, workerUrl, triggerPayload = null, startNodeId = null) {
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
          trigger_payload: triggerPayload,
          start_node_id: startNodeId
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


function getRandomMediaItems(config = {}) {
  const candidates = config.random_media || config.media || config.media_urls || config.mediaUrls || [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item) => {
      if (typeof item === 'string') return { url: item };
      if (!item || typeof item !== 'object') return null;
      const url = item.url || item.file_id || item.fileId || item.media;
      if (typeof url !== 'string' || !url.trim()) return null;
      return {
        ...item,
        url: url.trim(),
        type: item.type || inferTelegramMediaType(url),
        caption: item.caption
      };
    })
    .filter(Boolean);
}

function inferTelegramMediaType(url) {
  const cleanUrl = String(url).split('?')[0].toLowerCase();
  if (/\.(mp4|mov|m4v|webm)$/.test(cleanUrl)) return 'video';
  if (/\.(gif)$/.test(cleanUrl)) return 'animation';
  if (/\.(jpg|jpeg|png|webp|bmp)$/.test(cleanUrl)) return 'photo';
  return 'document';
}

function getRandomMediaCallbackData(token) {
  return `rm_next:${token}`;
}

function pickRandomMediaItem(items, previousIndex = -1) {
  if (items.length === 0) return { item: null, index: -1 };
  if (items.length === 1) return { item: items[0], index: 0 };

  let index = Math.floor(Math.random() * items.length);
  if (index === previousIndex) {
    index = (index + 1 + Math.floor(Math.random() * (items.length - 1))) % items.length;
  }
  return { item: items[index], index };
}

async function sendTelegramMedia(env, chatId, item, replyMarkup = null, fallbackCaption = '') {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'Token missing' };

  const type = item.type || inferTelegramMediaType(item.url);
  const endpointByType = {
    photo: 'sendPhoto',
    video: 'sendVideo',
    animation: 'sendAnimation',
    document: 'sendDocument'
  };
  const mediaFieldByType = {
    photo: 'photo',
    video: 'video',
    animation: 'animation',
    document: 'document'
  };
  const endpoint = endpointByType[type] || 'sendDocument';
  const mediaField = mediaFieldByType[type] || 'document';
  const caption = item.caption ?? fallbackCaption;
  const body = {
    chat_id: chatId,
    [mediaField]: item.url
  };
  if (caption) body.caption = caption;
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.json();

    const errText = await res.text();
    console.error(`Telegram ${endpoint} failed with status ${res.status}: ${errText}`);

    if (shouldRetryTelegramMediaUpload(errText, item.url)) {
      const uploadResult = await uploadTelegramMediaFromUrl(env, chatId, item.url, {
        endpoint,
        mediaField,
        caption,
        replyMarkup
      });
      if (uploadResult.ok) return uploadResult;
    }

    return { ok: false, error: errText, status: res.status };
  } catch (err) {
    console.error(`Telegram ${endpoint} network error: ${err.message}`);
    return { ok: false, error: 'Network error' };
  }
}

function shouldRetryTelegramMediaUpload(errorText, mediaUrl) {
  if (!/^https?:\/\//i.test(String(mediaUrl || ''))) return false;
  return /failed to get http url content|wrong file identifier|invalid file http url/i.test(String(errorText || ''));
}

async function uploadTelegramMediaFromUrl(env, chatId, mediaUrl, options) {
  try {
    const mediaResponse = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'telegram-workflow-bot/1.0'
      }
    });
    if (!mediaResponse.ok) {
      const message = `Media fetch failed (${mediaResponse.status})`;
      console.error(message);
      return { ok: false, error: message, status: mediaResponse.status };
    }

    const blob = await mediaResponse.blob();
    const filename = getFilenameFromUrl(mediaUrl, options.mediaField, blob.type);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(options.mediaField, blob, filename);
    if (options.caption) form.append('caption', options.caption);
    if (options.replyMarkup) form.append('reply_markup', JSON.stringify(options.replyMarkup));

    const uploadResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${options.endpoint}`, {
      method: 'POST',
      body: form,
    });
    if (uploadResponse.ok) return await uploadResponse.json();

    const errText = await uploadResponse.text();
    console.error(`Telegram ${options.endpoint} upload failed with status ${uploadResponse.status}: ${errText}`);
    return { ok: false, error: errText, status: uploadResponse.status };
  } catch (err) {
    console.error(`Telegram media upload fallback failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function getFilenameFromUrl(mediaUrl, mediaField, contentType = '') {
  try {
    const pathname = new URL(mediaUrl).pathname;
    const filename = pathname.split('/').filter(Boolean).pop();
    if (filename) return filename;
  } catch (e) {}

  const extensionByContentType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'application/pdf': 'pdf'
  };
  const extension = extensionByContentType[String(contentType || '').split(';')[0].toLowerCase()] || 'bin';
  return `${mediaField}.${extension}`;
}

async function sendRandomMedia(env, chatId, items, options = {}) {
  if (!env.WORKFLOW_STATE) {
    throw new Error("Workflow state KV is required for random media buttons");
  }
  const token = crypto.randomUUID().slice(0, 12);
  const { item, index } = pickRandomMediaItem(items);
  if (!item) return;

  const replyMarkup = {
    inline_keyboard: [[
      { text: options.buttonText || '🎲 Next random media', callback_data: getRandomMediaCallbackData(token) }
    ]]
  };

  await env.WORKFLOW_STATE.put(
    `random_media:${chatId}:${token}`,
    JSON.stringify({ items, current_index: index, caption: options.caption || '', button_text: options.buttonText || '🎲 Next random media' }),
    { expirationTtl: 24 * 60 * 60 }
  );

  return sendTelegramMedia(env, chatId, item, replyMarkup, options.caption || '');
}

async function handleRandomMediaCallback(env, chatId, callbackQuery) {
  const data = callbackQuery.data || '';
  const token = data.startsWith('rm_next:') ? data.substring('rm_next:'.length) : data.substring('random_media:next:'.length);
  const key = `random_media:${chatId}:${token}`;
  const rawState = await env.WORKFLOW_STATE.get(key);
  if (!rawState) {
    await answerCallbackQuery(env, callbackQuery.id, {
      text: 'This random media button expired. Run the workflow again for a fresh button.',
      show_alert: true
    });
    return;
  }

  const state = JSON.parse(rawState);
  const items = getRandomMediaItems({ random_media: state.items });
  const { item, index } = pickRandomMediaItem(items, state.current_index);
  if (!item) {
    await answerCallbackQuery(env, callbackQuery.id, { text: 'No media is available.', show_alert: true });
    return;
  }

  state.current_index = index;
  await env.WORKFLOW_STATE.put(key, JSON.stringify(state), { expirationTtl: 24 * 60 * 60 });

  const replyMarkup = {
    inline_keyboard: [[
      { text: state.button_text || '🎲 Next random media', callback_data: getRandomMediaCallbackData(token) }
    ]]
  };

  const result = await sendTelegramMedia(env, chatId, item, replyMarkup, state.caption || '');
  if (result && result.ok) {
    await answerCallbackQuery(env, callbackQuery.id, { text: 'Sent another random media item.' });
  } else {
    await answerCallbackQuery(env, callbackQuery.id, { text: 'Could not send media.', show_alert: true });
  }
}

async function answerCallbackQuery(env, callbackQueryId, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const body = {
    callback_query_id: callbackQueryId,
    ...options
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      const randomMediaItems = getRandomMediaItems(step);
      if (randomMediaItems.length > 0) {
        await sendRandomMedia(env, chatId, randomMediaItems, {
          caption: step.caption || step.message || '',
          buttonText: step.next_button_text || '🎲 Next random media'
        });
      } else {
        await sendMessage(env, chatId, step.message);
      }
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
