/**
 * Incoming Telegram messages → text blocks for the chat turn. Media becomes text before it enters
 * the conversation: voice through Workers AI Whisper, photos through one Claude vision call. So
 * replayed history never carries images, and the DeepSeek fallback sees the same text.
 */

import { Buffer } from 'node:buffer';
import type { BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Env, TgMessage, TgPhotoSize } from './env';
import { callClaude, ProviderUnavailable, textOf } from './llm';
import { PHOTO_PROMPT } from './prompts';
import { downloadFile, esc, MAX_FILE_BYTES, sendHtml } from './telegram';

const WHISPER = '@cf/openai/whisper-large-v3-turbo';
// Names Whisper tends to mangle, in both scripts so neither language is pushed onto the other.
const WHISPER_HINT = 'Mehrshad, Federica, Prelaj, Pedrocchi, Polimi, MMS, Mimmo, INT, PhD, CSH, Obsidian. مهرشاد، فدریکا، پلی‌تکنیک، میمو';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface WhisperOutput { text?: string; transcription_info?: { language?: string } }

export async function transcribe(env: Env, fileId: string): Promise<{ text: string; language: string }> {
  // Buffer's native base64 encoder: a JS loop over the bytes would burn the 10 ms CPU budget.
  const audio = Buffer.from(await downloadFile(env, fileId)).toString('base64');
  const runWhisper = (language?: string) =>
    env.AI.run(WHISPER as Parameters<Ai['run']>[0], { audio, initial_prompt: WHISPER_HINT, ...(language ? { language } : {}) } as never) as Promise<WhisperOutput>;
  let out = await runWhisper();
  let language = out.transcription_info?.language ?? '';
  if (language && language !== 'en' && language !== 'fa') {
    // He speaks English or Persian; anything else is almost always Persian misdetected.
    out = await runWhisper('fa');
    language = 'fa';
  }
  return { text: (out.text ?? '').trim(), language: language || 'en' };
}

/** Largest photo size that is at most ~1600 px on its long side (Telegram sends several). */
export function pickPhoto(sizes: TgPhotoSize[]): TgPhotoSize | undefined {
  const sorted = [...sizes].sort((a, b) => a.width * a.height - b.width * b.height);
  return [...sorted].reverse().find(s => Math.max(s.width, s.height) <= 1600) ?? sorted[0];
}

export async function describeImage(env: Env, fileId: string, mediaType: string): Promise<string> {
  const data = Buffer.from(await downloadFile(env, fileId));
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('image is over 5 MB');
  const res = await callClaude(env, {
    kind: 'vision',
    model: env.CHAT_MODEL,
    effort: 'low',
    system: PHOTO_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg', data: data.toString('base64') } },
        { type: 'text', text: 'Read this image.' }
      ]
    }],
    maxTokens: 2048,
    timeoutMs: 45_000
  });
  return textOf(res.content);
}

function forwardedFrom(msg: TgMessage): string | null {
  const o = msg.forward_origin;
  if (!o) return null;
  return o.sender_user?.first_name ?? o.sender_user_name ?? o.chat?.title ?? 'someone';
}

const wrapUntrusted = (source: string, text: string) => `<untrusted source="${source}">\n${text}\n</untrusted>`;
const captionBlock = (caption: string, forwarded: string | null) => (forwarded ? wrapUntrusted(`caption forwarded from ${forwarded}`, caption) : caption);

/**
 * One Telegram message → text blocks for the model. Voice transcripts are echoed back at once so
 * he can spot recognition errors. Unsupported things get a short note instead of silence.
 */
export async function messageToBlocks(env: Env, msg: TgMessage): Promise<BetaTextBlockParam[]> {
  const blocks: BetaTextBlockParam[] = [];
  const forwarded = forwardedFrom(msg);
  const caption = msg.caption?.trim();
  const add = (text: string) => blocks.push({ type: 'text', text });

  if (msg.text) {
    add(forwarded ? wrapUntrusted(`message forwarded from ${forwarded}`, msg.text) : msg.text);
    return blocks;
  }

  const audioDoc = msg.document?.mime_type?.startsWith('audio/') ? msg.document : undefined;
  const audio = msg.voice ?? msg.audio ?? audioDoc;
  if (audio) {
    if ((audio.file_size ?? 0) > MAX_FILE_BYTES) {
      await sendHtml(env, '🎙 That recording is over Telegram\'s 20 MB bot limit; please send a shorter one.');
      return blocks;
    }
    try {
      const { text, language } = await transcribe(env, audio.file_id);
      if (!text) {
        await sendHtml(env, '🎙 I couldn\'t hear any words in that recording.');
        return blocks;
      }
      await sendHtml(env, `🎙 <i>heard:</i> ${esc(text)}`);
      const body = `<voice_transcript lang="${language}">\n${text}\n</voice_transcript>`;
      add(forwarded ? wrapUntrusted(`voice note forwarded from ${forwarded}`, body) : body);
    } catch (e) {
      console.error('transcription failed', e);
      await sendHtml(env, `🎙 Transcription failed (${esc(e instanceof Error ? e.message : String(e))}). Please send it as text.`);
    }
    if (caption) add(captionBlock(caption, forwarded));
    return blocks;
  }

  const imageDoc = msg.document && IMAGE_TYPES.has(msg.document.mime_type ?? '') ? msg.document : undefined;
  const photo = msg.photo?.length ? pickPhoto(msg.photo) : undefined;
  if (photo || imageDoc) {
    const fileId = (photo ?? imageDoc)!.file_id;
    const size = (photo ?? imageDoc)!.file_size ?? 0;
    try {
      if (size > MAX_IMAGE_BYTES) throw new Error('image is over 5 MB');
      const description = await describeImage(env, fileId, imageDoc?.mime_type ?? 'image/jpeg');
      add(`<photo_description>\n${wrapUntrusted('photo', description || '(nothing readable)')}\n</photo_description>`);
    } catch (e) {
      const why = e instanceof ProviderUnavailable ? `Claude is unavailable: ${e.reason}` : e instanceof Error ? e.message : String(e);
      add(`<photo_description>(the photo could not be read: ${why})</photo_description>`);
    }
    if (caption) add(captionBlock(caption, forwarded));
    return blocks;
  }

  if (msg.document) {
    await sendHtml(env, `📎 I can't read ${esc(msg.document.mime_type ?? 'this kind of')} files yet: text, voice notes and photos work.`);
    if (caption) add(captionBlock(caption, forwarded));
    return blocks;
  }
  if (caption) add(captionBlock(caption, forwarded));
  return blocks;
}
