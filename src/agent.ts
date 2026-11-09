/**
 * The chat agent. One session = a run of conversation (new after 3 h idle, at 04:00, on /new, past
 * ~40k tokens, or when the prompt/tools/model change). Turns are append-only and replayed verbatim,
 * thinking blocks included: nothing already sent is ever edited, so the prompt cache and the
 * thinking-block binding stay valid. Volatile context (time, snapshot, bot messages) rides in the
 * new user turn, never in the system prompt.
 */

import type { BetaContentBlockParam, BetaMessageParam, BetaTextBlockParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Env } from './env';
import { activeTasks, all, first, getAreas, getState, memoryFacts, outboxAfter, pendingReminders, run } from './db';
import type { OutboxRow } from './db';
import { callWithFallback, chatModel, chatModelFor, primaryProvider, providerChain, providerName, textOf } from './llm';
import type { LlmRequest, Provider } from './llm';
import { SUMMARY_PROMPT, SYSTEM_PROMPT } from './prompts';
import { recentLogs, reminderLine, runTool, taskLine, TOOLS } from './tools';
import { addDays, localParts, localTime, stamp } from './time';

export const IDLE_MS = 3 * 3600_000;
export const DAY_START_HOUR = 4;
export const MAX_SESSION_TOKENS = 40_000;
export const MAX_ROUNDS = 6;

export interface Session {
  id: number;
  started_at: string;
  last_active_at: string;
  config_hash: string;
  token_estimate: number;
  last_outbox_id: number;
  closed: number;
  summary: string | null;
}

export interface TurnResult {
  reply: string;
  provider: Provider;
  sessionId: number;
}

export async function configHash(model: string, provider: Provider = 'claude'): Promise<string> {
  // The provider joins the hash only when it isn't Claude, so existing Claude sessions keep their hash.
  const data = new TextEncoder().encode(JSON.stringify({ system: SYSTEM_PROMPT, tools: TOOLS, model, ...(provider === 'claude' ? {} : { provider }) }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The "day" a moment belongs to; days start at 04:00 so a 00:30 reply still belongs to yesterday. */
function dayKey(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return p.hour < DAY_START_HOUR ? addDays(p.date, -1) : p.date;
}

/** Why the open session can't continue, or null if it can. */
export function sessionEndReason(s: Session, now: Date, hash: string, tz: string): 'config' | 'idle' | 'day' | 'size' | null {
  const last = new Date(s.last_active_at);
  if (s.config_hash !== hash) return 'config';
  if (now.getTime() - last.getTime() > IDLE_MS) return 'idle';
  if (dayKey(last, tz) !== dayKey(now, tz)) return 'day';
  if (s.token_estimate > MAX_SESSION_TOKENS) return 'size';
  return null;
}

export async function loadMessages(env: Env, sessionId: number): Promise<BetaMessageParam[]> {
  const rows = await all<{ role: 'user' | 'assistant'; content_json: string }>(env.DB, 'SELECT role, content_json FROM turns WHERE session_id = ? ORDER BY id', sessionId);
  return rows.map(r => ({ role: r.role, content: JSON.parse(r.content_json) as BetaContentBlockParam[] }));
}

function turnInsert(env: Env, sessionId: number, role: 'user' | 'assistant', content: BetaContentBlockParam[], provider: Provider, updateIds: number[] = []): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO turns (session_id, role, content_json, provider, update_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(sessionId, role, JSON.stringify(content), provider, updateIds.length ? JSON.stringify(updateIds) : null, new Date().toISOString());
}

/** Close the open session (if any), e.g. for /new. */
export async function closeSession(env: Env): Promise<void> {
  await run(env.DB, 'UPDATE sessions SET closed = 1 WHERE closed = 0');
}

async function summarize(env: Env, sessionId: number): Promise<string | null> {
  const messages = await loadMessages(env, sessionId);
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'Mehrshad' : 'Assistant'}: ${textOf(m.content as BetaContentBlockParam[])}`)
    .filter(line => !line.endsWith(': '))
    .join('\n')
    .slice(-60_000);
  if (!transcript) return null;
  try {
    const res = await callWithFallback(env, {
      kind: 'summary',
      model: chatModel(env),
      effort: 'low',
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 1024,
      timeoutMs: 45_000
    });
    return textOf(res.content) || null;
  } catch (e) {
    console.error('summary failed', e);
    return null;
  }
}

/** The open session, or a new one; `carry` is a summary to seed it with when the old one got too long. */
async function openSession(env: Env, now: Date): Promise<{ session: Session; isNew: boolean; carry: string | null }> {
  const hash = await configHash(chatModel(env), primaryProvider(env));
  const current = await first<Session>(env.DB, 'SELECT * FROM sessions WHERE closed = 0 ORDER BY id DESC LIMIT 1');
  const reason = current ? sessionEndReason(current, now, hash, env.TIMEZONE) : 'none';
  if (current && !reason) return { session: current, isNew: false, carry: null };
  let carry: string | null = null;
  if (current) {
    if (reason === 'size') carry = await summarize(env, current.id);
    await run(env.DB, 'UPDATE sessions SET closed = 1, summary = ? WHERE id = ?', carry, current.id);
  }
  const session = await first<Session>(env.DB,
    'INSERT INTO sessions (started_at, last_active_at, config_hash) VALUES (?, ?, ?) RETURNING *', now.toISOString(), now.toISOString(), hash);
  if (!session) throw new Error('could not start a session');
  return { session, isNew: true, carry };
}

function outboxBlock(rows: OutboxRow[], tz: string): string {
  return rows
    .map(o => `<sent_by_assistant kind="${o.kind}" at="${localTime(new Date(o.ts), tz)}">\n${o.text}\n</sent_by_assistant>`)
    .join('\n');
}

/** Everything the model needs to know at the start of a session. */
export async function buildSnapshot(env: Env, now: Date, carry: string | null, recentOutbox: OutboxRow[]): Promise<string> {
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const [areas, tasks, reminders, memory, logs, quiet] = await Promise.all([
    getAreas(env.DB),
    activeTasks(env.DB),
    pendingReminders(env.DB),
    memoryFacts(env.DB),
    recentLogs(env, 2, now),
    getState<string | null>(env.DB, 'quiet_until', null)
  ]);
  const soon = addDays(today, 7);
  const dated = tasks.filter(t => t.status === 'open' && t.due_date && t.due_date <= soon);
  const undated = tasks.filter(t => t.status === 'open' && !(t.due_date && t.due_date <= soon)).slice(0, 20);
  const waiting = tasks.filter(t => t.status === 'waiting');
  const horizon = new Date(now.getTime() + 48 * 3600_000).toISOString();
  const lastCheckin = logs.find(l => l.kind === 'checkin');
  const lines = [
    '<snapshot>',
    `Areas: ${areas.join(', ')}`,
    `Today: ${today}${quiet && quiet >= today ? ` (brief and check-in paused through ${quiet})` : ''}`,
    '',
    `Open tasks due by ${soon} (${dated.length}):`,
    ...(dated.length ? dated.map(taskLine) : ['(none)']),
    '',
    `Other open tasks (${undated.length}${tasks.length > dated.length + undated.length + waiting.length ? ', more exist: use list_tasks' : ''}):`,
    ...(undated.length ? undated.map(taskLine) : ['(none)']),
    ...(waiting.length ? ['', 'Waiting on others:', ...waiting.map(taskLine)] : []),
    '',
    'Reminders in the next 48 h:',
    ...(reminders.filter(r => r.next_due_utc <= horizon).map(reminderLine).slice(0, 20).join('\n') || '(none)').split('\n'),
    '',
    'Remembered facts:',
    ...(memory.length ? memory.map(m => `M${m.id} | ${m.fact}`) : ['(none yet)']),
    ...(lastCheckin ? ['', `Last check-in (${lastCheckin.date}): ${lastCheckin.value != null ? `mood ${lastCheckin.value}, ` : ''}${lastCheckin.text}`] : []),
    ...(carry ? ['', 'Summary of the conversation earlier today:', carry] : []),
    ...(recentOutbox.length ? ['', 'Recent messages the bot sent on its own:', outboxBlock(recentOutbox, tz)] : []),
    '</snapshot>'
  ];
  return lines.join('\n');
}

/**
 * Run one chat turn: append the user's blocks (plus time, and the snapshot or new bot messages)
 * to the session, then loop model ⇄ tools. On the main provider the FALLBACK_PROVIDERS chain runs
 * automatically; ProviderUnavailable propagates when all of it fails. The user turn is already
 * stored, so a later DeepSeek retry (continueTurn) answers it.
 */
export async function runChatTurn(env: Env, blocks: BetaContentBlockParam[], updateIds: number[], source: string, provider: Provider = primaryProvider(env)): Promise<TurnResult> {
  const now = new Date();
  const tz = env.TIMEZONE;
  const { session, isNew, carry } = await openSession(env, now);
  const maxOutbox = (await first<{ id: number | null }>(env.DB, 'SELECT MAX(id) AS id FROM outbox'))?.id ?? 0;

  const prefix: BetaTextBlockParam[] = [{ type: 'text', text: `[${stamp(now, tz)}]` }];
  if (isNew) {
    const since = new Date(now.getTime() - 12 * 3600_000).toISOString();
    const recent = (await all<OutboxRow>(env.DB, 'SELECT * FROM outbox WHERE ts >= ? ORDER BY id DESC LIMIT 5', since)).reverse();
    prefix.push({ type: 'text', text: await buildSnapshot(env, now, carry, recent) });
  } else {
    const fresh = await outboxAfter(env.DB, session.last_outbox_id);
    if (fresh.length) prefix.push({ type: 'text', text: outboxBlock(fresh, tz) });
  }
  const userContent = [...prefix, ...blocks];
  await env.DB.batch([
    turnInsert(env, session.id, 'user', userContent, provider, updateIds),
    env.DB.prepare('UPDATE sessions SET last_active_at = ?, last_outbox_id = ? WHERE id = ?').bind(now.toISOString(), maxOutbox, session.id)
  ]);
  // Re-read from storage so this request and every later replay send byte-identical history.
  const chain = provider === primaryProvider(env) ? providerChain(env) : [provider];
  return runLoop(env, session.id, await loadMessages(env, session.id), chain, source);
}

/** Answer whatever the session's last user turn asked, e.g. on DeepSeek after Claude failed. */
export async function continueTurn(env: Env, sessionId: number, provider: Provider): Promise<TurnResult | null> {
  const messages = await loadMessages(env, sessionId);
  if (!messages.length || messages[messages.length - 1]?.role !== 'user') return null;
  return runLoop(env, sessionId, messages, [provider], 'chat');
}

/** `chain`: the providers to try, in order. Once one answers, the rest of the turn stays on it. */
async function runLoop(env: Env, sessionId: number, messages: BetaMessageParam[], chain: Provider[], source: string): Promise<TurnResult> {
  let provider = chain[0] ?? primaryProvider(env);
  const texts: string[] = [];
  let usedTools = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const req: LlmRequest = {
      kind: 'chat',
      model: chatModelFor(env, provider),
      effort: 'low',
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      maxTokens: 4096,
      timeoutMs: 45_000,
      noTools: round === MAX_ROUNDS - 1
    };
    const res = await callWithFallback(env, req, [provider, ...chain.filter(p => p !== provider)]);
    provider = res.provider;
    const content: BetaContentBlockParam[] = res.content.length ? res.content : [{ type: 'text', text: '…' }];
    const text = textOf(content);
    if (text) texts.push(text);

    // Every tool_use must be answered by a tool_result in the next turn, or the history can't be replayed.
    const toolUses = content.filter((b): b is Extract<BetaContentBlockParam, { type: 'tool_use' }> => b.type === 'tool_use');
    const results: BetaToolResultBlockParam[] = [];
    for (const block of toolUses) {
      results.push(res.stopReason === 'tool_use'
        ? await runTool(block, { env, now: new Date(), source })
        : { type: 'tool_result', tool_use_id: block.id, content: 'Not run: the response was cut off.', is_error: true });
    }
    usedTools ||= results.length > 0;

    const statements = [turnInsert(env, sessionId, 'assistant', content, res.provider)];
    if (results.length) statements.push(turnInsert(env, sessionId, 'user', results, res.provider));
    statements.push(env.DB.prepare('UPDATE sessions SET last_active_at = ?, token_estimate = ? WHERE id = ?').bind(new Date().toISOString(), res.promptTokens, sessionId));
    await env.DB.batch(statements);

    messages = [...messages, { role: 'assistant', content }, ...(results.length ? [{ role: 'user' as const, content: results }] : [])];
    if (res.stopReason !== 'tool_use') {
      let reply = texts[texts.length - 1] || (usedTools ? '✅ Done.' : '…');
      if (res.stopReason === 'refusal') reply = "I can't help with that one.";
      if (res.stopReason === 'max_tokens') reply += '\n\n(cut off — ask me to continue)';
      // Mark answers from the fallback provider, not from the one picked in PROVIDER.
      if (provider !== primaryProvider(env)) reply += `\n\n_⚡ ${providerName(provider)}_`;
      return { reply, provider, sessionId };
    }
  }
  return { reply: texts[texts.length - 1] || '✅ Done.', provider, sessionId };
}
