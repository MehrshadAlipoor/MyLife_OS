import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { processUpdates } from '../src/index';
import { modelCommand } from '../src/commands';
import { getState } from '../src/db';
import { callOpenCode, callWithFallback, fallbackProviders, openCodeUnavailableReason, ProviderUnavailable, providerChain, withModelChoice } from '../src/llm';
import type { LlmRequest } from '../src/llm';
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from '../src/tools';
import { anthropicError, claudeReply, isClaude, isDeepSeek, isOpenCode, mockFetch, resetDb, telegramCalls, testEnv, tgMessage } from './helpers';
import type { TestEnv } from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = testEnv({ PROVIDER: 'deepseek', DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_ROUTINE_MODEL: 'deepseek-v4-pro', FALLBACK_PROVIDERS: 'opencode', OPENCODE_MODEL: 'kimi-k3' });
  await resetDb(env);
});
afterEach(() => vi.restoreAllMocks());

const req = (model = 'deepseek-flash', kind: LlmRequest['kind'] = 'chat'): LlmRequest => ({
  kind,
  model,
  effort: 'low',
  system: 'sys',
  tools: TOOLS,
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hello' }] },
    { role: 'user', content: 'and?' }
  ],
  maxTokens: 1000,
  timeoutMs: 5000
});

describe('provider config', () => {
  it('builds the chain from PROVIDER and FALLBACK_PROVIDERS, skipping the main one, repeats and keyless ones', () => {
    expect(providerChain(env)).toEqual(['deepseek', 'opencode']);
    expect(fallbackProviders(testEnv({ PROVIDER: 'claude', FALLBACK_PROVIDERS: 'OpenCode Go, claude, opencode, deepseek' }))).toEqual(['opencode', 'deepseek']);
    expect(fallbackProviders(testEnv({ PROVIDER: 'claude', FALLBACK_PROVIDERS: 'opencode', OPENCODE_API_KEY: undefined }))).toEqual([]);
    expect(providerChain(testEnv({ PROVIDER: 'opencode', FALLBACK_PROVIDERS: 'deepseek, claude' }))).toEqual(['opencode', 'deepseek', 'claude']);
  });

  it('treats undocumented OpenCode limit errors as unavailable, and other 400s as bugs', () => {
    const err = (status: number, message: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers());
    expect(openCodeUnavailableReason(err(400, 'Monthly usage limit exceeded'))).toBe('usage limit reached');
    expect(openCodeUnavailableReason(err(429, 'slow down'))).toBe('usage limit reached or rate limited');
    expect(openCodeUnavailableReason(err(400, 'messages: field required'))).toBeNull();
  });
});

describe('OpenCode Go calls', () => {
  it('sends a sanitised request with a Bearer key and logs no spend', async () => {
    const calls = mockFetch(c => (isOpenCode(c) ? claudeReply([{ type: 'text', text: 'Hi' }], 'end_turn', 'kimi-k3') : undefined));
    const res = await callOpenCode(env, req('kimi-k3'));
    expect(res).toMatchObject({ provider: 'opencode', model: 'kimi-k3', content: [{ type: 'text', text: 'Hi' }] });
    const call = calls.filter(isOpenCode)[0]!;
    expect(call.url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages');
    expect(call.headers.authorization).toBe('Bearer sk-oc-test');
    expect(call.headers['x-api-key']).toBeUndefined();
    expect(call.headers['user-agent']).toBe('life-os-bot/1.0');
    expect(call.headers['x-opencode-session']).toBe('life-os-bot-chat');
    expect(JSON.stringify(call.body)).not.toMatch(/thinking|signature|output_config|betas|fallbacks|cache_control/);
    const usage = await env.DB.prepare('SELECT provider, model, usd FROM usage').first();
    expect(usage).toEqual({ provider: 'opencode', model: 'kimi-k3', usd: 0 });
  });

  it('is unavailable without a key', async () => {
    await expect(callOpenCode(testEnv({ OPENCODE_API_KEY: undefined }), req('kimi-k3'))).rejects.toMatchObject({ provider: 'opencode', reason: 'no OpenCode API key is set' });
  });
});

describe('automatic fallback', () => {
  it('moves to OpenCode Go when DeepSeek is out of balance, then skips DeepSeek for a while', async () => {
    const calls = mockFetch(c => {
      if (isDeepSeek(c)) return anthropicError(402, 'invalid_request_error', 'Insufficient Balance');
      if (isOpenCode(c)) return claudeReply([{ type: 'text', text: 'from go' }], 'end_turn', 'kimi-k3');
      return undefined;
    });
    const res = await callWithFallback(env, req());
    expect(res.provider).toBe('opencode');
    expect(calls.filter(isOpenCode)[0]!.body.model).toBe('kimi-k3');
    expect(Object.keys(await getState(env.DB, 'provider_cooldown', {}))).toEqual(['deepseek']);

    calls.length = 0;
    await callWithFallback(env, req());
    expect(calls.filter(isDeepSeek)).toHaveLength(0);
    expect(calls.filter(isOpenCode)).toHaveLength(1);
  });

  it('maps a routine model to the fallback routine model', async () => {
    env = testEnv({ ...env, OPENCODE_ROUTINE_MODEL: 'kimi-k3.1-pro' });
    const calls = mockFetch(c => {
      if (isDeepSeek(c)) return anthropicError(529, 'overloaded_error', 'Overloaded');
      if (isOpenCode(c)) return claudeReply([{ type: 'text', text: 'brief' }], 'end_turn', 'kimi-k3.1-pro');
      return undefined;
    });
    await callWithFallback(env, req('deepseek-v4-pro', 'brief'));
    expect(calls.filter(isOpenCode)[0]!.body.model).toBe('kimi-k3.1-pro');
  });

  it('names every provider when all of them fail', async () => {
    mockFetch(c => {
      if (isDeepSeek(c)) return anthropicError(402, 'invalid_request_error', 'Insufficient Balance');
      if (isOpenCode(c)) return anthropicError(429, 'rate_limit_error', 'limit');
      return undefined;
    });
    const e = await callWithFallback(env, req()).catch(err => err);
    expect(e).toBeInstanceOf(ProviderUnavailable);
    expect(e.tried).toEqual(['deepseek', 'opencode']);
    expect(e.reason).toBe('DeepSeek: out of API credits; OpenCode Go: usage limit reached or rate limited');
  });

  it('surfaces a bad request on the main provider instead of hiding it', async () => {
    const calls = mockFetch(c => (isDeepSeek(c) ? anthropicError(400, 'invalid_request_error', 'bad tool schema') : undefined));
    await expect(callWithFallback(env, req())).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(calls.filter(isOpenCode)).toHaveLength(0);
  });

  it('answers a chat turn on OpenCode Go and tags the reply', async () => {
    const calls = mockFetch(c => {
      if (isDeepSeek(c)) return anthropicError(503, 'api_error', 'down');
      if (isOpenCode(c)) return claudeReply([{ type: 'text', text: 'Hi!' }], 'end_turn', 'kimi-k3');
      return undefined;
    });
    await env.DB.prepare("INSERT INTO processed_updates VALUES (30, 'queued', '')").run();
    await processUpdates(env, [tgMessage('hello', {}, 30)]);
    expect(calls.filter(isClaude)).toHaveLength(0);
    expect(telegramCalls(calls).at(-1)!.body.text).toContain('Hi!');
    expect(telegramCalls(calls).at(-1)!.body.text).toContain('OpenCode Go');
    const turn = await env.DB.prepare("SELECT provider FROM turns WHERE role = 'assistant'").first();
    expect(turn).toEqual({ provider: 'opencode' });
  });

  it('tells the owner when no model is available', async () => {
    const calls = mockFetch(c => (isDeepSeek(c) || isOpenCode(c) ? anthropicError(529, 'overloaded_error', 'Overloaded') : undefined));
    await env.DB.prepare("INSERT INTO processed_updates VALUES (31, 'queued', '')").run();
    await processUpdates(env, [tgMessage('hello', {}, 31)]);
    const last = telegramCalls(calls).at(-1)!.body;
    expect(last.text).toContain('No model is available (DeepSeek: overloaded; OpenCode Go: overloaded)');
    expect(last.reply_markup).toBeUndefined();
  });
});

describe('/model', () => {
  it('switches the main provider and model without a deploy, and resets', async () => {
    expect(await modelCommand(env, '')).toContain('Main: DeepSeek <code>deepseek-flash</code>');
    const reply = await modelCommand(env, 'opencode qwen3.8-max');
    expect(reply).toContain('Main: OpenCode Go <code>qwen3.8-max</code>');
    const chosen = await withModelChoice(env);
    expect(chosen.PROVIDER).toBe('opencode');
    expect(chosen.OPENCODE_MODEL).toBe('qwen3.8-max');
    expect(providerChain(chosen)).toEqual(['opencode']);

    // Switching again starts from the deployed config, not the previous choice.
    expect(await modelCommand(chosen, 'opencode')).toContain('Main: OpenCode Go <code>kimi-k3</code>');

    expect(await modelCommand(chosen, 'reset')).toContain('Main: DeepSeek');
    expect((await withModelChoice(chosen)).PROVIDER).toBe('deepseek');
  });

  it('rejects unknown providers and odd model ids', async () => {
    expect(await modelCommand(env, 'gpt')).toContain('Use <code>/model opencode</code>');
    expect(await modelCommand(env, 'opencode <b>')).toContain("doesn't look like a model id");
    expect(await getState(env.DB, 'model_choice', null)).toBeNull();
  });

  it('applies the choice to queued chat turns', async () => {
    await modelCommand(env, 'opencode glm-5.3');
    const calls = mockFetch(c => (isOpenCode(c) ? claudeReply([{ type: 'text', text: 'Hi from GLM' }], 'end_turn', 'glm-5.3') : undefined));
    await env.DB.prepare("INSERT INTO processed_updates VALUES (32, 'queued', '')").run();
    await worker.queue({ queue: 'life-os-inbox', messages: [{ body: { kind: 'update', update: tgMessage('hello', {}, 32) } }], ackAll() {} } as unknown as MessageBatch<never>, env);
    expect(calls.filter(isDeepSeek)).toHaveLength(0);
    expect(calls.filter(isOpenCode)[0]!.body.model).toBe('glm-5.3');
    // The main provider answered, so no tag.
    expect(telegramCalls(calls).at(-1)!.body.text).toBe('Hi from GLM');
  });
});

describe('/model buttons', () => {
  it('lists every OpenCode Go model as a button, marks the current one, and switches on tap', async () => {
    const { handleCallback, handleCommand, OPENCODE_MODELS } = await import('../src/commands');
    const calls = mockFetch();
    await handleCommand(env, 'model', 'list', new Date());
    const card = telegramCalls(calls).at(-1)!.body;
    const buttons = card.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
    expect(buttons.filter(b => b.callback_data.startsWith('m:opencode:'))).toHaveLength(OPENCODE_MODELS.length);
    expect(buttons.find(b => b.callback_data === 'm:deepseek')!.text).toBe('✓ DeepSeek');
    expect(buttons.every(b => new TextEncoder().encode(b.callback_data).length <= 64)).toBe(true);
    expect(buttons.some(b => b.callback_data.includes('-free'))).toBe(false);

    await handleCallback(env, { id: 'q1', from: { id: 4242 }, data: 'm:opencode:glm-5.3-flash', message: { message_id: 7, chat: { id: 4242, type: 'private' } } }, new Date());
    expect(await getState(env.DB, 'model_choice', null)).toEqual({ provider: 'opencode', model: 'glm-5.3-flash' });
    const edited = calls.filter(c => c.url.endsWith('/editMessageText')).at(-1)!.body;
    expect(edited.text).toContain('Main: OpenCode Go <code>glm-5.3-flash</code>');
    const after = (edited.reply_markup.inline_keyboard.flat() as { text: string }[]).map(b => b.text);
    expect(after).toContain('✓ glm-5.3-flash · $60');
    expect(after).toContain('DeepSeek');
    expect(calls.find(c => c.url.endsWith('/answerCallbackQuery'))!.body.text).toBe('OpenCode Go · glm-5.3-flash');

    await handleCallback(await withModelChoice(env), { id: 'q2', from: { id: 4242 }, data: 'm:reset', message: { message_id: 7, chat: { id: 4242, type: 'private' } } }, new Date());
    expect(await getState(env.DB, 'model_choice', null)).toBeNull();
  });
});
