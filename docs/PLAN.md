# Life-OS: a personal Telegram assistant (Claude API, DeepSeek on request)

## Context

Mehrshad wants a personal assistant on Telegram that acts as the "OS of his life". It captures tasks and progress by **text, voice (English + Persian) or photo**, reminds him, runs daily and weekly rhythms, and shows progress per life area: PhD applications, lab contract, MMS web-design calls, the Mimmo client project, health, and admin.

It is paid from the **$100/month API credits included with his Max plan**. He claims them by linking a Console org in claude.ai → Settings → Billing. **DeepSeek** (existing credits) is a fallback he approves case by case.

The build follows his PhD finder (`MehrshadAlipoor/phd-applications`): a Cloudflare Worker webhook bot on free infrastructure, kept simple and well engineered. Tasks live in the bot's database. His Obsidian vault (`myBlog1` on GitHub, synced by Obsidian Git) receives human-readable exports.

**Inspiration.** The "Solo Business Course" artifact turned out to be a video-lesson production spec. What carries over is its structure:
- a fixed sequence every day: brief → one action → checklist → close;
- short IDs: `/T12`, like the PhD bot's `/P0012`;
- status semantics: ✅ done / 🟡 in progress / 🟠 slipping;
- "real data only": progress comes from logged data, never invented;
- minimal notifications.

**Decisions made:**
- New private repo for the code.
- Vault = GitHub repo + Obsidian Git.
- The bot's database is the source of truth; the vault gets exports.
- Languages: English + Persian.
- **Claude Haiku 5.5 for chat, Claude Opus 5.5 for routines.**
- **The DeepSeek fallback asks him each time.**

## Architecture (all free tier)

```
Telegram ─webhook─▶ Worker fetch (/telegram)  — check secret header, owner from.id + chat.id
   ├─ /commands + ✅⏰🗑 buttons ─▶ handled right here (D1 only, no LLM, instant)
   └─ text / voice / photo ─▶ record update_id (status=queued) ─▶ Cloudflare Queue
                                   ▼
        Queue consumer (batch ≤10, 2 s window, concurrency 1, max_retries 1, DLQ)
          merge the batch into ONE user turn (quick multi-messages, albums)
          voice → Workers AI Whisper → text;  photo → one Haiku vision call → text
          agent loop: Haiku 5.5 + tools ⇄ D1  ─(Claude fails)─▶ "Send via DeepSeek?" button
Cron */5 ─▶ scheduled: claim due reminders/routines (atomic UPDATE…RETURNING) ─▶ enqueue
Routines (morning brief, weekly review) = one-shot Opus 5.5 calls; template fallback with no LLM
Nightly ─▶ lean GitHub commit to myBlog1: Assistant/TASKS.md + "YYMMDD - life-os log.md"
Weekly  ─▶ D1 JSON backup committed to life-os-bot
```

- **Runtime:** a Cloudflare Worker in TypeScript, with `nodejs_compat` on (for `Buffer`) and `[observability]` enabled. It uses the same Cloudflare account as `phd-hunter-bot`.
- **Queue:** Queues are on the Workers Free plan since 2026-02-04 (10k operations/day ≈ 3.3k messages; 24 h retention). The consumer gets a 15-minute wall time, whereas `waitUntil` gets only about 30 s.
- **Database:** D1 (SQLite). Supabase was rejected because free projects pause after 7 days idle.
- **Media becomes text before it reaches the conversation:**
  - **Voice:** Workers AI `@cf/openai/whisper-large-v3-turbo` (about 214 free minutes/day). Encode with `Buffer`, never a JS loop. Auto-detect the language; if the result is neither en nor fa, re-run with `language:"fa"`. The proper-noun hint list is mixed EN/FA. The bot echoes "🎙 heard: …" so he can correct it.
  - **Photo:** the largest Telegram size ≤1280 px is sent as base64 to one Haiku vision call ("transcribe or describe; extract any to-do items"). Only the resulting text enters the session.
  - **Files over 20 MB** (the Telegram `getFile` limit) and non-image documents get a polite "not supported yet".
  - This approach needs no Files API, keeps images out of replayed history, and lets the DeepSeek path work with photos too.

## LLM layer (`src/llm.ts`)

**Models (variables, so he can change them):**
- `CHAT_MODEL=claude-haiku-5-5`, effort `low`, adaptive thinking. Haiku 5.5 costs $0.10/$0.50 per MTok (prompts under 100K).
- `ROUTINE_MODEL=claude-opus-5-5`: effort `medium` for the morning brief and `high` for the weekly review, with server-side refusal `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- Effort stays fixed within a session, because changing it would restart the cache.

**Expected cost:** about $0.003 per chat message plus about $3–5/month for the routines, so roughly **$5–10/month**, far below $100.
- The `usage` table records input, output, **cache-write** and cache-read tokens, plus dollars per call.
- A **month-to-date soft cap** (`MONTHLY_CAP_USD`, default 40) moves routines to Haiku and tells him once.
- A Console workspace "life-os" with a hard spend limit backs this up.

**Client settings:**
- SDK: `@anthropic-ai/sdk`.
- Timeouts: 45 s for chat, 120 s for routines.
- Retries: only on 429/529, once. No retry on timeouts.
- **Circuit breaker:** after 2 failures in 10 minutes, Claude is marked down for 10 minutes. The breaker state is stored in D1.

**Fallback is opt-in each time:**
- **When it offers DeepSeek:** a Claude failure (connection, timeout, 429/5xx/529 after the retry, auth error, or "credit balance too low") triggers the reply *"Claude is unavailable (reason). Send via DeepSeek?"* with buttons [Send via DeepSeek] [Retry later].
- **When it doesn't:** any other 400 never offers DeepSeek; it reports ⚠️ instead, so bugs stay visible.
- **On approval:** the pending turn runs on `new Anthropic({ baseURL: "https://api.deepseek.com/anthropic" })`, model `deepseek-v4-flash`.
- **Sanitiser:** it drops `thinking`, `output_config`, `fallbacks`/betas, `cache_control` and `strict`, and strips thinking blocks from the history.
- **Finish on one provider:** once a turn has switched, it finishes on DeepSeek.
- **Storage:** DeepSeek turns are stored **without** thinking blocks, so Claude never receives a foreign signature.
- **Footer:** replies end with a `⚡ DeepSeek` footer.
- **Routines never use DeepSeek.** If Opus fails, they send a **template brief** built from the `/today` data.

## Conversation design (preserved thinking + cache friendly)

- **Sessions:**
  - A new session starts after **3 h idle**, at 04:00 local, on `/new`, or when the history passes about **40k tokens**. The last case seeds the new session with a short summary.
  - Each session row stores a **hash of system + tools + model**. If a deploy or a settings change alters that hash, a new session starts automatically, so no stale thinking blocks are replayed.
- **Append-only history:** each turn's full `content`, thinking included, is stored verbatim in `turns` and replayed unchanged.
  - Production requests send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`) and log any `input_transformations` (degrade, don't fail).
  - Tests use `"error"`, plus a check that request N is a byte-exact prefix of request N+1.
- **Stable vs volatile:**
  - `system` and `tools` stay byte-stable: persona, rules, a deterministic tool list. The **areas list is not** in `system`; it lives in the snapshot.
  - Volatile context goes into the user turn: a `[Mon 2 Nov 2026 15:04 Europe/Rome]` prefix.
  - The first turn of a session also carries a snapshot: open and overdue tasks, today's reminders, areas, memory facts, the latest check-in, and any routine messages sent since (e.g. the 08:00 brief text). Opus output therefore never enters the Haiku session as an assistant turn.
- **Untrusted input:** forwarded messages, photo transcriptions and vault notes are wrapped as `<untrusted source="…">` data. The system prompt says that data is never treated as instructions.

## Tools (about 9, strict schemas, `tool_choice: auto`; blast radius = his own D1 + bot-owned vault files)

| Tool | Purpose |
|---|---|
| `add_task` / `update_task` | create; edit title, area, due (local date/time), priority, status (`open`, `waiting`, `done`, `dropped`) |
| `list_tasks` | filter: today, overdue, area, waiting, all_open |
| `log_entry` | progress, win, blocker, mood (1–5), habit, note; optional area and value |
| `set_reminder` / `cancel_reminder` | local time plus repeat (none, daily, weekdays, weekly); the server converts to UTC |
| `get_progress` | done counts, streaks and logs per area for today, week or month |
| `remember` | long-term facts (people, preferences) |
| `update_routine` | change routine times, or pause them ("quiet 3 days") |
| `read_vault_note` (phase 3) | read a note from `myBlog1` through the GitHub API (wrapped as untrusted) |

The tool loop is capped at 6 rounds. Tool errors return as `is_error: true`.

**Undo safety:**
- Deletes are soft.
- Every write is appended to a `changes` log.
- `/undo` reverts his last change.

## Commands and buttons (handled in `fetch`, no LLM, work even when the LLM is down)

**Commands:**
- `/today`: agenda.
- `/tasks`.
- `/week`: progress as text bars, e.g. `phd ▇▇▇▇░░ 4/6`.
- `/new`.
- `/undo`.
- `/routine morning 07:30`.
- `/quiet 3d`.
- `/status`: model, month-to-date $ against the cap, last cron run, last error, Claude breaker state.

**LLM commands (queued):** `/plan` (Haiku day plan) and `/review` (runs the Opus weekly review now).

**Task lines** end with the ID, e.g. `… /T12`, and with Persian text start with U+200F so they render right-to-left. Buttons: ✅ Done · ⏰ +1h / Tomorrow · 🗑 Drop. Taps call `answerCallbackQuery` immediately.

## Daily rhythm

Times are Europe/Rome and editable.

| When | What |
|---|---|
| 08:00 weekdays | **Morning brief** (Opus): top 3 tasks, fixed blocks (e.g. 15:00–16:30 MMS calls), one focus question, checklist buttons |
| Reminders | When due (5-minute resolution) |
| 21:30 daily | **Evening check-in** (template question, no LLM). His voice reply goes to Haiku, which logs it, completes tasks and moves leftovers to tomorrow |
| Sun 18:00 | **Weekly review** (Opus): progress per area, wins and slips, next week's top 3 per area; sent to Telegram and written to the vault |
| 23:30 daily | **Vault export** (one commit) |
| Sun 03:00 | **D1 backup** (JSON dump committed to `life-os-bot/backups/`) |

**Scheduling rules:**
- A routine fires when local time is past its target **and** `last_run_date` is before today, so a late or skipped cron still fires once.
- Repeating reminders store local `HH:MM` plus the rule. The next UTC time is computed with `Intl` (DST-safe), never by adding 24 h.
- Every job is claimed with an atomic `UPDATE … WHERE status='pending' … RETURNING`.

## Reliability and idempotency

- **Webhook dedupe:** `processed_updates(update_id, status: queued|running|done|failed)`.
- **Consumer error handling:** the consumer catches every error itself, acks the message, and sends a short ⚠️ to the owner.
- **No duplicated side effects:** if turns already exist for that update, it never re-runs the turn; it sends "couldn't finish your 14:02 message" instead.
- **Retries:** `max_retries: 1`, plus a dead-letter queue whose handler only notifies him.
- **Cron failures** also ⚠️ him, and show in `/status`.
- **Telegram output:**
  - Claude's Markdown is converted to a safe Telegram-HTML subset (bold, italic, code, links, lists; headings become bold; tables become code blocks).
  - On a "can't parse entities" 400 the bot resends as plain text.
  - Long replies split at paragraph breaks below about 3,500 characters.
- **CPU (10 ms on Free; network waits don't count):** parse the history once per invocation and watch `cpuTime` in observability during week 1. **Decision rule:** if p95 is above about 8 ms, move to Workers Paid ($5/month) rather than contort the code.

## Vault export (`src/github.ts`)

- **Lean commit:** get the ref, `POST /git/trees` with `base_tree` and inline `content`, create the commit, update the ref. Ported from the `gh()` helper in `phd-applications/scripts/lib/github-store.mjs` (User-Agent, `cache:'no-store'`, error mapping).
- **Not reused:** `loadSnapshot`/`commitWith`, which download the whole vault tree.
- **Files the bot writes:**
  - `Assistant/TASKS.md`;
  - `TimeLine/YYYY/MM - Month/YYMMDD - life-os log.md` (a suffix distinct from his own notes);
  - `Assistant/Reviews/YYYY-Www.md`.
- **Write guard:** it only overwrites files with frontmatter `generated: life-os`, and the server builds every path (the model never supplies one).

## Data model (`migrations/0001_init.sql`)

- `tasks`(id, title, notes, area, status, priority, due_date, due_time, created_at, done_at, deleted_at, source)
- `logs`(id, ts, date, kind, text, area, value)
- `reminders`(id, text, next_due_utc, local_time, repeat, status, task_id)
- `routines`(name, local_time, days, enabled, quiet_until, last_run_date)
- `memory`(id, fact, created_at, deleted_at)
- `sessions`(id, started_at, last_active_at, config_hash, token_estimate, summary)
- `turns`(id, session_id, seq, role, content_json, provider, update_ids, created_at)
- `processed_updates`(update_id PK, status, ts)
- `pending_fallbacks`(id, session_id, payload_json, created_at)
- `changes`(id, ts, entity, entity_id, before_json, after_json)
- `usage`(id, ts, provider, model, kind, input, output, cache_write, cache_read, usd)
- `state`(key PK, value) — breaker, cap notice, last cron, last error

Areas: `phd`, `lab`, `mms`, `mimmo`, `health`, `admin`, `personal`. They are stored in `state` and editable.

## Repo layout: new private repo `MehrshadAlipoor/life-os-bot`

```
wrangler.toml          # D1, Queue (+DLQ), AI bindings; cron */5; nodejs_compat; observability; vars
package.json, tsconfig.json, vitest.config.ts
migrations/0001_init.sql
src/index.ts           # fetch (webhook, /setup, commands, buttons) · queue · scheduled
src/telegram.ts        # API wrapper, md→HTML, split, RTL, keyboards, getFile
src/llm.ts             # Claude (chat/routine), breaker, DeepSeek sanitiser, usage $
src/agent.ts           # sessions, snapshot, tool loop, append-only persistence
src/prompts.ts         # static system prompt, routine prompts, templates
src/tools.ts           # tool schemas + handlers
src/media.ts           # Whisper, photo → text
src/commands.ts        # slash commands + callbacks (pure formatters, testable)
src/routines.ts        # due-claiming, brief/check-in/review, export, backup
src/db.ts, src/github.ts, src/time.ts
test/*.test.ts
README.md              # setup guide in the style of phd-applications/bots/telegram-worker/README.md
```

**Ported from `phd-applications/bots/telegram-worker/worker.mjs`:**
- the `telegram()` helper;
- the `/setup` route (`setWebhook` with `secret_token` and `allowed_updates`, `setMyCommands`);
- the secret-header check;
- the owner allowlist;
- `localDate()`.

## Build phases

Between phases there is one week of real use: check `/status` for cost and CPU before moving on.

0. **Setup (him, about 90 min; guided by README).**
   - Create a new bot in @BotFather.
   - Claim the Max API credits, create a "life-os" workspace with a spend limit, and make an API key.
   - Get a DeepSeek key.
   - Create a fine-grained GitHub token: `myBlog1` contents read/write, `life-os-bot` contents read/write.
   - Create the empty private repo `life-os-bot` and install the Claude GitHub App on it, so it can be attached to the session for pushing.
   - Run `wrangler d1 create`, `wrangler queues create` (main + DLQ), and `wrangler secret put` ×6.
1. **MVP: text + voice.**
   - Build: webhook → queue → Haiku agent with the task, log, reminder and remember tools; voice; `/today`, `/tasks`, `/new`, `/undo`, `/status`; buttons; reminder cron; the DeepSeek ask-flow; the ⚠️ error path.
   - *Done when* a Persian voice note "remind me to call Mimmo tomorrow at 10" arrives at 10:00 and shows in `/today`.
2. **Photos and rhythms.**
   - Build: photo → text; morning brief (Opus) with the template fallback; evening check-in; `/routine`, `/quiet`, `/plan`; `get_progress` and `/week`.
3. **Vault and review.**
   - Build: nightly export, `read_vault_note`, the Sunday weekly review note, the D1 backup.
   - *Done when* the export commit lands and Obsidian Git pulls it cleanly.
4. **Later, if wanted:** a Telegram Mini App dashboard (use the dataviz skill), a PhD-tracker link, goals, calendar.

**Out of scope:** email or calendar actions, multiple users, embeddings or RAG.

## Verification

- **Unit tests** (`vitest` + `@cloudflare/vitest-pool-workers`, local D1):
  - DST math (2026-03-29, 2026-10-25), the routine "fire once if late" rule, reminder repeats;
  - command formatters and RTL;
  - md→HTML and splitting;
  - tool handlers, soft delete and `/undo`;
  - the DeepSeek sanitiser (no thinking, `strict` or `cache_control` left);
  - the append-only prefix property (request N is a byte prefix of N+1) and the config-hash session reset;
  - idempotency: a replayed queue message never duplicates tasks or replies;
  - the breaker and the ask-fallback flow, with mocked fetch returning 529, then "credit balance too low".
- **Local:**
  - `wrangler dev` plus `curl` with fake Telegram updates: wrong secret → 403; a foreign `from.id` is ignored; 3 rapid messages → 1 reply.
  - `wrangler dev --test-scheduled` with `/__scheduled` to fire routines and reminders.
- **Live checklist:**
  1. Text task.
  2. Persian voice note.
  3. Photo of a handwritten list.
  4. Reminder on time.
  5. ✅ / ⏰ buttons.
  6. A bad `ANTHROPIC_API_KEY` → the "Send via DeepSeek?" prompt appears, and the reply carries the footer.
  7. Morning brief at 08:00, and the template version when Opus is forced to fail.
  8. The 21:30 check-in by voice.
  9. The nightly vault commit.
  10. `/status` shows the month's cost and CPU looks healthy in the Cloudflare dashboard.
