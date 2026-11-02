import { env as baseEnv } from 'cloudflare:workers';
import { vi } from 'vitest';
import type { Env, Job } from '../src/env';

export const OWNER = 4242;

export interface FakeQueue { sent: Job[]; send(job: Job): Promise<void>; sendBatch(jobs: { body: Job }[]): Promise<void> }

export function fakeQueue(): FakeQueue {
  const sent: Job[] = [];
  return {
    sent,
    async send(job) {
      sent.push(job);
    },
    async sendBatch(jobs) {
      sent.push(...jobs.map(j => j.body));
    }
  };
}

export interface TestEnv extends Env { QUEUE: Env['QUEUE'] & FakeQueue }

/** The real local D1, with a fake queue and Workers AI, and test secrets. */
export function testEnv(overrides: Partial<Env> = {}): TestEnv {
  const queue = fakeQueue();
  return {
    ...(baseEnv as unknown as Env),
    QUEUE: queue as unknown as TestEnv['QUEUE'],
    AI: { run: vi.fn(async () => ({ text: 'call Mimmo tomorrow at ten', transcription_info: { language: 'en' } })) } as unknown as Ai,
    TELEGRAM_BOT_TOKEN: 'TEST_TOKEN',
    OWNER_ID: String(OWNER),
    WEBHOOK_SECRET: 'hook-secret',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DEEPSEEK_API_KEY: 'sk-ds-test',
    GITHUB_TOKEN: undefined,
    ...overrides
  } as TestEnv;
}

const TABLES = ['tasks', 'logs', 'reminders', 'routines', 'memory', 'turns', 'sessions', 'outbox', 'processed_updates', 'pending_fallbacks', 'changes', 'usage', 'state'];

export async function resetDb(env: Env): Promise<void> {
  await env.DB.batch([
    ...TABLES.map(t => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(`INSERT INTO routines (name, local_time, days) VALUES
      ('morning_brief', '08:00', '12345'), ('evening_checkin', '21:30', '1234567'), ('weekly_review', '18:00', '7'),
      ('vault_export', '23:30', '1234567'), ('backup', '03:00', '7')`),
    env.DB.prepare(`INSERT INTO state (key, value) VALUES ('areas', '["phd","lab","mms","mimmo","health","admin","personal"]')`)
  ]);
}

export interface FetchCall { url: string; method: string; body: any; headers: Record<string, string> }

type Route = (call: FetchCall) => Response | Promise<Response> | undefined;

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** Route every fetch through `route`; Telegram calls default to ok. Returns the recorded calls. */
export function mockFetch(route: Route = () => undefined): FetchCall[] {
  const calls: FetchCall[] = [];
  let messageId = 100;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body ?? (req ? await req.clone().text() : undefined);
    let body: unknown = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url, method: init?.method ?? req?.method ?? 'GET', body, headers };
    calls.push(call);
    const res = await route(call);
    if (res) return res;
    if (url.startsWith('https://api.telegram.org/')) return json({ ok: true, result: { message_id: messageId++ } });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

export const isClaude = (c: FetchCall) => c.url.startsWith('https://api.anthropic.com/');
export const isDeepSeek = (c: FetchCall) => c.url.startsWith('https://api.deepseek.com/');
export const telegramCalls = (calls: FetchCall[], method = 'sendMessage') => calls.filter(c => c.url.endsWith(`/${method}`));

export function claudeReply(content: unknown[], stop_reason = 'end_turn', model = 'claude-haiku-5-5'): Response {
  return json({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  });
}

export const anthropicError = (status: number, type: string, message: string) => json({ type: 'error', error: { type, message } }, status);

export function tgMessage(text: string, extra: Record<string, unknown> = {}, updateId = 1, messageId = 1) {
  return {
    update_id: updateId,
    message: { message_id: messageId, date: 1_793_000_000, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text, ...extra }
  };
}
