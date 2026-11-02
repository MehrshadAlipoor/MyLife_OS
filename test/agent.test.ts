import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configHash, continueTurn, runChatTurn, sessionEndReason } from '../src/agent';
import type { Session } from '../src/agent';
import { addOutbox } from '../src/db';
import { ProviderUnavailable } from '../src/llm';
import { anthropicError, claudeReply, isClaude, isDeepSeek, json, mockFetch, resetDb, testEnv } from './helpers';

const env = testEnv();
const text = (t: string) => [{ type: 'text' as const, text: t }];
const turns = () => env.DB.prepare('SELECT role, content_json, provider FROM turns ORDER BY id').all<{ role: string; content_json: string; provider: string }>().then(r => r.results);

beforeEach(() => resetDb(env));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runChatTurn', () => {
  it('runs a tool round, stores every turn, and keeps each request a byte prefix of the next', async () => {
    let n = 0;
    const calls = mockFetch(c => {
      if (!isClaude(c)) return undefined;
      n++;
      if (n === 1) {
        return claudeReply([
          { type: 'thinking', thinking: '', signature: 'sig-1' },
          { type: 'tool_use', id: 'toolu_01', name: 'add_task', input: { title: 'Call Mimmo', area: 'mimmo', due_date: '2026-11-03', due_time: '10:00', priority: null, notes: null } }
        ], 'tool_use');
      }
      return claudeReply([{ type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'text', text: '✅ Added /T1 Call Mimmo · tomorrow 10:00' }]);
    });

    const res = await runChatTurn(env, text('remind me to call mimmo tomorrow 10'), [7], 'chat');
    expect(res.reply).toBe('✅ Added /T1 Call Mimmo · tomorrow 10:00');

    const stored = await turns();
    expect(stored.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored[0]?.content_json).toContain('<snapshot>');
    expect(stored[1]?.content_json).toContain('sig-1'); // thinking kept verbatim
    expect(stored[2]?.content_json).toContain('"tool_result"');

    const [first, second] = calls.filter(isClaude).map(c => c.body);
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));

    // The next turn in the same session replays the whole history unchanged, without a new snapshot.
    await runChatTurn(env, text('thanks'), [8], 'chat');
    const third = calls.filter(isClaude)[2]!.body;
    expect(JSON.stringify(third.messages.slice(0, 4))).toBe(JSON.stringify([...second.messages, { role: 'assistant', content: JSON.parse(stored[3]!.content_json) }]));
    expect(JSON.stringify(third.messages[4])).not.toContain('<snapshot>');
    expect(third.system).toBe(first.system);
  });

  it('shows messages the bot sent on its own in the next user turn', async () => {
    const calls = mockFetch(c => (isClaude(c) ? claudeReply([{ type: 'text', text: 'ok' }]) : undefined));
    await runChatTurn(env, text('hi'), [], 'chat');
    await addOutbox(env.DB, 'morning_brief', 'Top 3: /T4 SOP');
    await runChatTurn(env, text('move the first one to tomorrow'), [], 'chat');
    const last = calls.filter(isClaude)[1]!.body.messages.at(-1);
    expect(JSON.stringify(last)).toContain('<sent_by_assistant kind=\\"morning_brief\\"');
  });

  it('starts a new session when the model (config hash) changes', async () => {
    mockFetch(c => (isClaude(c) ? claudeReply([{ type: 'text', text: 'ok' }]) : undefined));
    await runChatTurn(env, text('hi'), [], 'chat');
    await runChatTurn(testEnv({ CHAT_MODEL: 'claude-sonnet-5-5' }), text('hi again'), [], 'chat');
    const sessions = await env.DB.prepare('SELECT closed FROM sessions ORDER BY id').all<{ closed: number }>();
    expect(sessions.results.map(s => s.closed)).toEqual([1, 0]);
  });

  it('keeps the user turn when Claude is down, then answers it on DeepSeek without thinking blocks', async () => {
    const calls = mockFetch(c => {
      if (isClaude(c)) return anthropicError(529, 'overloaded_error', 'Overloaded');
      if (isDeepSeek(c)) {
        return json({ id: 'x', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'thinking', thinking: 'hmm', signature: '' }, { type: 'text', text: 'Here you go' }],
          usage: { input_tokens: 10, output_tokens: 5 } });
      }
      return undefined;
    });
    const err = await runChatTurn(env, text('plan my week'), [9], 'chat').catch(e => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    const session = await env.DB.prepare('SELECT id FROM sessions').first<{ id: number }>();
    expect((await turns()).map(t => t.role)).toEqual(['user']);

    const res = await continueTurn(env, session!.id, 'deepseek');
    expect(res?.reply).toBe('Here you go\n\n_⚡ DeepSeek_');
    const ds = calls.find(isDeepSeek)!;
    expect(JSON.stringify(ds.body)).not.toMatch(/"thinking"|cache_control|output_config/);
    const stored = await turns();
    expect(stored[1]).toMatchObject({ role: 'assistant', provider: 'deepseek' });
    expect(stored[1]?.content_json).toBe(JSON.stringify([{ type: 'text', text: 'Here you go' }]));

    // Already answered: nothing to continue.
    expect(await continueTurn(env, session!.id, 'deepseek')).toBeNull();
  });

  it('answers a tool_use that was cut off with an error result, so history stays replayable', async () => {
    mockFetch(c => (isClaude(c) ? claudeReply([{ type: 'tool_use', id: 'toolu_9', name: 'add_task', input: {} }], 'max_tokens') : undefined));
    const res = await runChatTurn(env, text('add stuff'), [], 'chat');
    expect(res.reply).toContain('cut off');
    const stored = await turns();
    expect(stored.map(t => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(stored[2]?.content_json).toContain('"is_error":true');
  });
});

describe('sessionEndReason', () => {
  const tz = 'Europe/Rome';
  const session = (last: string, extra: Partial<Session> = {}): Session => ({
    id: 1, started_at: last, last_active_at: last, config_hash: 'h', token_estimate: 1000, last_outbox_id: 0, closed: 0, summary: null, ...extra
  });

  it('continues within the same day and through midnight until 04:00', () => {
    expect(sessionEndReason(session('2026-11-02T20:00:00Z'), new Date('2026-11-02T22:30:00Z'), 'h', tz)).toBeNull(); // 21:00 → 23:30
    expect(sessionEndReason(session('2026-11-02T22:00:00Z'), new Date('2026-11-02T23:30:00Z'), 'h', tz)).toBeNull(); // 23:00 → 00:30
    expect(sessionEndReason(session('2026-11-03T02:30:00Z'), new Date('2026-11-03T03:10:00Z'), 'h', tz)).toBe('day'); // 03:30 → 04:10
  });

  it('ends on idle, size and config change', () => {
    expect(sessionEndReason(session('2026-11-02T08:00:00Z'), new Date('2026-11-02T11:30:00Z'), 'h', tz)).toBe('idle');
    expect(sessionEndReason(session('2026-11-02T08:00:00Z', { token_estimate: 50_000 }), new Date('2026-11-02T08:10:00Z'), 'h', tz)).toBe('size');
    expect(sessionEndReason(session('2026-11-02T08:00:00Z'), new Date('2026-11-02T08:10:00Z'), 'other', tz)).toBe('config');
  });

  it('hashes the prompt, tools and model', async () => {
    expect(await configHash('claude-haiku-5-5')).toBe(await configHash('claude-haiku-5-5'));
    expect(await configHash('claude-haiku-5-5')).not.toBe(await configHash('claude-opus-5-5'));
  });
});
