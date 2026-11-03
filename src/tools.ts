/**
 * Tools the chat model can call. Strict schemas (optional fields are nullable and still required);
 * the API allows at most MAX_STRICT_UNION_PARAMS nullable fields across all strict tools, so
 * update_task (the widest patch) is not strict and relies on the checks below.
 * every input is validated again here and a problem comes back as an is_error result the model can
 * fix. Writes go through insertRow/updateRow so /undo can revert them. The list is static, so the
 * request prefix (and its cache) stays stable.
 */

import type { BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Env, RoutineName } from './env';
import { ROUTINE_NAMES } from './env';
import { activeTasks, all, doneBetween, first, getAreas, getTask, insertRow, logsBetween, pendingReminders, run, setState, updateRow } from './db';
import type { LogRow, MemoryRow, Reminder, Task } from './db';
import { readPath, safeVaultPath } from './github';
import { addDays, isDate, isoWeekday, isTime, localParts, nextOccurrence, weekStart, zonedToUtc } from './time';
import type { Repeat } from './time';

export class ToolError extends Error {}

export interface ToolContext {
  env: Env;
  now: Date;
  /** Where the request came from, recorded on new tasks: chat | voice | photo. */
  source: string;
}

// ---------------------------------------------------------------- schema helpers

type Schema = Record<string, unknown>;
const str = (description: string): Schema => ({ type: 'string', description });
const orNull = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const strEnum = (values: readonly string[], description: string): Schema => ({ type: 'string', enum: values, description });

/** API limit: strict tools may have at most 16 parameters with union types (anyOf / type arrays) in total. */
export const MAX_STRICT_UNION_PARAMS = 16;

function tool(name: string, description: string, properties: Record<string, Schema>, strict = true): BetaTool {
  return {
    name,
    description,
    strict,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
  };
}

const STATUSES = ['open', 'waiting', 'done', 'dropped'] as const;
const LOG_KINDS = ['progress', 'win', 'blocker', 'mood', 'habit', 'note', 'checkin'] as const;
const REPEATS = ['none', 'daily', 'weekdays', 'weekly'] as const;
const FILTERS = ['today', 'overdue', 'upcoming', 'area', 'waiting', 'all_open', 'done_recently'] as const;
const PERIODS = ['today', 'week', 'month'] as const;

export const TOOLS: BetaTool[] = [
  tool('add_task', 'Create a task. Use due_date only when there is a real deadline or a day it should happen.', {
    title: str('Short imperative title, in the language he used'),
    area: orNull(str('One of the areas from the snapshot')),
    due_date: orNull(str('YYYY-MM-DD local')),
    due_time: orNull(str('HH:MM local, only if a time matters')),
    priority: orNull({ type: 'integer', enum: [1, 2, 3], description: '1 high, 2 normal (default), 3 low' }),
    notes: orNull(str('Extra details'))
  }),
  tool('update_task', 'Change a task: fields left null stay as they are. Use status "done" to complete it. An empty string for due_date or due_time removes it.', {
    id: { type: 'integer', description: 'Task id (12 for /T12)' },
    title: orNull(str('New title')),
    area: orNull(str('New area')),
    due_date: orNull(str('YYYY-MM-DD local, or "" to clear')),
    due_time: orNull(str('HH:MM local, or "" to clear')),
    priority: orNull({ type: 'integer', enum: [1, 2, 3] }),
    status: orNull(strEnum(STATUSES, 'open | waiting (on someone else) | done | dropped')),
    notes: orNull(str('Replaces the notes'))
  }, false),
  tool('list_tasks', 'List tasks. today = due today or overdue; upcoming = next 7 days; area needs the area field; done_recently = finished in the last 7 days.', {
    filter: strEnum(FILTERS, 'Which tasks'),
    area: orNull(str('Area for filter=area'))
  }),
  tool('log_entry', 'Record progress, a win, a blocker, mood (value 1-5), a habit done, a note, or an evening check-in.', {
    kind: strEnum(LOG_KINDS, 'Entry type'),
    text: str('What happened, in his words (short)'),
    area: orNull(str('Area, if it belongs to one')),
    value: orNull({ type: 'number', description: 'Mood 1-5 for mood/checkin, or a quantity (minutes, count)' })
  }),
  tool('set_reminder', 'Send him a Telegram reminder at a local date and time, optionally repeating from then on.', {
    text: str('Reminder text'),
    date: str('YYYY-MM-DD local'),
    time: str('HH:MM local'),
    repeat: strEnum(REPEATS, 'none | daily | weekdays | weekly'),
    task_id: orNull({ type: 'integer', description: 'Related task id, so the reminder gets a Done button' })
  }),
  tool('list_reminders', 'List upcoming reminders.', {}),
  tool('cancel_reminder', 'Cancel a reminder.', { id: { type: 'integer', description: 'Reminder id (5 for R5)' } }),
  tool('get_progress', 'Progress numbers from logged data: tasks done/open per area, logs, mood, check-ins.', {
    period: strEnum(PERIODS, 'today | week (since Monday) | month'),
    area: orNull(str('Limit to one area'))
  }),
  tool('remember', 'Store a lasting fact or preference about him (people, routines, fixed commitments).', {
    fact: str('The fact, one sentence')
  }),
  tool('forget', 'Delete a remembered fact.', { id: { type: 'integer', description: 'Memory id (3 for M3)' } }),
  tool('update_routine', 'Change when an automatic routine runs, or turn it on/off. Fields left null stay as they are.', {
    name: strEnum(ROUTINE_NAMES, 'morning_brief | evening_checkin | weekly_review | vault_export | backup'),
    time: orNull(str('HH:MM local')),
    enabled: orNull({ type: 'boolean' })
  }),
  tool('set_quiet', 'Pause the morning brief and evening check-in for some days (reminders still arrive). 0 resumes them.', {
    days: { type: 'integer', description: 'Number of days including today; 0 to resume' }
  }),
  tool('read_vault_note', 'Read a Markdown note or list a folder in his Obsidian vault (read-only). Weekly reviews live under "TimeLine/<year>/<MM - Month>/". Start with "" or a folder to find paths.', {
    path: str('Vault path of a .md note or a folder, e.g. "TimeLine/2026/10 - October"')
  })
];

// ---------------------------------------------------------------- helpers

const S = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function checkArea(env: Env, area: unknown): Promise<string | null> {
  if (area == null || area === '') return null;
  const areas = await getAreas(env.DB);
  const found = areas.find(a => a.toLowerCase() === S(area).toLowerCase());
  if (!found) throw new ToolError(`Unknown area "${S(area)}". Areas: ${areas.join(', ')}. Use null if none fits.`);
  return found;
}

function checkDate(value: unknown, field: string): string {
  if (!isDate(value)) throw new ToolError(`${field} must be YYYY-MM-DD, got "${String(value)}"`);
  return value;
}

function checkTime(value: unknown, field: string): string {
  if (!isTime(value)) throw new ToolError(`${field} must be HH:MM (24h), got "${String(value)}"`);
  return value;
}

export function taskLine(t: Task): string {
  const due = t.due_date ? ` | due ${t.due_date}${t.due_time ? ` ${t.due_time}` : ''}` : '';
  return `T${t.id} | ${t.title}${t.area ? ` | ${t.area}` : ''}${due} | p${t.priority}${t.status !== 'open' ? ` | ${t.status}` : ''}`;
}

export function reminderLine(r: Reminder): string {
  return `R${r.id} | ${r.local_date} ${r.local_time}${r.repeat !== 'none' ? ` (${r.repeat})` : ''} | ${r.text}${r.task_id ? ` | T${r.task_id}` : ''}`;
}

const localToday = (ctx: ToolContext) => localParts(ctx.now, ctx.env.TIMEZONE).date;

// ---------------------------------------------------------------- handlers

type Handler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

const handlers: Record<string, Handler> = {
  async add_task(input, ctx) {
    const title = S(input.title);
    if (!title) throw new ToolError('title is empty');
    const dueTime = input.due_time ? checkTime(input.due_time, 'due_time') : null;
    const dueDate = input.due_date ? checkDate(input.due_date, 'due_date') : dueTime ? localToday(ctx) : null;
    const task = await insertRow<Task>(ctx.env.DB, 'tasks', {
      title: title.slice(0, 300),
      area: await checkArea(ctx.env, input.area),
      due_date: dueDate,
      due_time: dueTime,
      priority: input.priority ?? 2,
      notes: S(input.notes) || null,
      created_at: ctx.now.toISOString(),
      source: ctx.source
    });
    return `Added ${taskLine(task)}`;
  },

  async update_task(input, ctx) {
    // Not a strict tool, so check the types the schema would otherwise guarantee.
    const id = Number(input.id);
    if (!Number.isInteger(id)) throw new ToolError(`id must be a task number, got "${String(input.id)}"`);
    if (input.priority != null && ![1, 2, 3].includes(input.priority as number)) throw new ToolError('priority must be 1, 2 or 3');
    const patch: Record<string, unknown> = {};
    if (S(input.title)) patch.title = S(input.title).slice(0, 300);
    if (input.area != null) patch.area = await checkArea(ctx.env, input.area);
    if (input.due_date != null) patch.due_date = input.due_date === '' ? null : checkDate(input.due_date, 'due_date');
    if (input.due_time != null) patch.due_time = input.due_time === '' ? null : checkTime(input.due_time, 'due_time');
    if (input.priority != null) patch.priority = input.priority;
    if (input.notes != null) patch.notes = S(input.notes) || null;
    if (input.status != null) {
      if (!STATUSES.includes(input.status as (typeof STATUSES)[number])) throw new ToolError(`bad status ${String(input.status)}`);
      patch.status = input.status;
      patch.done_at = input.status === 'done' ? ctx.now.toISOString() : null;
    }
    const res = await updateRow<Task>(ctx.env.DB, 'tasks', id, patch);
    if (!res) throw new ToolError(`No task T${id}`);
    return `Updated ${taskLine(res.after)}`;
  },

  async list_tasks(input, ctx) {
    const today = localToday(ctx);
    const filter = String(input.filter);
    let tasks: Task[];
    if (filter === 'done_recently') {
      tasks = await doneBetween(ctx.env.DB, new Date(ctx.now.getTime() - 7 * 86400_000).toISOString(), ctx.now.toISOString());
    } else {
      const active = await activeTasks(ctx.env.DB);
      const area = filter === 'area' ? await checkArea(ctx.env, input.area) : null;
      const week = addDays(today, 7);
      tasks = active.filter(t => {
        switch (filter) {
          case 'today': return t.status === 'open' && t.due_date != null && t.due_date <= today;
          case 'overdue': return t.status === 'open' && t.due_date != null && t.due_date < today;
          case 'upcoming': return t.due_date != null && t.due_date >= today && t.due_date <= week;
          case 'area': return t.area === area;
          case 'waiting': return t.status === 'waiting';
          default: return true;
        }
      });
    }
    if (!tasks.length) return 'No tasks match.';
    const shown = tasks.slice(0, 40).map(taskLine);
    return shown.join('\n') + (tasks.length > 40 ? `\n…and ${tasks.length - 40} more` : '');
  },

  async log_entry(input, ctx) {
    const kind = String(input.kind);
    if (!LOG_KINDS.includes(kind as (typeof LOG_KINDS)[number])) throw new ToolError(`bad kind ${kind}`);
    const text = S(input.text);
    if (!text) throw new ToolError('text is empty');
    const value = input.value == null ? null : Number(input.value);
    if ((kind === 'mood' || kind === 'checkin') && value != null && (value < 1 || value > 5)) throw new ToolError('mood must be 1-5');
    const row = await insertRow<LogRow>(ctx.env.DB, 'logs', {
      ts: ctx.now.toISOString(),
      date: localToday(ctx),
      kind,
      text: text.slice(0, 2000),
      area: await checkArea(ctx.env, input.area),
      value
    });
    return `Logged ${kind} #${row.id}`;
  },

  async set_reminder(input, ctx) {
    const text = S(input.text);
    if (!text) throw new ToolError('text is empty');
    const tz = ctx.env.TIMEZONE;
    let date = checkDate(input.date, 'date');
    const time = checkTime(input.time, 'time');
    const repeat = String(input.repeat) as Repeat;
    if (!REPEATS.includes(repeat)) throw new ToolError(`bad repeat ${repeat}`);
    const taskId = input.task_id == null ? null : Number(input.task_id);
    if (taskId != null && !(await getTask(ctx.env.DB, taskId))) throw new ToolError(`No task T${taskId}`);
    let due = zonedToUtc(date, time, tz);
    if (repeat === 'weekdays' && isoWeekday(date) > 5) {
      // "Every weekday" starting on a weekend begins the next Monday.
      const monday = nextOccurrence('weekdays', date, time, tz, ctx.now)!;
      date = monday.date;
      due = monday.utc;
    } else if (due.getTime() <= ctx.now.getTime() - 60_000) {
      const next = nextOccurrence(repeat, date, time, tz, ctx.now);
      if (!next) throw new ToolError(`${date} ${time} is in the past (now ${localParts(ctx.now, tz).date} ${localParts(ctx.now, tz).time})`);
      date = next.date;
      due = next.utc;
    }
    const r = await insertRow<Reminder>(ctx.env.DB, 'reminders', {
      text: text.slice(0, 500),
      next_due_utc: due.toISOString(),
      local_date: date,
      local_time: time,
      repeat,
      task_id: taskId,
      created_at: ctx.now.toISOString()
    });
    return `Set ${reminderLine(r)}`;
  },

  async list_reminders(_input, ctx) {
    const list = await pendingReminders(ctx.env.DB);
    return list.length ? list.slice(0, 40).map(reminderLine).join('\n') : 'No upcoming reminders.';
  },

  async cancel_reminder(input, ctx) {
    const id = Number(input.id);
    const r = await first<Reminder>(ctx.env.DB, 'SELECT * FROM reminders WHERE id = ?', id);
    if (!r || r.status === 'cancelled') throw new ToolError(`No active reminder R${id}`);
    await updateRow<Reminder>(ctx.env.DB, 'reminders', id, { status: 'cancelled' });
    return `Cancelled R${id} "${r.text}"`;
  },

  async get_progress(input, ctx) {
    const today = localToday(ctx);
    const period = String(input.period);
    const from = period === 'today' ? today : period === 'week' ? weekStart(today) : `${today.slice(0, 8)}01`;
    const area = await checkArea(ctx.env, input.area);
    const stats = await progressStats(ctx.env, from, today, ctx.now);
    return formatProgressText(stats, area);
  },

  async remember(input, ctx) {
    const fact = S(input.fact);
    if (!fact) throw new ToolError('fact is empty');
    const row = await insertRow<MemoryRow>(ctx.env.DB, 'memory', { fact: fact.slice(0, 500), created_at: ctx.now.toISOString() });
    return `Remembered M${row.id}`;
  },

  async forget(input, ctx) {
    const id = Number(input.id);
    const res = await updateRow<MemoryRow>(ctx.env.DB, 'memory', id, { deleted_at: ctx.now.toISOString() });
    if (!res) throw new ToolError(`No memory M${id}`);
    return `Forgot M${id}`;
  },

  async update_routine(input, ctx) {
    const name = String(input.name) as RoutineName;
    if (!ROUTINE_NAMES.includes(name)) throw new ToolError(`unknown routine ${name}`);
    if (input.time != null) {
      await run(ctx.env.DB, 'UPDATE routines SET local_time = ? WHERE name = ?', checkTime(input.time, 'time'), name);
    }
    if (input.enabled != null) await run(ctx.env.DB, 'UPDATE routines SET enabled = ? WHERE name = ?', input.enabled ? 1 : 0, name);
    const r = await first<{ local_time: string; enabled: number }>(ctx.env.DB, 'SELECT local_time, enabled FROM routines WHERE name = ?', name);
    return `${name}: ${r?.local_time} ${r?.enabled ? 'on' : 'off'}`;
  },

  async set_quiet(input, ctx) {
    const days = Math.max(0, Math.min(60, Math.floor(Number(input.days) || 0)));
    const until = days ? addDays(localToday(ctx), days - 1) : null;
    await setState(ctx.env.DB, 'quiet_until', until);
    return until ? `Brief and check-in paused through ${until}` : 'Brief and check-in resumed';
  },

  async read_vault_note(input, ctx) {
    const { env } = ctx;
    if (!env.GITHUB_TOKEN) throw new ToolError('The vault is not connected (no GITHUB_TOKEN).');
    const path = safeVaultPath(S(input.path));
    if (path == null) throw new ToolError('Only Markdown notes and folders can be read.');
    const found = await readPath(env, env.VAULT_REPO, env.VAULT_BRANCH, path);
    if (!found) throw new ToolError(`Nothing at "${path}"`);
    if ('dir' in found) {
      const entries = found.dir.filter(e => e.type === 'dir' || e.name.endsWith('.md')).slice(0, 100);
      return entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.path}`).join('\n') || '(empty folder)';
    }
    const text = found.file.length > 20000 ? `${found.file.slice(0, 20000)}\n…(truncated)` : found.file;
    return `<untrusted source="vault:${path}">\n${text}\n</untrusted>`;
  }
};

export async function runTool(block: BetaToolUseBlock | { id: string; name: string; input: unknown }, ctx: ToolContext): Promise<BetaToolResultBlockParam> {
  const handler = handlers[block.name];
  try {
    if (!handler) throw new ToolError(`Unknown tool ${block.name}`);
    const content = await handler((block.input ?? {}) as Record<string, unknown>, ctx);
    return { type: 'tool_result', tool_use_id: block.id, content };
  } catch (e) {
    if (!(e instanceof ToolError)) console.error(`tool ${block.name} failed`, e);
    return { type: 'tool_result', tool_use_id: block.id, content: e instanceof Error ? e.message : String(e), is_error: true };
  }
}

// ---------------------------------------------------------------- progress (shared with /week)

export interface AreaStats { done: number; open: number; overdue: number }

export interface ProgressStats {
  from: string;
  to: string;
  areas: Record<string, AreaStats>;
  logs: Record<string, number>;
  moodAvg: number | null;
  checkins: number;
  days: number;
  wins: string[];
  blockers: string[];
}

export async function progressStats(env: Env, from: string, to: string, now: Date): Promise<ProgressStats> {
  const tz = env.TIMEZONE;
  const fromUtc = zonedToUtc(from, '00:00', tz).toISOString();
  const [done, active, logs, areaList] = await Promise.all([
    doneBetween(env.DB, fromUtc, now.toISOString()),
    activeTasks(env.DB),
    logsBetween(env.DB, from, to),
    getAreas(env.DB)
  ]);
  const areas: Record<string, AreaStats> = {};
  const bucket = (a: string | null) => (areas[a ?? 'other'] ??= { done: 0, open: 0, overdue: 0 });
  for (const a of areaList) bucket(a);
  for (const t of done) bucket(t.area).done++;
  for (const t of active) {
    const b = bucket(t.area);
    b.open++;
    if (t.status === 'open' && t.due_date && t.due_date < to) b.overdue++;
  }
  const counts: Record<string, number> = {};
  for (const l of logs) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
  const moods = logs.filter(l => (l.kind === 'mood' || l.kind === 'checkin') && l.value != null).map(l => l.value as number);
  return {
    from,
    to,
    areas,
    logs: counts,
    moodAvg: moods.length ? Math.round((moods.reduce((a, b) => a + b, 0) / moods.length) * 10) / 10 : null,
    checkins: new Set(logs.filter(l => l.kind === 'checkin').map(l => l.date)).size,
    days: Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1),
    wins: logs.filter(l => l.kind === 'win').map(l => l.text),
    blockers: logs.filter(l => l.kind === 'blocker').map(l => l.text)
  };
}

export function formatProgressText(s: ProgressStats, onlyArea: string | null = null): string {
  const lines = [`Period ${s.from} → ${s.to}`];
  for (const [area, a] of Object.entries(s.areas)) {
    if (onlyArea && area !== onlyArea) continue;
    if (!a.done && !a.open) continue;
    lines.push(`${area}: done ${a.done}, open ${a.open}${a.overdue ? `, overdue ${a.overdue}` : ''}`);
  }
  if (!onlyArea) {
    const logs = Object.entries(s.logs).map(([k, n]) => `${k} ${n}`).join(', ');
    if (logs) lines.push(`Logs: ${logs}`);
    if (s.moodAvg != null) lines.push(`Mood avg ${s.moodAvg}`);
    lines.push(`Check-ins ${s.checkins}/${s.days} days`);
  }
  return lines.join('\n');
}

export async function recentLogs(env: Env, days: number, now: Date): Promise<LogRow[]> {
  const today = localParts(now, env.TIMEZONE).date;
  return all<LogRow>(env.DB, 'SELECT * FROM logs WHERE deleted_at IS NULL AND date >= ? ORDER BY ts DESC LIMIT 50', addDays(today, -days));
}
