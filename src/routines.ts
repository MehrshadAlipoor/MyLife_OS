/**
 * The daily rhythm. The cron (every 5 min) sends due reminders itself and enqueues due routines;
 * the queue consumer runs them. A routine fires once per local day when its time has passed (so a
 * late or skipped cron still catches up, within 3 h for the brief and check-in), claimed atomically.
 */

import type { Env, RoutineName } from './env';
import { activeTasks, addOutbox, all, doneBetween, getAreas, getState, logsBetween, memoryFacts, pendingReminders, run, setState } from './db';
import type { LogRow, Reminder, Routine, Task } from './db';
import { commitFiles, GENERATED_MARK, isGenerated, readPath } from './github';
import { callWithFallback, ProviderUnavailable, routineModel, textOf } from './llm';
import { BRIEF_PROMPT, CHECKIN_TEXT, PLAN_REQUEST, REVIEW_PROMPT } from './prompts';
import { doneButtons, formatToday, taskHtml } from './commands';
import { runChatTurn } from './agent';
import { esc, rtl, sendHtml, sendMarkdown, warn } from './telegram';
import type { Keyboard } from './telegram';
import { progressStats } from './tools';
import { addDays, isoWeekId, localParts, minutesOf, monthName, nextOccurrence, stamp, weekStart, zonedToUtc } from './time';

/** Routines that /quiet pauses, and that are skipped if the cron is more than 3 h late. */
const QUIETABLE = new Set<RoutineName>(['morning_brief', 'evening_checkin']);
const LATE_LIMIT_MIN = 180;

export async function recordError(env: Env, text: string): Promise<void> {
  await setState(env.DB, 'last_error', { ts: new Date().toISOString(), text }).catch(() => undefined);
}

// ---------------------------------------------------------------- cron

/** Which routines are due now (pure; claiming happens in runCron). */
export function dueRoutines(list: Routine[], now: Date, tz: string): RoutineName[] {
  const p = localParts(now, tz);
  const minutes = minutesOf(p.time);
  return list
    .filter(r => {
      if (!r.enabled || !r.days.includes(String(p.weekday))) return false;
      if (r.last_run_date && r.last_run_date >= p.date) return false;
      const late = minutes - minutesOf(r.local_time);
      return late >= 0 && (!QUIETABLE.has(r.name as RoutineName) || late <= LATE_LIMIT_MIN);
    })
    .map(r => r.name as RoutineName);
}

export async function runCron(env: Env, now = new Date()): Promise<void> {
  await setState(env.DB, 'last_cron', now.toISOString());
  const errors: string[] = [];

  // A reminder stuck in 'sending' (worker died mid-send) is retried after 15 minutes.
  await run(env.DB, "UPDATE reminders SET status = 'pending' WHERE status = 'sending' AND next_due_utc <= ?", new Date(now.getTime() - 15 * 60_000).toISOString());
  const due = await all<Reminder>(env.DB, "UPDATE reminders SET status = 'sending' WHERE status = 'pending' AND next_due_utc <= ? RETURNING *", now.toISOString());
  for (const r of due) {
    try {
      await sendReminder(env, r, now);
    } catch (e) {
      // Only if it is still mid-send: once sent (or cancelled meanwhile) it must not go out again.
      await run(env.DB, "UPDATE reminders SET status = 'pending' WHERE id = ? AND status = 'sending'", r.id);
      errors.push(`reminder R${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const today = localParts(now, env.TIMEZONE).date;
  const list = await all<Routine>(env.DB, 'SELECT * FROM routines');
  for (const name of dueRoutines(list, now, env.TIMEZONE)) {
    const claimed = await all<{ name: string }>(env.DB,
      'UPDATE routines SET last_run_date = ? WHERE name = ? AND (last_run_date IS NULL OR last_run_date < ?) RETURNING name', today, name, today);
    if (claimed.length) await env.QUEUE.send({ kind: 'routine', name, date: today });
  }

  if (errors.length) {
    await recordError(env, errors.join('; '));
    await warn(env, `Cron problems: ${errors.join('; ')}`);
  }
}

export function reminderKeyboard(r: Reminder): Keyboard {
  return [[
    ...(r.task_id ? [{ text: '✅ Done', callback_data: `r:done:${r.id}` }] : []),
    { text: '⏰ +1h', callback_data: `r:snz1h:${r.id}` },
    { text: '📅 Tomorrow', callback_data: `r:tmrw:${r.id}` }
  ]];
}

async function sendReminder(env: Env, r: Reminder, now: Date): Promise<void> {
  const text = `⏰ ${r.text}`;
  await sendHtml(env, rtl(`${esc(text)}${r.task_id ? ` /T${r.task_id}` : ''}`), reminderKeyboard(r));
  const next = nextOccurrence(r.repeat, r.local_date, r.local_time, env.TIMEZONE, now);
  if (next) {
    await run(env.DB, "UPDATE reminders SET status = 'pending', next_due_utc = ?, local_date = ? WHERE id = ? AND status = 'sending'", next.utc.toISOString(), next.date, r.id);
  } else {
    await run(env.DB, "UPDATE reminders SET status = 'sent' WHERE id = ? AND status = 'sending'", r.id);
  }
  await addOutbox(env.DB, 'reminder', `${text} (R${r.id}${r.task_id ? `, task T${r.task_id}` : ''})`).catch(e => console.error('outbox', e));
}

// ---------------------------------------------------------------- routines

/** "Now" for a routine claimed for `date`: the real time, or that day's last minute if the job runs after it. */
export function routineClock(date: string, tz: string, real = new Date()): Date {
  const endOfDay = zonedToUtc(addDays(date, 1), '00:00', tz).getTime() - 60_000;
  return new Date(Math.min(real.getTime(), endOfDay));
}

export async function runRoutine(env: Env, name: RoutineName | 'day_plan', now = new Date()): Promise<void> {
  const today = localParts(now, env.TIMEZONE).date;
  const quiet = await getState<string | null>(env.DB, 'quiet_until', null);
  if (QUIETABLE.has(name as RoutineName) && quiet && quiet >= today) return;
  switch (name) {
    case 'morning_brief': return morningBrief(env, now);
    case 'evening_checkin': return eveningCheckin(env, now);
    case 'weekly_review': return weeklyReview(env, now);
    case 'vault_export': return vaultExport(env, now);
    case 'backup': return backup(env, now);
    case 'day_plan': {
      const res = await runChatTurn(env, [{ type: 'text', text: PLAN_REQUEST }], [], 'command');
      await sendMarkdown(env, res.reply);
      return;
    }
  }
}

/** The routine model (or the chat model past the soft cap) for a one-shot routine text; tells the owner once a month when capped. */
async function routineText(env: Env, kind: 'brief' | 'review', system: string, data: unknown, now: Date): Promise<string> {
  const { model, capped } = await routineModel(env, now);
  if (capped) {
    const month = localParts(now, env.TIMEZONE).date.slice(0, 7);
    if ((await getState<string | null>(env.DB, 'cap_notice', null)) !== month) {
      await setState(env.DB, 'cap_notice', month);
      await sendHtml(env, `💸 This month's AI spend reached the $${esc(env.MONTHLY_CAP_USD)} soft cap, so routines now use the chat model until next month.`);
    }
  }
  const res = await callWithFallback(env, {
    kind,
    model,
    effort: kind === 'review' ? 'high' : 'medium',
    system,
    messages: [{ role: 'user', content: JSON.stringify(data) }],
    maxTokens: kind === 'review' ? 16000 : 8000,
    timeoutMs: 120_000
  });
  if (res.stopReason === 'refusal') throw new Error('the model declined');
  return textOf(res.content);
}

const compactTask = (t: Task) => ({ id: `T${t.id}`, title: t.title, area: t.area, due: t.due_date, time: t.due_time, priority: t.priority, status: t.status });

export async function briefData(env: Env, now: Date) {
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const [tasks, reminders, memory, logs] = await Promise.all([
    activeTasks(env.DB),
    pendingReminders(env.DB),
    memoryFacts(env.DB),
    logsBetween(env.DB, addDays(today, -1), today)
  ]);
  const open = tasks.filter(t => t.status === 'open');
  return {
    today: stamp(now, tz),
    overdue: open.filter(t => t.due_date && t.due_date < today).map(compactTask),
    due_today: open.filter(t => t.due_date === today).map(compactTask),
    candidates: open.filter(t => !t.due_date || t.due_date > today).sort((a, b) => a.priority - b.priority).slice(0, 12).map(compactTask),
    reminders_today: reminders
      .filter(r => localParts(new Date(r.next_due_utc), tz).date === today)
      .map(r => ({ time: localParts(new Date(r.next_due_utc), tz).time, text: r.text })),
    remembered_facts: memory.map(m => m.fact),
    yesterday: logs.filter(l => l.date < today).map(l => ({ kind: l.kind, text: l.text, value: l.value }))
  };
}

/** The no-LLM brief: used when the model provider is unavailable. */
export function templateBrief(tasks: Task[], reminders: Reminder[], today: string, tz: string): { html: string; keyboard: Keyboard } {
  const view = formatToday(tasks, reminders, today, tz, null);
  return { html: `☀️ Good morning!\n\n${view.html}\n\n<i>What is the one thing that would make today a win?</i>`, keyboard: view.keyboard };
}

async function morningBrief(env: Env, now: Date): Promise<void> {
  const data = await briefData(env, now);
  const known = new Set([...data.overdue, ...data.due_today, ...data.candidates].map(t => Number(t.id.slice(1))));
  let md = '';
  try {
    md = await routineText(env, 'brief', BRIEF_PROMPT, data, now);
  } catch (e) {
    if (!(e instanceof ProviderUnavailable)) await recordError(env, `morning brief: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (md) {
    // Once the AI brief is out, nothing falls back to the template (that would send two briefs).
    const ids = [...new Set([...md.matchAll(/\/T(\d+)/g)].map(m => Number(m[1])))].filter(id => known.has(id)).slice(0, 3);
    await sendMarkdown(env, md, doneButtons(ids));
    await addOutbox(env.DB, 'morning_brief', md);
  } else {
    const today = localParts(now, env.TIMEZONE).date;
    const fallback = templateBrief(await activeTasks(env.DB), await pendingReminders(env.DB), today, env.TIMEZONE);
    await sendHtml(env, fallback.html, fallback.keyboard);
    await addOutbox(env.DB, 'morning_brief', fallback.html.replace(/<[^>]+>/g, ''));
  }
}

async function eveningCheckin(env: Env, now: Date): Promise<void> {
  const today = localParts(now, env.TIMEZONE).date;
  const open = (await activeTasks(env.DB)).filter(t => t.status === 'open' && t.due_date && t.due_date <= today);
  const html = [CHECKIN_TEXT, ...(open.length ? ['', '<b>Still open for today</b>', ...open.map(t => taskHtml(t, today))] : [])].join('\n');
  await sendHtml(env, html, doneButtons(open.map(t => t.id)));
  await addOutbox(env.DB, 'evening_checkin', html.replace(/<[^>]+>/g, ''));
}

// ---------------------------------------------------------------- weekly review

export async function weekData(env: Env, now: Date) {
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const from = weekStart(today);
  const [stats, done, tasks, logs] = await Promise.all([
    progressStats(env, from, today, now),
    doneBetween(env.DB, zonedToUtc(from, '00:00', tz).toISOString(), now.toISOString()),
    activeTasks(env.DB),
    logsBetween(env.DB, from, today)
  ]);
  return {
    week: isoWeekId(today),
    from,
    to: today,
    per_area: stats.areas,
    mood_avg: stats.moodAvg,
    checkins: `${stats.checkins}/${stats.days} days`,
    done: done.map(compactTask),
    overdue: tasks.filter(t => t.status === 'open' && t.due_date && t.due_date < today).map(compactTask),
    open: tasks.filter(t => t.status === 'open').slice(0, 40).map(compactTask),
    backlog: tasks.filter(t => t.status === 'open' && !t.due_date).sort((a, b) => a.priority - b.priority || a.id - b.id).slice(0, 20).map(compactTask),
    waiting: tasks.filter(t => t.status === 'waiting').map(compactTask),
    logs: logs.map((l: LogRow) => ({ date: l.date, kind: l.kind, text: l.text, area: l.area, value: l.value }))
  };
}

export function templateReview(data: Awaited<ReturnType<typeof weekData>>): string {
  const lines = [`**Week ${data.week}** (${data.from} → ${data.to})`, '', '**By area**'];
  for (const [area, a] of Object.entries(data.per_area)) {
    if (a.done || a.open) lines.push(`- ${area}: done ${a.done}, open ${a.open}${a.overdue ? `, overdue ${a.overdue}` : ''}`);
  }
  lines.push('', `Check-ins ${data.checkins}${data.mood_avg != null ? ` · mood ${data.mood_avg}` : ''}`);
  if (data.overdue.length) lines.push('', '**Slipped**', ...data.overdue.map(t => `- ${t.title} /${t.id}`));
  return lines.join('\n');
}

async function weeklyReview(env: Env, now: Date): Promise<void> {
  const data = await weekData(env, now);
  let md: string;
  try {
    md = await routineText(env, 'review', REVIEW_PROMPT, data, now);
    if (!md) throw new Error('empty review');
  } catch (e) {
    if (!(e instanceof ProviderUnavailable)) await recordError(env, `weekly review: ${e instanceof Error ? e.message : String(e)}`);
    md = `${templateReview(data)}\n\n_(AI review unavailable — numbers only)_`;
  }
  await sendMarkdown(env, `📊 ${md}`);
  await addOutbox(env.DB, 'weekly_review', md);
  if (env.GITHUB_TOKEN) {
    const path = `Assistant/Reviews/${data.week}.md`;
    const note = `---\n${GENERATED_MARK}\nweek: ${data.week}\ncreated: ${now.toISOString()}\n---\n\n# Weekly review ${data.week}\n\n${md.replace(/\/T(\d+)/g, '#T$1')}\n`;
    try {
      if (await writableVaultPath(env, path)) await commitFiles(env, env.VAULT_REPO, env.VAULT_BRANCH, `life-os: weekly review ${data.week}`, [{ path, content: note }]);
    } catch (e) {
      await recordError(env, `review note: ${e instanceof Error ? e.message : String(e)}`);
      await warn(env, `Couldn't save the review to the vault: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------- vault export + backup

/** A path the bot may write: missing, or a file it generated itself. */
async function writableVaultPath(env: Env, path: string): Promise<boolean> {
  const existing = await readPath(env, env.VAULT_REPO, env.VAULT_BRANCH, path);
  if (!existing) return true;
  if ('file' in existing && isGenerated(existing.file)) return true;
  await warn(env, `Skipped writing ${path}: a note you wrote is already there.`);
  return false;
}

export function dailyLogPath(date: string): string {
  const [y, m, d] = date.split('-');
  return `TimeLine/${y}/${m} - ${monthName(Number(m))}/${y!.slice(2)}${m}${d} - life-os log.md`;
}

export function tasksMarkdown(tasks: Task[], doneThisWeek: Task[], areas: string[], today: string, nowIso: string): string {
  const lines = ['---', GENERATED_MARK, `updated: ${nowIso}`, '---', '', '# Tasks', '', '_Generated by Life-OS from its database each night; edits here are overwritten. Change tasks in Telegram._', ''];
  const open = tasks.filter(t => t.status === 'open');
  const order = [...areas, ...new Set(open.map(t => t.area ?? 'other').filter(a => !areas.includes(a)))];
  for (const area of order) {
    const list = open.filter(t => (t.area ?? 'other') === area);
    if (!list.length) continue;
    lines.push(`## ${area}`, '');
    for (const t of list) {
      lines.push(`- [ ] ${t.title}${t.due_date ? ` 📅 ${t.due_date}${t.due_time ? ` ${t.due_time}` : ''}` : ''}${t.priority === 1 ? ' ⏫' : ''} #T${t.id}`);
    }
    lines.push('');
  }
  const waiting = tasks.filter(t => t.status === 'waiting');
  if (waiting.length) lines.push('## Waiting on', '', ...waiting.map(t => `- [ ] ${t.title} #T${t.id}`), '');
  if (doneThisWeek.length) lines.push('## Done this week', '', ...doneThisWeek.map(t => `- [x] ${t.title}${t.area ? ` (${t.area})` : ''} #T${t.id}`), '');
  if (!open.length && !waiting.length) lines.push(`No open tasks on ${today}.`, '');
  return lines.join('\n');
}

export function dailyLogMarkdown(date: string, done: Task[], logs: LogRow[], nowIso: string): string {
  const lines = ['---', GENERATED_MARK, `date: ${date}`, `updated: ${nowIso}`, '---', '', `# Life-OS log · ${date}`, ''];
  if (done.length) lines.push('## Done', '', ...done.map(t => `- [x] ${t.title}${t.area ? ` (${t.area})` : ''}`), '');
  const byKind = new Map<string, LogRow[]>();
  for (const l of logs) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l]);
  const titles: Record<string, string> = { checkin: 'Check-in', progress: 'Progress', win: 'Wins', blocker: 'Blockers', mood: 'Mood', habit: 'Habits', note: 'Notes' };
  for (const [kind, title] of Object.entries(titles)) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    lines.push(`## ${title}`, '', ...list.map(l => `- ${l.value != null ? `(${l.value}) ` : ''}${l.text}${l.area ? ` (${l.area})` : ''}`), '');
  }
  if (!done.length && !logs.length) lines.push('_Nothing logged today._', '');
  return lines.join('\n');
}

async function vaultExport(env: Env, now: Date): Promise<void> {
  if (!env.GITHUB_TOKEN) return;
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const [tasks, areas, doneWeek, doneToday, logs] = await Promise.all([
    activeTasks(env.DB),
    getAreas(env.DB),
    doneBetween(env.DB, zonedToUtc(weekStart(today), '00:00', tz).toISOString(), now.toISOString()),
    doneBetween(env.DB, zonedToUtc(today, '00:00', tz).toISOString(), now.toISOString()),
    logsBetween(env.DB, today, today)
  ]);
  const files = [
    { path: 'Assistant/TASKS.md', content: tasksMarkdown(tasks, doneWeek, areas, today, now.toISOString()) },
    { path: dailyLogPath(today), content: dailyLogMarkdown(today, doneToday, logs, now.toISOString()) }
  ];
  const writable = [];
  for (const f of files) if (await writableVaultPath(env, f.path)) writable.push(f);
  if (writable.length) await commitFiles(env, env.VAULT_REPO, env.VAULT_BRANCH, `life-os: export ${today}`, writable);
}

const BACKUP_TABLES = ['tasks', 'logs', 'reminders', 'routines', 'memory', 'state', 'usage', 'outbox'] as const;

async function backup(env: Env, now: Date): Promise<void> {
  if (!env.GITHUB_TOKEN) return;
  const tables: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) tables[table] = await all(env.DB, `SELECT * FROM ${table}`);
  const date = localParts(now, env.TIMEZONE).date;
  await commitFiles(env, env.BACKUP_REPO, env.BACKUP_BRANCH, `backup ${date}`,
    [{ path: `backups/${date}.json`, content: JSON.stringify({ exported_at: now.toISOString(), tables }, null, 1) }], true);
}
