/**
 * Model calls. PROVIDER in wrangler.toml (or /model in Telegram) picks the main provider:
 * - "deepseek": chat, summaries and routines all go to DEEPSEEK_MODEL through DeepSeek's
 *   Anthropic-compatible endpoint.
 * - "claude": Haiku for chat, Opus for routines through the Anthropic SDK.
 * - "opencode": OPENCODE_MODEL through the OpenCode Go subscription's Anthropic-compatible endpoint.
 * FALLBACK_PROVIDERS lists providers tried automatically, in order, when the main one is unavailable
 * (outage, rate or usage limit, no credit, bad key). With none set and PROVIDER = "claude", DeepSeek
 * is offered per message instead ("Send via DeepSeek").
 * Also: one retry on overload, a circuit breaker for Claude, a cooldown for failing providers, the
 * request sanitiser for non-Claude endpoints, and usage cost.
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

export type Provider = 'claude' | 'deepseek' | 'opencode';
export const PROVIDERS: Provider[] = ['claude', 'deepseek', 'opencode'];
export type CallKind = 'chat' | 'vision' | 'summary' | 'brief' | 'review';
export type Effort = 'low' | 'medium' | 'high';

/**
 * The provider can't be used right now (outage, credits, key, breaker, usage limit). `tried` lists
 * every provider that failed when a fallback chain ran; the caller may still offer DeepSeek.
 */
export class ProviderUnavailable extends Error {
  constructor(readonly reason: string, readonly provider: Provider = 'claude', readonly tried: Provider[] = [provider]) {
    super(reason);
  }
}

/** "opencode", "OpenCode Go", "go" → 'opencode'; null if it names no provider. */
export function parseProvider(text: string | undefined): Provider | null {
  const t = (text ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (t === 'claude' || t === 'anthropic') return 'claude';
  if (t === 'deepseek' || t === 'ds') return 'deepseek';
  if (t === 'opencode' || t === 'opencodego' || t === 'go') return 'opencode';
  return null;
}

/** The provider that answers by default, from PROVIDER (DeepSeek when it names none). */
export function primaryProvider(env: Env): Provider {
  return parseProvider(env.PROVIDER) ?? 'deepseek';
}

export const providerName = (p: Provider) => ({ claude: 'Claude', deepseek: 'DeepSeek', opencode: 'OpenCode Go' })[p];

/** Whether the provider's API key is set. */
export function hasKey(env: Env, p: Provider): boolean {
  return Boolean(p === 'claude' ? env.ANTHROPIC_API_KEY : p === 'deepseek' ? env.DEEPSEEK_API_KEY : env.OPENCODE_API_KEY);
}

/** FALLBACK_PROVIDERS ("opencode, deepseek"), in order, without the main provider, repeats, or providers with no key. */
export function fallbackProviders(env: Env): Provider[] {
  const main = primaryProvider(env);
  const list = (env.FALLBACK_PROVIDERS ?? '').split(/[\s,]+/).map(parseProvider).filter((p): p is Provider => p !== null && p !== main && hasKey(env, p));
  return [...new Set(list)];
}

/** Every provider a call may use, main first. */
export const providerChain = (env: Env): Provider[] => [primaryProvider(env), ...fallbackProviders(env)];

/** The chat model on a provider. */
export function chatModelFor(env: Env, p: Provider): string {
  return p === 'claude' ? env.CHAT_MODEL : p === 'deepseek' ? env.DEEPSEEK_MODEL : env.OPENCODE_MODEL;
}

/** The routine (brief, review) model on a provider; its chat model when none is set. */
export function routineModelFor(env: Env, p: Provider): string {
  if (p === 'claude') return env.ROUTINE_MODEL;
  if (p === 'deepseek') return env.DEEPSEEK_ROUTINE_MODEL || env.DEEPSEEK_MODEL;
  return env.OPENCODE_ROUTINE_MODEL || env.OPENCODE_MODEL;
}

/** The model that answers chat on the main provider. */
export const chatModel = (env: Env): string => chatModelFor(env, primaryProvider(env));

// ---------------------------------------------------------------- /model: switching without a deploy

/** What /model picked: a main provider and, optionally, its chat model. Overrides wrangler.toml. */
export interface ModelChoice { provider: Provider; model?: string }
export const MODEL_CHOICE_KEY = 'model_choice';
const MODEL_VAR: Record<Provider, 'CHAT_MODEL' | 'DEEPSEEK_MODEL' | 'OPENCODE_MODEL'> = {
  claude: 'CHAT_MODEL',
  deepseek: 'DEEPSEEK_MODEL',
  opencode: 'OPENCODE_MODEL'
};

/** Model ids look like "kimi-k3", "claude-haiku-5-5" or "qwen3.8-max". */
export const isModelId = (s: string) => /^[A-Za-z0-9][\w.:/-]{0,59}$/.test(s);

/** The env with the /model choice applied (a copy; the original is untouched). */
export async function withModelChoice(env: Env): Promise<Env> {
  const base = env.DEPLOYED ?? env;
  const choice = await getState<ModelChoice | null>(env.DB, MODEL_CHOICE_KEY, null).catch(() => null);
  if (!choice || !PROVIDERS.includes(choice.provider)) return base;
  return { ...base, DEPLOYED: base, PROVIDER: choice.provider, ...(choice.model ? { [MODEL_VAR[choice.provider]]: choice.model } : {}) };
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
  // DeepSeek bills in CNY with an off-peak half price; these are the peak prices at ~7.1 CNY/USD
  // (Flash 2/8/0.04 元, Pro 9/27/0.3 元 per M), so /status errs high.
  ['deepseek-v4-pro', { input: 1.27, output: 3.8, cacheRead: 0.042 }],
  ['deepseek', { input: 0.28, output: 1.13, cacheRead: 0.006 }]
];
const FALLBACK_PRICE: Price = { input: 4, output: 20, cacheRead: 0.2 };

export interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number }

export function costUsd(model: string, t: Tokens): number {
  const p = PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? FALLBACK_PRICE;
  return (t.input * p.input + t.cacheWrite * p.input * 1.25 + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
}

async function logUsage(env: Env, provider: Provider, model: string, kind: CallKind, usage: Partial<Record<string, unknown>> | undefined): Promise<Tokens> {
  // OpenCode Go is a flat monthly subscription: its tokens don't add to the spend or the soft cap.
  const free = provider === 'opencode';
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const t: Tokens = {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheWrite: n(usage?.cache_creation_input_tokens),
    cacheRead: n(usage?.cache_read_input_tokens)
  };
  await run(env.DB, 'INSERT INTO usage (ts, provider, model, kind, input, output, cache_write, cache_read, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    new Date().toISOString(), provider, model, kind, t.input, t.output, t.cacheWrite, t.cacheRead, free ? 0 : costUsd(model, t));
  return t;
}

/** Spend since the start of this local month, in USD. */
export async function monthToDateUsd(env: Env, now = new Date()): Promise<number> {
  const p = localParts(now, env.TIMEZONE);
  const start = zonedToUtc(`${p.year}-${String(p.month).padStart(2, '0')}-01`, '00:00', env.TIMEZONE).toISOString();
  const row = await first<{ usd: number | null }>(env.DB, 'SELECT SUM(usd) AS usd FROM usage WHERE ts >= ?', start);
  return row?.usd ?? 0;
}

/**
 * Routines run on the routine model until the month's spend reaches MONTHLY_CAP_USD, then on the
 * chat model: ROUTINE_MODEL / CHAT_MODEL on Claude, DEEPSEEK_ROUTINE_MODEL / DEEPSEEK_MODEL on DeepSeek.
 */
export async function routineModel(env: Env, now = new Date()): Promise<{ model: string; capped: boolean }> {
  const cap = Number(env.MONTHLY_CAP_USD) || Infinity;
  const capped = (await monthToDateUsd(env, now)) >= cap;
  return { model: capped ? chatModel(env) : routineModelFor(env, primaryProvider(env)), capped };
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
  if (!env.ANTHROPIC_API_KEY) throw new ProviderUnavailable('no Claude API key is set');
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

/**
 * Keep only plain text / tool_use / tool_result blocks, with no Claude-only fields. Images are kept
 * only when asked (DeepSeek Flash reads images in user turns), otherwise replaced by a note.
 */
export function plainBlocks(content: string | readonly unknown[], keepImages = false): BetaContentBlockParam[] {
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
        out.push(keepImages ? ({ type: 'image', source: b.source } as BetaContentBlockParam) : { type: 'text', text: '[image omitted]' });
        break;
      default:
        // thinking, redacted_thinking, fallback, ...: Claude-only, dropped
        break;
    }
  }
  return out;
}

/** The DeepSeek model for a request: its own model if it names a DeepSeek one, else DEEPSEEK_MODEL. */
export const deepSeekModel = (env: Env, model: string) => (model.startsWith('deepseek') ? model : env.DEEPSEEK_MODEL);

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
      const content = plainBlocks(m.content as string | unknown[], m.role === 'user');
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
  if (!env.DEEPSEEK_API_KEY) throw new ProviderUnavailable('no DeepSeek API key is set', 'deepseek');
  const client = new Anthropic({ apiKey: env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL, maxRetries: 1, timeout: req.timeoutMs });
  const model = deepSeekModel(env, req.model);
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create(toDeepSeek(req, model));
  } catch (e) {
    // DeepSeek answers in the Anthropic error format, so the same reasons apply (402 = out of balance).
    const reason = unavailableReason(e);
    if (reason) throw new ProviderUnavailable(reason, 'deepseek');
    throw e;
  }
  const t = await logUsage(env, 'deepseek', model, req.kind, msg.usage as unknown as Record<string, unknown>);
  const content = plainBlocks(msg.content as unknown[]);
  return {
    provider: 'deepseek',
    model,
    content: content.length ? content : [{ type: 'text', text: '…' }],
    stopReason: msg.stop_reason,
    promptTokens: t.input + t.cacheRead + t.cacheWrite
  };
}

const OPENCODE_BASE_URL = 'https://opencode.ai/inference/go/anthropic';

/**
 * Why OpenCode Go can't answer now. Its usage-limit errors aren't documented, so besides the usual
 * reasons any 4xx that talks about a limit, quota or allowance counts as the limit being reached.
 */
export function openCodeUnavailableReason(e: unknown): string | null {
  const reason = unavailableReason(e);
  if (reason === 'rate limited') return 'usage limit reached or rate limited';
  if (reason) return reason;
  const message = e instanceof Error ? e.message : '';
  if (e instanceof Anthropic.APIError && /limit|quota|allowance|subscription|exceeded/i.test(message)) return 'usage limit reached';
  return null;
}

/** OpenCode Go (opencode.ai/docs/go): Bearer key from the OpenCode console, same sanitised request as DeepSeek. */
export async function callOpenCode(env: Env, req: LlmRequest): Promise<LlmResult> {
  if (!env.OPENCODE_API_KEY) throw new ProviderUnavailable('no OpenCode API key is set', 'opencode');
  const client = new Anthropic({
    authToken: env.OPENCODE_API_KEY,
    baseURL: OPENCODE_BASE_URL,
    maxRetries: 1,
    timeout: req.timeoutMs,
    // OpenCode asks clients to name themselves and send a stable session id (routing, prompt caching).
    defaultHeaders: { 'User-Agent': 'life-os-bot/1.0', 'x-opencode-session': `life-os-bot-${req.kind}` }
  });
  const model = req.model;
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create(toDeepSeek(req, model));
  } catch (e) {
    const reason = openCodeUnavailableReason(e);
    if (reason) throw new ProviderUnavailable(reason, 'opencode');
    throw e;
  }
  const t = await logUsage(env, 'opencode', model, req.kind, msg.usage as unknown as Record<string, unknown>);
  const content = plainBlocks(msg.content as unknown[]);
  return {
    provider: 'opencode',
    model,
    content: content.length ? content : [{ type: 'text', text: '…' }],
    stopReason: msg.stop_reason,
    promptTokens: t.input + t.cacheRead + t.cacheWrite
  };
}

/** One call on exactly this provider. */
export function call(env: Env, provider: Provider, req: LlmRequest): Promise<LlmResult> {
  if (provider === 'claude') return callClaude(env, req);
  if (provider === 'opencode') return callOpenCode(env, req);
  return callDeepSeek(env, req);
}

// ---------------------------------------------------------------- automatic fallback

const COOLDOWN_KEY = 'provider_cooldown';
export const COOLDOWN_MS = 10 * 60_000;

/** The request's model, moved to another provider: a routine model maps to that provider's routine model. */
function modelOn(env: Env, from: Provider, to: Provider, model: string): string {
  if (from === to) return model;
  return model === routineModelFor(env, from) && model !== chatModelFor(env, from) ? routineModelFor(env, to) : chatModelFor(env, to);
}

/**
 * Call the first provider in `chain` (the main one by default) and, when it is unavailable, the
 * next ones in order. A provider that failed while a later one answered cools down for 10 minutes:
 * it moves to the end of the chain, so each message doesn't wait on it first. Bugs (e.g. a 400 on
 * the first provider) still surface. When every provider fails, the ProviderUnavailable names them all.
 */
export async function callWithFallback(env: Env, req: LlmRequest, chain: Provider[] = providerChain(env)): Promise<LlmResult> {
  const lead = chain[0] ?? primaryProvider(env);
  if (chain.length <= 1) return call(env, lead, req);
  const now = Date.now();
  const cooldown = await getState<Partial<Record<Provider, number>>>(env.DB, COOLDOWN_KEY, {});
  const cooling = (p: Provider) => (cooldown[p] ?? 0) > now;
  const order = [...chain.filter(p => !cooling(p)), ...chain.filter(cooling)];
  const failed: [Provider, string][] = [];
  for (const p of order) {
    try {
      const res = await call(env, p, { ...req, model: modelOn(env, lead, p, req.model) });
      const next = { ...cooldown };
      for (const [f] of failed) next[f] = now + COOLDOWN_MS;
      delete next[p];
      if (failed.length || cooldown[p]) await setState(env.DB, COOLDOWN_KEY, next);
      return res;
    } catch (e) {
      // After the first provider, any API error just means "try the next one".
      const reason = e instanceof ProviderUnavailable ? e.reason : p !== order[0] && e instanceof Anthropic.APIError ? `error ${e.status ?? ''}`.trim() : null;
      if (reason === null) throw e;
      failed.push([p, reason]);
      console.warn(`${providerName(p)} unavailable (${reason}), trying the next provider`);
    }
  }
  const last = failed[failed.length - 1]!;
  throw new ProviderUnavailable(failed.map(([p, r]) => `${providerName(p)}: ${r}`).join('; '), last[0], failed.map(([p]) => p));
}

/** The text of an assistant turn (text blocks only). */
export function textOf(content: readonly (BetaContentBlockParam | BetaContentBlock)[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}
