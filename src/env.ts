/** Bindings, vars and secrets (wrangler.toml + `wrangler secret put`), and the queue message shapes. */

export interface Env {
  DB: D1Database;
  QUEUE: Queue<Job>;
  AI: Ai;

  TIMEZONE: string;
  /** Which model provider answers chat and writes routines: "deepseek" or "claude". */
  PROVIDER: string;
  CHAT_MODEL: string;
  ROUTINE_MODEL: string;
  DEEPSEEK_MODEL: string;
  /** Routines (brief, review) on DeepSeek; falls back to DEEPSEEK_MODEL when empty. */
  DEEPSEEK_ROUTINE_MODEL?: string;
  /** Model on OpenCode Go, e.g. "claude-haiku-5-5" or "kimi-k3" (ids: opencode.ai/docs/go). */
  OPENCODE_MODEL: string;
  /** Routines on OpenCode Go; falls back to OPENCODE_MODEL when empty. */
  OPENCODE_ROUTINE_MODEL?: string;
  /** Providers tried automatically, in order, when the main one fails: "opencode", "deepseek", "claude". */
  FALLBACK_PROVIDERS?: string;
  MONTHLY_CAP_USD: string;
  VAULT_REPO: string;
  VAULT_BRANCH: string;
  BACKUP_REPO: string;
  BACKUP_BRANCH: string;

  TELEGRAM_BOT_TOKEN: string;
  /** Your Telegram user id; in a private chat it is also the chat id. */
  OWNER_ID: string;
  WEBHOOK_SECRET: string;
  /** Needed when PROVIDER is "claude", and for reading photos (DeepSeek can't see images). */
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  /** OpenCode Go API key (opencode.ai/console), for PROVIDER or FALLBACK_PROVIDERS = "opencode". */
  OPENCODE_API_KEY?: string;
  GITHUB_TOKEN?: string;
  /** Set when /model overrides the deployed provider/model: the env as deployed. */
  DEPLOYED?: Env;
}

export type RoutineName = 'morning_brief' | 'evening_checkin' | 'weekly_review' | 'vault_export' | 'backup';
export const ROUTINE_NAMES: RoutineName[] = ['morning_brief', 'evening_checkin', 'weekly_review', 'vault_export', 'backup'];

export type Job =
  | { kind: 'update'; update: TgUpdate }
  | { kind: 'routine'; name: RoutineName | 'day_plan'; date: string }
  | { kind: 'fallback'; id: number };

// ---------------------------------------------------------------- the Telegram shapes we read

export interface TgUser { id: number; first_name?: string }
export interface TgChat { id: number; type: string }
export interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }
export interface TgFileRef { file_id: string; file_size?: number; mime_type?: string; duration?: number; file_name?: string }

export interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  voice?: TgFileRef;
  audio?: TgFileRef;
  photo?: TgPhotoSize[];
  document?: TgFileRef;
  forward_origin?: { type: string; sender_user?: TgUser; sender_user_name?: string; chat?: { title?: string } };
  media_group_id?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: TgChat; text?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
