const ALLOWED_STEP_TYPES = new Set(['run', 'http', 'delay', 'notify']);
const MAX_STEPS = 50;
const MAX_FILE_SIZE_BYTES = 200_000; // 200 KB — plenty for a workflow definition
const CONFIRM_TTL_SECONDS = 300; // pending workflows expire after 5 minutes
const DEDUPE_TTL_SECONDS = 3600; // remember update_ids for an hour

export default {
  async fetch(request, env, ctx) {
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
        await handleConfirm(env, chatId, message.text);
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
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push('"steps" must be a non-empty array');
    return errors;
  }
  if (workflow.steps.length > MAX_STEPS) {
    errors.push(`too many steps (max ${MAX_STEPS})`);
  }
  workflow.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object' || !ALLOWED_STEP_TYPES.has(step.type)) {
      errors.push(`step ${i}: type must be one of ${[...ALLOWED_STEP_TYPES].join(', ')}`);
      return;
    }
    if (step.type === 'run' && typeof step.command !== 'string') {
      errors.push(`step ${i}: "run" needs a string "command"`);
    }
    if (step.type === 'http' && typeof step.url !== 'string') {
      errors.push(`step ${i}: "http" needs a string "url"`);
    }
    if (step.type === 'delay' && typeof step.ms !== 'number') {
      errors.push(`step ${i}: "delay" needs a numeric "ms"`);
    }
    if (step.type === 'notify' && typeof step.message !== 'string') {
      errors.push(`step ${i}: "notify" needs a string "message"`);
    }
  });
  return errors;
}

function summarizeWorkflow(workflow) {
  return workflow.steps
    .map((s, i) => {
      if (s.type === 'run') return `${i + 1}. run:    ${s.command}`;
      if (s.type === 'http') return `${i + 1}. http:   ${s.method || 'GET'} ${s.url}`;
      if (s.type === 'delay') return `${i + 1}. delay:  ${s.ms}ms`;
      if (s.type === 'notify') return `${i + 1}. notify: "${s.message}"`;
      return `${i + 1}. ${s.type}`;
    })
    .join('\n');
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

  // --- Safety net: never dispatch straight from an inbound file. Stage it
  // and require an explicit /confirm reply with a fresh, single-use token.
  // This means a forwarded chat ID, a Telegram retry, or a fat-fingered send
  // can't silently trigger arbitrary shell commands on a GitHub runner. It
  // is *not* a sandbox — see the README's security model for what it does
  // and doesn't protect against.
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
    `Received "${workflow.name}" (${workflow.steps.length} step(s)):\n\n${summary}\n\n` +
    `Reply "/confirm ${token}" within ${CONFIRM_TTL_SECONDS / 60} minutes to run it, or /cancel to discard.`
  );
}

async function handleConfirm(env, chatId, text) {
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
  await dispatchWorkflow(env, pending.workflow, chatId);
  await sendMessage(env, chatId, `Dispatched "${pending.workflow.name}" to GitHub Actions — you'll get a message when it finishes.`);
}

async function handleCancel(env, chatId) {
  await env.WORKFLOW_STATE.delete(`pending:${chatId}`);
  await sendMessage(env, chatId, 'Discarded.');
}

async function dispatchWorkflow(env, workflow, chatId) {
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
        client_payload: { payload: workflow, chat_id: chatId },
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
