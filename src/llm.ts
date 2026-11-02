/**
 * Model calls. Claude (Haiku for chat, Opus for routines) through the Anthropic SDK; DeepSeek
 * through its Anthropic-compatible endpoint, only after the owner taps "Send via DeepSeek".
 * Also: one retry on overload, a circuit breaker, the DeepSeek request sanitiser, and usage cost.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
  MessageCreateParamsNonStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Env } from './env';
import { first, getState, run, setState } from './db';
import { localParts, localTime, zonedToUtc } from './time';

export type Provider = 'claude' | 'deepseek';
export type CallKind = 'chat' | 'vision' | 'summary' | 'brief' | 'review';
export type Effort = 'low' | 'medium' | 'high';

/** Claude can't be used right now (outage, credits, key, breaker): the caller may offer DeepSeek. */
export class ProviderUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface LlmRequest {
  kind: CallKind;
  model: string;
  effort: Effort;
  system: string;
  messages: BetaMessageParam[];
  tools?: BetaToolUnion[];
  maxTokens: number;
  timeoutMs: number;
  /** Last round of a tool loop: answer in text, no more tool calls. */
  noTools?: boolean;
}

export interface LlmResult {
  provider: Provider;
  model: string;
  /** Exactly what to store and replay as the assistant turn. */
  content: BetaContentBlockParam[];
  stopReason: string | null;
  /** Prompt size of this call (input + cache read + cache write), for the session size guard. */
  promptTokens: number;
}

const BETA_BINDING = 'thinking-binding-controls-2026-08-01';
const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`); Haiku doesn't. */
const supportsRefusalFallback = (model: string) => /^claude-(opus-5-5|sonnet-5-5|fable-5-1)/.test(model);

export function claudeParams(req: LlmRequest, binding = true): MessageCreateParamsNonStreaming {
  const fallback = supportsRefusalFallback(req.model);
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.tools?.length && req.noTools ? { tool_choice: { type: 'none' as const } } : {}),
    // History is append-only, so thinking blocks stay valid; if something ever edits it,
    // drop the stale blocks instead of failing the request.
    thinking: binding ? { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } : { type: 'adaptive' },
    output_config: { effort: req.effort },
    cache_control: { type: 'ephemeral' },
    betas: [...(binding ? [BETA_BINDING] : []), ...(fallback ? [BETA_FALLBACK] : [])],
    ...(fallback ? { fallbacks: 'default' as const } : {})
  };
}

// ---------------------------------------------------------------- cost

interface Price { input: number; output: number; cacheRead: number }

// USD per million tokens. Estimates for /status and the soft cap; the Console Cost page is authoritative.
const PRICES: [prefix: string, price: Price][] = [
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['deepseek', { input: 0.14, output: 0.28, cacheRead: 0.028 }]
];
const FALLBACK_PRICE: Price = { input: 4, output: 20, cacheRead: 0.2 };

export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

export function costUsd(model: string, t: Tokens): number {
  const p = PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? FALLBACK_PRICE;
  return (t.input * p.input + t.cacheWrite * p.input * 1.25 + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
}

async function logUsage(env: Env, provider: Provider, model: string, kind: CallKind, usage: Partial<Record<string, unknown>> | undefined): Promise<Tokens> {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const t: Tokens = {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheWrite: n(usage?.cache_creation_input_tokens),
    cacheRead: n(usage?.cache_read_input_tokens)
  };
  await run(env.DB, 'INSERT INTO usage (ts, provider, model, kind, input, output, cache_write, cache_read, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    new Date().toISOString(), provider, model, kind, t.input, t.output, t.cacheWrite, t.cacheRead, costUsd(model, t));
  return t;
}

/** Spend since the start of this local month, in USD. */
export async function monthToDateUsd(env: Env, now = new Date()): Promise<number> {
  const p = localParts(now, env.TIMEZONE);
  const start = zonedToUtc(`${p.year}-${String(p.month).padStart(2, '0')}-01`, '00:00', env.TIMEZONE).toISOString();
  const row = await first<{ usd: number | null }>(env.DB, 'SELECT SUM(usd) AS usd FROM usage WHERE ts >= ?', start);
  return row?.usd ?? 0;
}

/** Routines run on ROUTINE_MODEL until the month's spend reaches MONTHLY_CAP_USD, then on CHAT_MODEL. */
export async function routineModel(env: Env, now = new Date()): Promise<{ model: string; capped: boolean }> {
  const cap = Number(env.MONTHLY_CAP_USD) || Infinity;
  const capped = (await monthToDateUsd(env, now)) >= cap;
  return { model: capped ? env.CHAT_MODEL : env.ROUTINE_MODEL, capped };
}

// ---------------------------------------------------------------- circuit breaker

interface Breaker { failures: number[]; openUntil: number }
const BREAKER_KEY = 'claude_breaker';
const WINDOW_MS = 10 * 60_000;

export async function breakerState(env: Env): Promise<Breaker> {
  return getState<Breaker>(env.DB, BREAKER_KEY, { failures: [], openUntil: 0 });
}

async function recordFailure(env: Env): Promise<void> {
  const now = Date.now();
  const b = await breakerState(env);
  const failures = [...b.failures.filter(t => now - t < WINDOW_MS), now];
  await setState(env.DB, BREAKER_KEY, { failures, openUntil: failures.length >= 2 ? now + WINDOW_MS : b.openUntil });
}

async function recordSuccess(env: Env): Promise<void> {
  const b = await breakerState(env);
  if (b.failures.length || b.openUntil) await setState(env.DB, BREAKER_KEY, { failures: [], openUntil: 0 });
}

// ---------------------------------------------------------------- errors

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function status(e: unknown): number | undefined {
  return e instanceof Anthropic.APIError ? e.status : undefined;
}

/** Overloaded / rate limited / 5xx: worth exactly one retry. Timeouts are not retried. */
function isTransient(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return false;
  const s = status(e);
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 529;
}

/** Why Claude is unusable, or null when the error is a bug that should surface (e.g. other 400s). */
export function unavailableReason(e: unknown): string | null {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timed out';
  if (e instanceof Anthropic.APIConnectionError) return 'network error';
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'API key rejected';
  const s = status(e);
  const type = (e as { type?: string } | null)?.type;
  const message = e instanceof Error ? e.message : '';
  if (s === 402 || type === 'billing_error' || /credit balance/i.test(message)) return 'out of API credits';
  if (s === 429) return 'rate limited';
  if (s === 529 || type === 'overloaded_error') return 'overloaded';
  if (s !== undefined && s >= 500) return `server error ${s}`;
  return null;
}

const bindingRejected = (e: unknown) => e instanceof Anthropic.BadRequestError && /block_binding|thinking-binding|prefix_mismatch/i.test(e.message);

// ---------------------------------------------------------------- calls

export async function callClaude(env: Env, req: LlmRequest): Promise<LlmResult> {
  const b = await breakerState(env);
  if (b.openUntil > Date.now()) {
    throw new ProviderUnavailable(`paused after repeated errors, retrying at ${localTime(new Date(b.openUntil), env.TIMEZONE)}`);
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: req.timeoutMs });
  let binding = !(await getState<string[]>(env.DB, 'binding_unsupported', [])).includes(req.model);
  let retried = false;
  for (;;) {
    try {
      const msg: BetaMessage = await client.beta.messages.create(claudeParams(req, binding));
      if (msg.input_transformations?.length) console.warn('thinking blocks dropped', JSON.stringify(msg.input_transformations));
      const t = await logUsage(env, 'claude', msg.model, req.kind, msg.usage as unknown as Record<string, unknown>);
      await recordSuccess(env);
      return {
        provider: 'claude',
        model: msg.model,
        content: msg.content as BetaContentBlockParam[],
        stopReason: msg.stop_reason,
        promptTokens: t.input + t.cacheRead + t.cacheWrite
      };
    } catch (e) {
      if (binding && bindingRejected(e)) {
        // This model doesn't take the block-binding control: remember, and go on without it.
        binding = false;
        const list = await getState<string[]>(env.DB, 'binding_unsupported', []);
        await setState(env.DB, 'binding_unsupported', [...new Set([...list, req.model])]);
        continue;
      }
      if (!retried && isTransient(e)) {
        retried = true;
        await sleep(1500);
        continue;
      }
      const reason = unavailableReason(e);
      if (reason) {
        await recordFailure(env);
        throw new ProviderUnavailable(reason);
      }
      throw e;
    }
  }
}

const TOOL_ID = /^[a-zA-Z0-9_-]+$/;

/** Rewrite tool ids Claude wouldn't accept on replay (DeepSeek may use other characters). */
function safeToolId(id: string): string {
  return TOOL_ID.test(id) ? id : `ds_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
}

/** Keep only plain text / tool_use / tool_result blocks, with no Claude-only fields. */
export function plainBlocks(content: string | readonly unknown[]): BetaContentBlockParam[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: BetaContentBlockParam[] = [];
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (String(b.text ?? '')) out.push({ type: 'text', text: String(b.text) });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: safeToolId(String(b.id)), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: safeToolId(String(b.tool_use_id)),
          content: blockText(b.content),
          ...(b.is_error ? { is_error: true } : {})
        });
        break;
      case 'image':
        out.push({ type: 'text', text: '[image omitted]' });
        break;
      default:
        // thinking, redacted_thinking, fallback, ...: Claude-only, dropped
        break;
    }
  }
  return out;
}

/**
 * The same request for DeepSeek: no thinking, effort, betas, fallbacks, cache_control or strict
 * tools, and no Claude thinking blocks in the history (DeepSeek can't verify their signatures).
 */
export function toDeepSeek(req: LlmRequest, model: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages.map(m => {
      const content = plainBlocks(m.content as string | unknown[]);
      return { role: m.role, content: content.length ? content : [{ type: 'text', text: '…' }] } as Anthropic.MessageParam;
    }),
    ...(req.tools?.length
      ? {
          tools: req.tools.map(t => {
            const tool = t as { name: string; description?: string; input_schema: unknown };
            return { name: tool.name, description: tool.description, input_schema: tool.input_schema } as Anthropic.Tool;
          })
        }
      : {}),
    ...(req.tools?.length && req.noTools ? { tool_choice: { type: 'none' as const } } : {})
  };
}

export async function callDeepSeek(env: Env, req: LlmRequest): Promise<LlmResult> {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set');
  const client = new Anthropic({ apiKey: env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL, maxRetries: 1, timeout: req.timeoutMs });
  const msg = await client.messages.create(toDeepSeek(req, env.DEEPSEEK_MODEL));
  const t = await logUsage(env, 'deepseek', env.DEEPSEEK_MODEL, req.kind, msg.usage as unknown as Record<string, unknown>);
  const content = plainBlocks(msg.content as unknown[]);
  return {
    provider: 'deepseek',
    model: env.DEEPSEEK_MODEL,
    content: content.length ? content : [{ type: 'text', text: '…' }],
    stopReason: msg.stop_reason,
    promptTokens: t.input + t.cacheRead + t.cacheWrite
  };
}

export function call(env: Env, provider: Provider, req: LlmRequest): Promise<LlmResult> {
  return provider === 'claude' ? callClaude(env, req) : callDeepSeek(env, req);
}

/** The text of an assistant turn (text blocks only). */
export function textOf(content: readonly (BetaContentBlockParam | BetaContentBlock)[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}
