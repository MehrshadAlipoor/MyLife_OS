import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { breakerState, callClaude, claudeParams, costUsd, plainBlocks, ProviderUnavailable, toDeepSeek } from '../src/llm';
import type { LlmRequest } from '../src/llm';
import { TOOLS } from '../src/tools';
import { anthropicError, claudeReply, isClaude, mockFetch, resetDb, testEnv } from './helpers';

const env = testEnv();
const req = (model = 'claude-haiku-5-5'): LlmRequest => ({
  kind: 'chat',
  model,
  effort: 'low',
  system: 'sys',
  tools: TOOLS,
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
  timeoutMs: 5000
});

beforeEach(() => resetDb(env));
afterEach(() => vi.restoreAllMocks());

describe('claudeParams', () => {
  it('sends adaptive thinking with drop_block binding, effort and caching; no fallbacks on Haiku', () => {
    const p = claudeParams(req());
    expect(p.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.betas).toEqual(['thinking-binding-controls-2026-08-01']);
    expect('fallbacks' in p).toBe(false);
    expect(p.tool_choice).toBeUndefined();
  });

  it('adds server-side refusal fallbacks for Opus 5.5, and tool_choice none on the last round', () => {
    const p = claudeParams({ ...req('claude-opus-5-5'), noTools: true });
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toContain('server-side-fallback-2026-07-01');
    expect(p.tool_choice).toEqual({ type: 'none' });
  });
});

describe('DeepSeek sanitising', () => {
  const history: LlmRequest['messages'] = [
    { role: 'user', content: [{ type: 'text', text: 'add milk', cache_control: { type: 'ephemeral' } }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'add_task', input: { title: 'milk' } }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Added T1' }] }] }
  ];

  it('drops thinking, cache_control, strict, effort and betas', () => {
    const ds = toDeepSeek({ ...req(), messages: history }, 'deepseek-v4-flash');
    const text = JSON.stringify(ds);
    expect(text).not.toMatch(/thinking|cache_control|"strict"|output_config|betas|fallbacks|signature/);
    expect(ds.model).toBe('deepseek-v4-flash');
    expect(ds.messages[1]?.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'add_task', input: { title: 'milk' } }]);
    expect(ds.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Added T1' }]);
    expect(ds.tools?.length).toBe(TOOLS.length);
  });

  it('rewrites tool ids Claude would reject, consistently', () => {
    const out = plainBlocks([
      { type: 'tool_use', id: 'call:00/x', name: 'n', input: {} },
      { type: 'tool_result', tool_use_id: 'call:00/x', content: 'ok' }
    ]);
    expect(out[0]).toMatchObject({ id: 'ds_call_00_x' });
    expect(out[1]).toMatchObject({ tool_use_id: 'ds_call_00_x' });
  });
});

describe('costUsd', () => {
  it('prices Haiku and Opus per million tokens, cache writes at 1.25x', () => {
    expect(costUsd('claude-haiku-5-5', { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 })).toBeCloseTo(0.6);
    expect(costUsd('claude-opus-5-5', { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 1_000_000 })).toBeCloseTo(5.2);
  });
});

describe('callClaude', () => {
  it('retries an overload once, then reports unavailable and trips the breaker on the second failure', async () => {
    const calls = mockFetch(c => (isClaude(c) ? anthropicError(529, 'overloaded_error', 'Overloaded') : undefined));
    await expect(callClaude(env, req())).rejects.toMatchObject({ reason: 'overloaded' });
    expect(calls.filter(isClaude)).toHaveLength(2);
    expect((await breakerState(env)).openUntil).toBe(0);

    await expect(callClaude(env, req())).rejects.toBeInstanceOf(ProviderUnavailable);
    expect((await breakerState(env)).openUntil).toBeGreaterThan(Date.now());

    const before = calls.length;
    await expect(callClaude(env, req())).rejects.toThrow(/paused/);
    expect(calls.length).toBe(before);
  });

  it('treats an empty credit balance as unavailable (so DeepSeek can be offered)', async () => {
    mockFetch(c => (isClaude(c) ? anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.') : undefined));
    await expect(callClaude(env, req())).rejects.toMatchObject({ reason: 'out of API credits' });
  });

  it('surfaces other 400s as errors instead of offering a fallback', async () => {
    mockFetch(c => (isClaude(c) ? anthropicError(400, 'invalid_request_error', 'messages: bad shape') : undefined));
    const err = await callClaude(env, req()).catch(e => e);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(err).not.toBeInstanceOf(ProviderUnavailable);
  });

  it('drops the block_binding control once if a model rejects it, and remembers that', async () => {
    let n = 0;
    const calls = mockFetch(c => {
      if (!isClaude(c)) return undefined;
      n++;
      return n === 1 ? anthropicError(400, 'invalid_request_error', 'thinking.block_binding: not supported for this model') : claudeReply([{ type: 'text', text: 'hi' }]);
    });
    const res = await callClaude(env, req());
    expect(res.content).toEqual([{ type: 'text', text: 'hi' }]);
    const bodies = calls.filter(isClaude).map(c => c.body);
    expect(bodies[0].thinking.block_binding).toBeDefined();
    expect(bodies[1].thinking).toEqual({ type: 'adaptive' });
    await callClaude(env, req());
    expect(calls.filter(isClaude)[2]?.body.thinking).toEqual({ type: 'adaptive' });
  });

  it('logs usage with cost', async () => {
    mockFetch(c => (isClaude(c) ? claudeReply([{ type: 'text', text: 'hi' }]) : undefined));
    await callClaude(env, req());
    const row = await env.DB.prepare('SELECT * FROM usage').first<{ input: number; usd: number; kind: string }>();
    expect(row).toMatchObject({ input: 1200, kind: 'chat' });
    expect(row!.usd).toBeGreaterThan(0);
  });
});
