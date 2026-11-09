/**
 * Life-OS Worker entrypoints.
 *  fetch     — Telegram webhook: commands and buttons are answered inline (no LLM); anything for
 *              the model is recorded once (update_id) and queued, and Telegram gets 200 at once.
 *  queue     — runs model turns (a batch of quick messages becomes one turn), routines, and the
 *              DeepSeek retry the owner approved. Never repeats side effects for an update.
 *  scheduled — every 5 minutes: due reminders and routines.
 * Webhook security (secret header, owner-only) follows phd-applications/bots/telegram-worker.
 */

import type { Env, Job, TgUpdate } from './env';
import { COMMANDS, handleCallback, handleCommand, parseCommand, QUEUED_COMMANDS } from './commands';
import { all, first, run } from './db';
import { continueTurn, runChatTurn } from './agent';
import { primaryProvider, providerName, ProviderUnavailable, withModelChoice } from './llm';
import { messageToBlocks } from './media';
import { recordError, routineClock, runCron, runRoutine } from './routines';
import { esc, sendHtml, sendMarkdown, tg, typing, warn } from './telegram';
import { localParts, localTime } from './time';

const DEAD_LETTER_QUEUE = 'life-os-dlq';

const isOwner = (env: Env, id: number | undefined) => id != null && String(id) === String(env.OWNER_ID).trim();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One-time: point Telegram at this Worker and register the command menu (GET /setup?secret=...). */
async function setup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.WEBHOOK_SECRET || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
  const results = [
    ['setWebhook', await tg(env, 'setWebhook', {
      url: `${url.origin}/telegram`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    })],
    ['setMyCommands', await tg(env, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) })],
    ['getWebhookInfo', await tg(env, 'getWebhookInfo', {})]
  ];
  return new Response(`Done. Open Telegram and send /start.\n\n${JSON.stringify(results, null, 2)}`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

export async function onUpdate(env: Env, update: TgUpdate, now: Date): Promise<void> {
  const query = update.callback_query;
  if (query) {
    if (isOwner(env, query.from.id)) await handleCallback(env, query, now);
    return;
  }
  const msg = update.message;
  if (!msg || !isOwner(env, msg.from?.id) || !isOwner(env, msg.chat.id)) return;

  const cmd = msg.text ? parseCommand(msg.text) : null;
  if (cmd && QUEUED_COMMANDS.has(cmd.name)) {
    const date = localParts(now, env.TIMEZONE).date;
    await env.QUEUE.send({ kind: 'routine', name: cmd.name === 'plan' ? 'day_plan' : 'weekly_review', date });
    await sendHtml(env, cmd.name === 'plan' ? '🧭 Planning your day…' : '📊 Writing your weekly review…');
    return;
  }
  if (cmd && (await handleCommand(env, cmd.name, cmd.args, now))) return;

  const inserted = await run(env.DB, "INSERT OR IGNORE INTO processed_updates (update_id, status, ts) VALUES (?, 'queued', ?)", update.update_id, now.toISOString());
  if (inserted.meta.changes) await env.QUEUE.send({ kind: 'update', update });
}

async function setStatus(env: Env, ids: number[], status: 'done' | 'failed'): Promise<void> {
  if (ids.length) await run(env.DB, `UPDATE processed_updates SET status = ? WHERE update_id IN (${ids.map(() => '?').join(', ')})`, status, ...ids);
}

async function offerFallback(env: Env, e: ProviderUnavailable): Promise<void> {
  const reason = e.reason;
  const session = await first<{ id: number }>(env.DB, 'SELECT id FROM sessions WHERE closed = 0 ORDER BY id DESC LIMIT 1');
  const what = e.tried.length > 1 ? 'No model is available' : `${providerName(e.provider)} is unavailable`;
  // DeepSeek is offered (asking first) only for Claude as the main provider, and only if it wasn't already tried.
  if (e.tried.includes('deepseek') || primaryProvider(env) !== 'claude' || !env.DEEPSEEK_API_KEY || !session) {
    await sendHtml(env, `⚡ ${what} (${esc(reason)}). Your message is saved; I'll answer it when you write again.`);
    return;
  }
  const row = await first<{ id: number }>(env.DB, 'INSERT INTO pending_fallbacks (session_id, reason, created_at) VALUES (?, ?, ?) RETURNING id',
    session.id, reason, new Date().toISOString());
  await sendHtml(env, `⚡ ${what} (${esc(reason)}).\nSend this via DeepSeek instead? That shares this conversation and your task context with DeepSeek.`, [[
    { text: '⚡ Send via DeepSeek', callback_data: `fb:yes:${row?.id}` },
    { text: '⏳ Wait for Claude', callback_data: `fb:no:${row?.id}` }
  ]]);
}

/**
 * Claim the updates (queued → running), turn their messages into one user turn, run it, reply.
 * An update already 'running' means a previous attempt died mid-way: say so instead of re-running
 * it, since its tools may already have written to the database.
 */
export async function processUpdates(env: Env, updates: TgUpdate[]): Promise<void> {
  const ids = updates.map(u => u.update_id);
  const marks = ids.map(() => '?').join(', ');
  const claimed = new Set((await all<{ update_id: number }>(env.DB,
    `UPDATE processed_updates SET status = 'running' WHERE status = 'queued' AND update_id IN (${marks}) RETURNING update_id`, ...ids)).map(r => r.update_id));
  const interrupted = updates.filter(u => !claimed.has(u.update_id));
  const stale = interrupted.length
    ? await all<{ update_id: number }>(env.DB, `SELECT update_id FROM processed_updates WHERE status = 'running' AND update_id IN (${interrupted.map(() => '?').join(', ')})`, ...interrupted.map(u => u.update_id))
    : [];
  if (stale.length) {
    await setStatus(env, stale.map(s => s.update_id), 'failed');
    const at = updates.find(u => u.update_id === stale[0]?.update_id)?.message?.date;
    await warn(env, `I couldn't finish your message${at ? ` from ${localTime(new Date(at * 1000), env.TIMEZONE)}` : ''}. Check /today, then send it again if needed.`);
  }

  const todo = updates.filter(u => claimed.has(u.update_id) && u.message).sort((a, b) => a.message!.message_id - b.message!.message_id);
  if (!todo.length) return;
  const todoIds = todo.map(u => u.update_id);
  await typing(env);
  try {
    const blocks = [];
    for (const u of todo) blocks.push(...(await messageToBlocks(env, u.message!)));
    if (blocks.length) {
      const source = todo.some(u => u.message?.voice || u.message?.audio) ? 'voice' : todo.some(u => u.message?.photo) ? 'photo' : 'chat';
      const result = await runChatTurn(env, blocks, todoIds, source);
      await sendMarkdown(env, result.reply);
    }
    await setStatus(env, todoIds, 'done');
  } catch (e) {
    if (e instanceof ProviderUnavailable) {
      await setStatus(env, todoIds, 'done');
      await offerFallback(env, e);
      return;
    }
    console.error('turn failed', e);
    await setStatus(env, todoIds, 'failed');
    await recordError(env, `turn: ${message(e)}`);
    await warn(env, `Something went wrong with that message: ${message(e).slice(0, 300)}`);
  }
}

async function runFallback(env: Env, id: number): Promise<void> {
  const row = await first<{ session_id: number }>(env.DB, 'SELECT session_id FROM pending_fallbacks WHERE id = ?', id);
  if (!row) return;
  await typing(env);
  try {
    const result = await continueTurn(env, row.session_id, 'deepseek');
    await sendMarkdown(env, result ? result.reply : 'That message was already answered. 🙂');
  } catch (e) {
    console.error('deepseek failed', e);
    await recordError(env, `deepseek: ${message(e)}`);
    await warn(env, `DeepSeek failed too (${message(e).slice(0, 200)}). Your message is saved; try again later.`);
  }
}

async function runJob(env: Env, job: Exclude<Job, { kind: 'update' }>): Promise<void> {
  try {
    if (job.kind === 'fallback') await runFallback(env, job.id);
    else await runRoutine(env, job.name, job.name === 'day_plan' ? new Date() : routineClock(job.date, env.TIMEZONE));
  } catch (e) {
    if (e instanceof ProviderUnavailable && job.kind === 'routine' && job.name === 'day_plan') {
      await offerFallback(env, e);
      return;
    }
    console.error(`job ${job.kind} failed`, e);
    const what = job.kind === 'routine' ? job.name.replace('_', ' ') : 'DeepSeek retry';
    await recordError(env, `${what}: ${message(e)}`);
    await warn(env, `The ${what} failed: ${message(e).slice(0, 300)}`);
  }
}

async function onDeadLetter(env: Env, job: Job): Promise<void> {
  if (job.kind === 'update') {
    await setStatus(env, [job.update.update_id], 'failed');
    const at = job.update.message?.date;
    await warn(env, `Your message${at ? ` from ${localTime(new Date(at * 1000), env.TIMEZONE)}` : ''} couldn't be processed. Please send it again.`);
  } else {
    await warn(env, `A background job (${job.kind === 'routine' ? job.name : 'DeepSeek retry'}) failed twice and was dropped.`);
  }
}

export default {
  async fetch(request: Request, rawEnv: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/setup' && request.method === 'GET') return setup(request, rawEnv);
    if (url.pathname === '/' && request.method === 'GET') return new Response('life-os-bot ok');
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!rawEnv.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== rawEnv.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    const update = (await request.json().catch(() => null)) as TgUpdate | null;
    if (update?.update_id != null) {
      const env = await withModelChoice(rawEnv);
      try {
        await onUpdate(env, update, new Date());
      } catch (e) {
        // Always 200: a non-200 makes Telegram re-send the update.
        console.error('update failed', e);
        await recordError(env, `webhook: ${message(e)}`);
        await warn(env, `Something went wrong: ${message(e).slice(0, 300)}`);
      }
    }
    return new Response('ok');
  },

  async queue(batch: MessageBatch<Job>, rawEnv: Env): Promise<void> {
    const env = await withModelChoice(rawEnv);
    if (batch.queue === DEAD_LETTER_QUEUE) {
      for (const m of batch.messages) await onDeadLetter(env, m.body).catch(e => console.error('dlq', e));
      batch.ackAll();
      return;
    }
    const updates = batch.messages.map(m => m.body).filter((j): j is Extract<Job, { kind: 'update' }> => j.kind === 'update').map(j => j.update);
    if (updates.length) await processUpdates(env, updates);
    for (const m of batch.messages) {
      if (m.body.kind !== 'update') await runJob(env, m.body);
    }
    batch.ackAll();
  },

  async scheduled(_controller: ScheduledController, rawEnv: Env): Promise<void> {
    const env = await withModelChoice(rawEnv);
    try {
      await runCron(env);
    } catch (e) {
      console.error('cron failed', e);
      await recordError(env, `cron: ${message(e)}`);
      await warn(env, `The scheduler failed: ${message(e).slice(0, 300)}`);
    }
  }
} satisfies ExportedHandler<Env, Job>;

