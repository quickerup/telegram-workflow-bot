# telegram-workflow-bot

Trigger GitHub Actions workflows by sending a JSON file to a Telegram bot, with
a mandatory confirmation step and a full execution log committed back to the repo.

```
Telegram (send a .json)
   │
   ▼
Cloudflare Worker  ── validates + stages the workflow, replies with a summary
   │                   and a one-time /confirm token
   ▼  (after you reply "/confirm <token>")
GitHub Actions (repository_dispatch)  ── runs each step in order
   │
   ▼
executions/*.json  ── committed to the repo, and a final status is sent back to Telegram
```


## Manual multi-media broadcast trigger

The `Multi-Media Broadcast` workflow can be started from the GitHub Actions UI
because `.github/workflows/bot_multi_media_broadcast.yml` includes a
`workflow_dispatch` trigger. GitHub only exposes manual dispatch for workflow
files that are present on the repository's default branch, so template users must
pull the latest template workflow into their target repository's `main` branch
before trying to trigger `bot_multi_media_broadcast.yml` manually.

If Telegram reports that `Multi-Media Broadcast` cannot be triggered manually,
verify that the target repository and branch shown in the bot message contain the
current `.github/workflows/bot_multi_media_broadcast.yml` file with both
`repository_dispatch` and `workflow_dispatch` under `on:`.

## Step types

| type   | fields                                              | notes                          |
|--------|------------------------------------------------------|---------------------------------|
| run    | `command`, `timeout_ms?`, `continue_on_error?` | shell command on the runner    |
| http   | `url`, `method?`, `headers?`, `body?`, `timeout_ms?` | any HTTP call            |
| delay  | `ms` (capped at 5 min)                              | pause between steps            |
| notify | `message`                                           | sends a Telegram message       |

See `workflows/example.json` and `workflows/workflow.schema.json` (point your
editor at the schema for autocomplete). Validate locally before sending anything:

```
node scripts/validate.js workflows/example.json
```

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and note the token.
2. Create a GitHub fine-grained PAT scoped to **this repo only**, with **Contents: read and write**.
3. Push this scaffold to `quickerup/telegram-workflow-bot`.
4. `cd worker && npm install && bash deploy.sh` — this creates the KV namespace,
   sets your three secrets, deploys the Worker, and registers the Telegram webhook.
   None of it is scripted into `setup.sh` on purpose: that script never sees a
   real credential.
5. Message your bot `/whoami`, copy your chat ID into `ALLOWED_CHAT_IDS` in
   `wrangler.toml`, and `wrangler deploy` again.
6. Send a `.json` workflow file to the bot as a document, then reply with the
   `/confirm <token>` it gives you.

## Security model — read this before pointing it at anything real

A `run` step is **arbitrary remote code execution** on a GitHub-hosted runner
with your repository's permissions. That's the feature, not a bug, but it means
the blast radius of anything going wrong is "whatever your GITHUB_PAT and
Actions runner can touch." What this scaffold does to reduce risk:

- **Allowlist** (`ALLOWED_CHAT_IDS`) — only specific Telegram accounts can stage a workflow.
- **Webhook secret**, compared in constant time, so only Telegram (not randoms hitting the URL) can reach the handler.
- **Staged confirmation** — receiving a file never runs it. You get a plain-text
  summary and a random one-time token; nothing executes until you reply
  `/confirm <token>`, and it expires in 5 minutes.
- **Update-id dedup** — a Telegram webhook retry can't double-fire a dispatch or confirmation.
- **Step caps** — max 50 steps, output truncated to 4KB/step, delay capped at 5 minutes, run/http steps have timeouts.

What it does **not** protect against, on purpose left out of scope — decide if you need these before relying on this in production:

- **Compromise of your Telegram account or device.** If someone controls your
  allowlisted chat, the confirm step doesn't stop them — it's a misfire guard, not an auth boundary.
- **Sandboxing of `run` commands.** There's no allowlist of commands, no
  network egress restriction beyond what the Actions runner already has, and
  no filesystem jail. If you want that, run steps in a container image with a
  locked-down entrypoint instead of raw `execSync`.
- **Rate limiting.** Nothing currently stops an allowlisted user from
  dispatching workflows back-to-back. Add a counter in `WORKFLOW_STATE` if
  your Actions minutes or GitHub API quota need protecting.
- **Secret rotation reminders.** `TELEGRAM_BOT_TOKEN` and `GITHUB_PAT` are
  long-lived by default — rotate them periodically the same way you would any
  other high-value credential.

## Local testing without Telegram

Trigger the executor directly from the Actions tab: **Actions → Workflow
Executor → Run workflow**, pasting a workflow JSON into `payload_json`. This
exercises `scripts/executor.js` end-to-end without touching the bot at all.
