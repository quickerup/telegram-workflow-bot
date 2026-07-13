#!/usr/bin/env bash
set -euo pipefail

# Run this from inside worker/ after `npm install`.
# It creates the KV namespace, sets secrets, deploys, and registers the
# Telegram webhook. Nothing here is stored anywhere except your Cloudflare
# account and (transiently) your terminal history — clear that if you're on
# a shared machine.

command -v wrangler >/dev/null 2>&1 || {
  echo "wrangler not found. Run 'npm install' in this directory first." >&2
  exit 1
}

echo "== 1/4: KV namespace for pending-confirmation / dedupe state =="
wrangler kv namespace create WORKFLOW_STATE || true
echo
echo "Copy the 'id' printed above into wrangler.toml under [[kv_namespaces]] (id = ...)."
read -rp "Press enter once wrangler.toml has been updated: " _

echo
echo "== 2/4: Secrets (you'll be prompted individually; nothing is echoed) =="
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GITHUB_PAT

echo
echo "== 3/4: Deploying the Worker =="
wrangler deploy

echo
echo "== 4/4: Registering the Telegram webhook =="
read -rp "Deployed Worker URL (e.g. https://xxx.workers.dev): " WORKER_URL
read -rsp "Telegram bot token (same one, needed to call setWebhook): " BOT_TOKEN
echo
read -rsp "TELEGRAM_WEBHOOK_SECRET (same one you just set): " WEBHOOK_SECRET
echo

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]')

echo "$RESPONSE"
if ! echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "⚠️  setWebhook did not return ok:true — check the response above." >&2
  exit 1
fi

echo
echo "Webhook registered. Next:"
echo "  1. Message your bot: /whoami   (confirms it's alive, gives you your chat ID)"
echo "  2. Add that chat ID to ALLOWED_CHAT_IDS in wrangler.toml"
echo "  3. wrangler deploy   (to apply the allowlist change)"
echo "  4. Send a workflows/*.json file as a document to the bot and follow its /confirm prompt"
