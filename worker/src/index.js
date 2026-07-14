const ALLOWED_STEP_TYPES = new Set(['run', 'http', 'delay', 'notify']);
const MAX_NODES = 50;
const MAX_FILE_SIZE_BYTES = 200_000; // 200 KB — plenty for a workflow definition
const CONFIRM_TTL_SECONDS = 300; // pending workflows expire after 5 minutes
const DEDUPE_TTL_SECONDS = 3600; // remember update_ids for an hour

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
};

function validateWorkflow(workflow) {
  const errors = [];
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    errors.push('"name" must be a non-empty string');
  }

  if (!Array.isArray(workflow.nodes)) {
    errors.push('"nodes" must be an array');
    return errors;
  }
  if (workflow.nodes.length === 0) {
    errors.push('"nodes" must not be empty');
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
      nodeIds.add(node.id);
    }

    if (!ALLOWED_STEP_TYPES.has(node.type)) {
      errors.push(`node ${i}: type must be one of ${[...ALLOWED_STEP_TYPES].join(', ')}`);
      return;
    }

    if (!node.config || typeof node.config !== 'object') {
      errors.push(`node ${i}: missing or invalid "config" object`);
      return;
    }

    const { config } = node;
    if (node.type === 'run' && typeof config.command !== 'string') {
      errors.push(`node ${i}: "run" config needs a string "command"`);
    }
    if (node.type === 'http' && typeof config.url !== 'string') {
      errors.push(`node ${i}: "http" config needs a string "url"`);
    }
    if (node.type === 'delay' && typeof config.ms !== 'number') {
      errors.push(`node ${i}: "delay" config needs a numeric "ms"`);
    }
    if (node.type === 'notify' && typeof config.message !== 'string') {
      errors.push(`node ${i}: "notify" config needs a string "message"`);
    }
  });

  if (Array.isArray(workflow.edges)) {
    workflow.edges.forEach((edge, i) => {
      if (!edge || typeof edge !== 'object') {
        errors.push(`edge ${i}: must be an object`);
        return;
      }
      if (typeof edge.source !== 'string' || !nodeIds.has(edge.source)) {
        errors.push(`edge ${i}: source node "${edge.source}" does not exist`);
      }
      if (typeof edge.target !== 'string' || !nodeIds.has(edge.target)) {
        errors.push(`edge ${i}: target node "${edge.target}" does not exist`);
      }
      if (edge.sourceHandle && !['success', 'failure', 'always'].includes(edge.sourceHandle)) {
        errors.push(`edge ${i}: sourceHandle "${edge.sourceHandle}" is invalid`);
      }
    });
  } else {
    errors.push('"edges" must be an array');
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
      return env.DB.prepare(
        `INSERT INTO nodes (id, workflow_id, type, position_x, position_y, config) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        node.id,
        workflowId,
        node.type,
        node.position.x,
        node.position.y,
        JSON.stringify(node.config)
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

async function dispatchWorkflow(env, workflow, chatId, executionId, workerUrl) {
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
          worker_url: workerUrl
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
