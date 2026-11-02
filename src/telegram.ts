/**
 * Telegram Bot API: calls, safe HTML output (Claude writes Markdown; Telegram wants a small HTML
 * subset), splitting under the 4096-character limit, right-to-left lines, and file downloads.
 */

import type { Env } from './env';

export class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number, description: string) {
    super(`Telegram ${method}: ${description}`);
  }
}

export type Keyboard = { text: string; callback_data: string }[][];

const MAX_CHUNK = 3500; // Telegram allows 4096; leave room for entities and the footer
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // getFile limit for bots

export async function tg<T = unknown>(env: Env, method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string };
  if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? `HTTP ${res.status}`);
  return body.result as T;
}

// ---------------------------------------------------------------- formatting

export function esc(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Start a line with a right-to-left mark when it contains Persian, so Telegram aligns it right. */
export function rtl(line: string): string {
  return RTL_CHARS.test(line) ? `‏${line}` : line;
}

export function toPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function inlineMd(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map(part => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
        .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<b>$1</b>')
        .replace(/__(?=\S)([^_\n]+?)__/g, '<b>$1</b>')
        .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>')
        .replace(/~~(?=\S)([^~\n]+?)~~/g, '<s>$1</s>');
    })
    .join('');
}

/** Markdown (as Claude writes it) → Telegram HTML. Headings become bold, tables become <pre>. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  let fence: string[] | null = null;
  let table: string[] = [];
  const flushTable = () => {
    if (table.length) out.push(`<pre>${esc(table.join('\n'))}</pre>`);
    table = [];
  };
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        out.push(`<pre>${esc(fence.join('\n'))}</pre>`);
        fence = null;
      } else {
        flushTable();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(line.trim());
      continue;
    }
    flushTable();
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (heading) out.push(rtl(`<b>${inlineMd(heading[1] ?? '')}</b>`));
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('');
    else if (bullet) out.push(rtl(`${bullet[1]}• ${inlineMd(bullet[2] ?? '')}`));
    else out.push(rtl(inlineMd(line)));
  }
  if (fence) out.push(`<pre>${esc(fence.join('\n'))}</pre>`);
  flushTable();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Hard-split one oversized piece at newlines, then spaces, then anywhere. */
function hardSplit(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Split Markdown into chunks at paragraph breaks, never inside a ``` fence (unless it alone is too long). */
export function splitMarkdown(md: string, limit = MAX_CHUNK): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '' && current.length) {
      blocks.push(current.join('\n'));
      current = [];
    } else if (line.trim() !== '' || inFence) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n'));

  const chunks: string[] = [];
  let chunk = '';
  for (const block of blocks.flatMap(b => (b.length > limit ? hardSplit(b, limit) : [b]))) {
    if (chunk && chunk.length + block.length + 2 > limit) {
      chunks.push(chunk);
      chunk = block;
    } else {
      chunk = chunk ? `${chunk}\n\n${block}` : block;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [''];
}

/** Split already-formatted HTML at line breaks (our own HTML never spans lines). */
export function splitHtml(html: string, limit = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const line of html.split('\n').flatMap(l => (l.length > limit ? hardSplit(l, limit) : [l]))) {
    if (chunk && chunk.length + line.length + 1 > limit) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [''];
}

// ---------------------------------------------------------------- sending

async function sendChunks(env: Env, chunks: string[], keyboard?: Keyboard): Promise<number[]> {
  const ids: number[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const base = {
      chat_id: env.OWNER_ID,
      link_preview_options: { is_disabled: true },
      ...(last && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {})
    };
    let sent: { message_id: number };
    try {
      sent = await tg<{ message_id: number }>(env, 'sendMessage', { ...base, text: chunk, parse_mode: 'HTML' });
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400 && /parse entities|unsupported start tag|can't find end/i.test(e.message))) throw e;
      sent = await tg<{ message_id: number }>(env, 'sendMessage', { ...base, text: toPlain(chunk) });
    }
    ids.push(sent.message_id);
  }
  return ids;
}

export function sendHtml(env: Env, html: string, keyboard?: Keyboard): Promise<number[]> {
  return sendChunks(env, splitHtml(html), keyboard);
}

export function sendMarkdown(env: Env, md: string, keyboard?: Keyboard): Promise<number[]> {
  return sendChunks(env, splitMarkdown(md).map(mdToHtml), keyboard);
}

export async function editHtml(env: Env, messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
  await tg(env, 'editMessageText', {
    chat_id: env.OWNER_ID,
    message_id: messageId,
    text: splitHtml(html)[0],
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard ?? [] }
  }).catch(e => {
    if (!(e instanceof TelegramError && /not modified/i.test(e.message))) throw e;
  });
}

export function typing(env: Env): Promise<unknown> {
  return tg(env, 'sendChatAction', { chat_id: env.OWNER_ID, action: 'typing' }).catch(() => undefined);
}

export function answerCallback(env: Env, id: string, text?: string): Promise<unknown> {
  return tg(env, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => undefined);
}

/** Best effort ⚠️ to the owner; never throws (used from error paths). */
export async function warn(env: Env, text: string): Promise<void> {
  await tg(env, 'sendMessage', { chat_id: env.OWNER_ID, text: `⚠️ ${text}`.slice(0, 4000) }).catch(e => console.error('warn failed', e));
}

export async function downloadFile(env: Env, fileId: string): Promise<ArrayBuffer> {
  const file = await tg<{ file_path?: string; file_size?: number }>(env, 'getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('Telegram returned no file path (file over 20 MB?)');
  if ((file.file_size ?? 0) > MAX_FILE_BYTES) throw new Error('file is over the 20 MB bot limit');
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}
