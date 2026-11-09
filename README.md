# Life-OS: personal assistant on Telegram

Talk to it by **text, voice note (English or Persian) or photo**. It keeps your tasks, reminders and progress, sends a morning brief and an evening check-in, writes a weekly review, and exports everything to your Obsidian vault each night.

- **Provider:** set `PROVIDER` in `wrangler.toml`, then `npx wrangler deploy`.
  - `deepseek` (the default): DeepSeek Flash for chat and photos, DeepSeek V4 Pro for the morning brief and weekly review.
  - `claude`: Claude Haiku 5.5 for chat and Claude Opus 5.5 for routines.
  - `opencode`: your OpenCode Go subscription, with `OPENCODE_MODEL` (default `claude-haiku-5-5`; any Go model id works, e.g. `kimi-k3`, `glm-5.3`, `qwen3.8-max`).
- **Automatic fallback:** `FALLBACK_PROVIDERS` (default `"opencode"`) lists providers tried in order when the main one is down, rate limited, over its usage limit or out of credit. The answer is tagged with the provider that wrote it, and a failing provider is skipped for 10 minutes. Providers without an API key are skipped. With no fallbacks and `PROVIDER = "claude"`, the bot *asks you* before sending a message to DeepSeek.
- **Switch from Telegram:** `/model opencode kimi-k3`, `/model deepseek`, `/model claude`, `/model reset` (back to `wrangler.toml`). No deploy needed.
- **Hosting:** everything runs on free tiers: a Cloudflare Worker, D1 (SQLite), Queues, Workers AI (Whisper), and GitHub for vault files and backups.

```
Telegram → Worker /telegram ─┬─ /commands + buttons: answered at once (database only, no AI)
                             └─ text / voice / photo → queue → Whisper / vision → DeepSeek or Claude + tools ⇄ D1
cron every 5 min → reminders now; brief, check-in, review, vault export, backup via the queue
```

## Cost

Rough estimates for about 30 messages a day:

| Item | DeepSeek (`PROVIDER = "deepseek"`) | Claude (`PROVIDER = "claude"`) |
|---|---|---|
| Chat | ≈ $0.003 per message (Flash) | ≈ $0.003 per message (Haiku) |
| Routines | ≈ $1 (V4 Pro) | ≈ $3–5 (Opus) |
| **Total** | **≈ $3–5**, from your DeepSeek balance; off-peak hours (Beijing time) cost half | **≈ $6–8**, pay-as-you-go API credits |

- `/status` shows the provider and this month's spend (an estimate; DeepSeek is counted at peak prices).
- `MONTHLY_CAP_USD` in `wrangler.toml` (default $40) is a soft cap: past it, routines switch to Haiku and you get one message about it.
- On Claude, also set a **hard spend limit** on the Console workspace (step 2 below). DeepSeek is prepaid, so it simply stops at zero balance.

## One-time setup (about 90 minutes, PowerShell on the laptop)

1. **Telegram bot.** In Telegram, open **@BotFather**, send `/newbot`, and copy the token.
   - This must be a *new* bot: the PhD finder's bot already uses its own webhook.
   - Send any message to **@userinfobot**; it replies with your user id.

2. **Claude API credits and key** (only for `PROVIDER = "claude"`; skip it on DeepSeek).
   1. On claude.ai, go to **Settings → Billing → API credits** and link a Console organization. Credits then arrive monthly; no card is needed.
   2. In the Console (platform.claude.com), create a workspace **life-os**.
   3. Set the workspace's spend limit (e.g. $40/month).
   4. Create an API key *in that workspace*.

3. **DeepSeek key** (required for `PROVIDER = "deepseek"`; on Claude it's the optional fallback). Create it at platform.deepseek.com.

   **OpenCode Go key** (for `PROVIDER` or `FALLBACK_PROVIDERS` = `"opencode"`). Subscribe to Go and create an API key at opencode.ai/console. Model ids and their monthly limits are listed at opencode.ai/docs/go. Go is a flat subscription, so its calls count $0 toward the soft cap.

4. **GitHub token for the vault and backups** (optional at first; the vault export and backup are skipped without it).
   - Go to GitHub → Settings → Developer settings → **Fine-grained tokens**.
   - Repositories: `myBlog1` and `MyLife_OS`. Permissions → **Contents: Read and write**.
   - If your vault's branch isn't `main`, change `VAULT_BRANCH` in `wrangler.toml`.

5. **Deploy the Worker.** Use the same Cloudflare account as `phd-hunter-bot`:
   ```powershell
   cd LifeOS
   npm install
   npx wrangler login
   npx wrangler d1 create life_os          # paste the printed database_id into wrangler.toml
   npx wrangler queues create life-os-inbox
   npx wrangler queues create life-os-dlq
   npm run db:migrate
   npx wrangler secret put TELEGRAM_BOT_TOKEN   # from step 1
   npx wrangler secret put OWNER_ID             # your user id from @userinfobot
   npx wrangler secret put DEEPSEEK_API_KEY     # from step 3
   npx wrangler secret put ANTHROPIC_API_KEY    # from step 2 (only if you use Claude)
   npx wrangler secret put OPENCODE_API_KEY     # from step 3 (only if you use OpenCode Go)
   npx wrangler secret put GITHUB_TOKEN         # from step 4 (optional)
   [guid]::NewGuid().ToString('N')              # prints a random string; copy it
   npx wrangler secret put WEBHOOK_SECRET       # paste that string
   npx wrangler deploy
   ```

6. **Connect Telegram.** Open `https://life-os-bot.<you>.workers.dev/setup?secret=<the random string>` once in a browser; it should say `Done`. Then send `/start` to your bot.

7. **Tell it about your life** in the first chat. For example:
   - *"Remember: I do MMS client calls 15:00–16:30 on weekdays. Mimmo is my web client. My lab contract is at INT."*
   - `/areas phd lab mms mimmo health admin personal` sets the areas your tasks are grouped by.

## Daily use

- **Just talk:** "remind me to call Mimmo tomorrow at 10", "done with the SOP draft", a voice note on the way home, or a photo of a handwritten list.
- **Voice notes:** the bot first echoes `🎙 heard: …` so you can catch recognition mistakes.
- **Buttons:** tasks and reminders come with ✅ Done · ⏰ +1h · 📅 Tomorrow · 🗑 Drop.

| Command | What you get |
|---|---|
| `/today` | Overdue, due today, today's reminders, next up, plus ✅ buttons for the top 3 |
| `/tasks` (`/tasks phd`) | Open tasks by area |
| `/T12` | One task with its buttons |
| `/week` | Progress bars per area, check-ins, mood |
| `/plan` | AI day plan: three priorities with a first step each |
| `/review` | Weekly review now |
| `/routine` | Routine times; `/routine morning 07:30`, `/routine checkin off` |
| `/quiet 3d` | Pause the brief and check-in for 3 days (`/quiet off` resumes); reminders still come |
| `/areas` | Show or set your life areas |
| `/undo` | Shows the last task, reminder, log or memory change and reverts it after you confirm (routine and setting changes are changed back directly) |
| `/new` | Start a fresh conversation (your data stays) |
| `/model` | Shows the current model with tap-to-switch buttons for every OpenCode Go model (with its monthly allowance), DeepSeek, Claude and reset. Typed form: `/model opencode kimi-k3`, `/model deepseek`, `/model reset` |
| `/status` | Provider, models, fallbacks, spend this month, last cron run, last error |

### Routines (Europe/Rome; change them with `/routine` or just ask)

| Routine | Default time | What happens |
|---|---|---|
| `morning_brief` | 08:00 weekdays | The routine model picks your Top 3 with first steps and lists fixed blocks. If the provider is down you get a template brief instead |
| `evening_checkin` | 21:30 | "What got done, blockers, mood 1–5?" Answer by voice: it logs everything, ticks off tasks, and moves leftovers to tomorrow |
| `weekly_review` | Sun 18:00 | A review per area by the routine model, sent to Telegram and saved to the vault |
| `vault_export` | 23:30 | One commit to `myBlog1` |
| `backup` | Sun 03:00 | The D1 data as JSON, committed to the `backups` branch of this repo |

A routine whose time passes while the Worker is down still runs once that day. The brief and check-in only catch up within 3 hours.

## Your vault

The bot only writes these files, each marked `generated: life-os` in its frontmatter:

- `Assistant/TASKS.md`
- `TimeLine/<year>/<MM - Month>/<YYMMDD> - life-os log.md`
- `Assistant/Reviews/<YYYY-Www>.md`

It never overwrites a note without that marker, so your own notes are safe. Obsidian Git pulls the exports like any other commit. It can also *read* your notes when you ask ("what did I plan in last week's review?").

## Privacy

- Your data lives in your Cloudflare D1 database and your private GitHub repos.
- With `PROVIDER = "deepseek"`, messages, photos and routine data go to DeepSeek's API.
- With `PROVIDER = "claude"`, they go to Anthropic's API, and to DeepSeek only after you tap **Send via DeepSeek** on a specific message (unless DeepSeek is in `FALLBACK_PROVIDERS`). Routines never use DeepSeek then.
- With `PROVIDER = "opencode"`, or when a provider in `FALLBACK_PROVIDERS` answers, they go to that provider's API without asking. OpenCode Go forwards them to the model's vendor.
- Forwarded messages, text read from photos, and vault notes are treated as data, never as instructions.
- Changes to tasks, reminders, logs and memory are logged, and `/undo` reverts them after you confirm.

## Limits worth knowing

- **Workers Free CPU:** 10 ms of CPU per request (waiting on the network doesn't count). After the first week, check *Workers → life-os-bot → Metrics → CPU time*.
  - If you see `Error 1102` or the p95 is above ~8 ms, switch to Workers Paid ($5/month) rather than trimming features.
- **Telegram limits:** bots can download files up to 20 MB. Photos over 5 MB and non-image documents aren't read yet.
- **Workers AI free tier:** about 3.5 hours of transcription a day.

## Backups and restore

```powershell
git fetch origin backups; git checkout origin/backups -- backups/2026-11-08.json
node scripts/restore-backup.mjs backups/2026-11-08.json > restore.sql
npx wrangler d1 execute life_os --remote --file restore.sql
```

D1 also keeps 7 days of point-in-time restore on the free plan (`npx wrangler d1 time-travel`).

## Development

```powershell
npm test               # vitest in the Workers runtime with a local D1 (no network)
npm run typecheck
copy .dev.vars.example .dev.vars   # then fill in test values
npm run db:migrate:local
npx wrangler dev --test-scheduled  # cron: curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

- **Changing the prompt or tools:** `src/prompts.ts` holds the system prompt and `src/tools.ts` the tools.
  - Any change there (or to `CHAT_MODEL`) starts a fresh conversation after the deploy. This is deliberate: it keeps the replayed history valid.
- **Code layout:**

| File | What it does |
|---|---|
| `src/index.ts` | Webhook, queue consumer, cron entrypoints |
| `src/agent.ts` | Sessions, snapshot, append-only tool loop |
| `src/llm.ts` | Claude, DeepSeek and OpenCode Go calls, automatic fallback, `/model` choice, circuit breaker, cost |
| `src/tools.ts` | What the model can do |
| `src/commands.ts` | Slash commands and buttons |
| `src/routines.ts` | Reminders, brief, check-in, review, export, backup |
| `src/media.ts` | Voice and photo → text |
| `src/telegram.ts` | Telegram API, Markdown → HTML, splitting, RTL |
| `src/github.ts` | Vault and backup commits |
| `src/time.ts` | DST-safe local time |
