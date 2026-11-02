/**
 * Slash commands and inline buttons. These run directly in the webhook (D1 only, no LLM), so they
 * answer instantly and keep working when the model is down. Formatters are pure for testing.
 */

import type { Env, RoutineName, TgCallbackQuery } from './env';
import { ROUTINE_NAMES } from './env';
import { activeTasks, applyUndo, first, getAreas, getState, getTask, insertRow, peekUndo, pendingReminders, routines, run, setState, updateRow } from './db';
import type { Reminder, Routine, Task } from './db';
import { closeSession } from './agent';
import { breakerState, monthToDateUsd } from './llm';
import { answerCallback, editHtml, esc, rtl, sendHtml, tg } from './telegram';
import type { Keyboard } from './telegram';
import { progressStats } from './tools';
import type { ProgressStats } from './tools';
import { addDays, isTime, localParts, nextOccurrence, relativeDay, shortDate, weekStart, zonedToUtc } from './time';

export const COMMANDS: [string, string][] = [
  ['today', 'agenda: overdue, due today, reminders'],
  ['tasks', 'open tasks by area (/tasks phd)'],
  ['week', 'progress this week'],
  ['plan', 'plan my day (AI)'],
  ['review', 'weekly review now (AI)'],
  ['routine', 'show or change routines'],
  ['quiet', 'pause brief + check-in (/quiet 3d, /quiet off)'],
  ['areas', 'show or set life areas (/areas phd lab mms)'],
  ['undo', 'revert the last task/reminder/log change (asks first)'],
  ['new', 'start a fresh conversation'],
  ['status', 'models, monthly cost, health']
];

const ROUTINE_ALIASES: Record<string, RoutineName> = {
  morning: 'morning_brief', brief: 'morning_brief', morning_brief: 'morning_brief',
  evening: 'evening_checkin', checkin: 'evening_checkin', evening_checkin: 'evening_checkin',
  review: 'weekly_review', weekly: 'weekly_review', weekly_review: 'weekly_review',
  export: 'vault_export', vault: 'vault_export', vault_export: 'vault_export',
  backup: 'backup'
};

const DAY_LETTERS = ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// ---------------------------------------------------------------- formatters (pure)

export function taskHtml(t: Task, today: string): string {
  const icon = t.status === 'waiting' ? '⏳' : t.due_date && t.due_date < today ? '🟠' : t.due_date === today ? '🟡' : '▫️';
  const due = t.due_date ? ` · ${relativeDay(t.due_date, today)}${t.due_time ? ` ${t.due_time}` : ''}` : '';
  return rtl(`${icon} ${t.priority === 1 ? '❗' : ''}${esc(t.title)}${t.area ? ` · <i>${esc(t.area)}</i>` : ''}${due} /T${t.id}`);
}

export const doneButtons = (ids: number[]): Keyboard => (ids.length ? [ids.slice(0, 4).map(id => ({ text: `✅ T${id}`, callback_data: `t:done:${id}` }))] : []);

export function formatToday(tasks: Task[], reminders: Reminder[], today: string, tz: string, quietUntil: string | null): { html: string; keyboard: Keyboard } {
  const open = tasks.filter(t => t.status === 'open');
  const overdue = open.filter(t => t.due_date && t.due_date < today);
  const dueToday = open.filter(t => t.due_date === today);
  const next = open.filter(t => !t.due_date || t.due_date > today).sort((a, b) => a.priority - b.priority || a.id - b.id).slice(0, 5);
  const todaysReminders = reminders.filter(r => localParts(new Date(r.next_due_utc), tz).date === today);
  const lines = [`<b>📅 Today · ${shortDate(today, today)}</b>`];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push('', `<b>${title}</b>`, ...items);
  };
  section('Overdue', overdue.map(t => taskHtml(t, today)));
  section('Due today', dueToday.map(t => taskHtml(t, today)));
  section('Reminders', todaysReminders.map(r => rtl(`⏰ ${localParts(new Date(r.next_due_utc), tz).time} ${esc(r.text)}${r.task_id ? ` /T${r.task_id}` : ''}`)));
  section('Next up', next.map(t => taskHtml(t, today)));
  if (lines.length === 1) lines.push('', 'Nothing scheduled. Tell me what you want to get done today.');
  if (quietUntil && quietUntil >= today) lines.push('', `<i>Brief and check-in paused through ${shortDate(quietUntil, today)}.</i>`);
  const focus = [...overdue, ...dueToday, ...next].slice(0, 3).map(t => t.id);
  return { html: lines.join('\n'), keyboard: doneButtons(focus) };
}

export function formatTasks(tasks: Task[], today: string, area: string | null): string {
  const shown = area ? tasks.filter(t => t.area === area) : tasks;
  if (!shown.length) return area ? `No open tasks in <i>${esc(area)}</i>.` : 'No open tasks. 🎉';
  const groups = new Map<string, Task[]>();
  for (const t of shown) {
    const key = t.area ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const lines = [`<b>🗂 Open tasks (${shown.length})</b>`];
  for (const [name, list] of groups) lines.push('', `<b>${esc(name)}</b>`, ...list.map(t => taskHtml(t, today)));
  return lines.join('\n');
}

export function bar(done: number, total: number, width = 8): string {
  if (!total) return '░'.repeat(width);
  const filled = Math.min(width, Math.max(0, Math.round((done / total) * width)));
  return '▇'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatWeek(s: ProgressStats, today: string): string {
  const rows = Object.entries(s.areas).filter(([, a]) => a.done || a.open);
  const width = Math.max(4, ...rows.map(([name]) => name.length));
  const lines = [`<b>📈 Week of ${shortDate(s.from, today)}</b>`];
  if (rows.length) {
    lines.push(`<pre>${rows
      .map(([name, a]) => `${esc(name.padEnd(width))} ${bar(a.done, a.done + a.open)} ${a.done}/${a.done + a.open}${a.overdue ? ` (${a.overdue} late)` : ''}`)
      .join('\n')}</pre>`);
  } else {
    lines.push('No tasks yet this week.');
  }
  const extras = [
    `check-ins ${s.checkins}/${s.days}`,
    s.moodAvg != null ? `mood ${s.moodAvg}` : '',
    s.logs.win ? `${s.logs.win} wins` : '',
    s.logs.blocker ? `${s.logs.blocker} blockers` : ''
  ].filter(Boolean);
  lines.push(extras.join(' · '));
  return lines.join('\n');
}

export function formatRoutines(list: Routine[], quietUntil: string | null, today: string): string {
  const lines = ['<b>⏱ Routines</b>'];
  for (const r of list) {
    const days = r.days === '1234567' ? 'daily' : r.days === '12345' ? 'weekdays' : [...r.days].map(d => DAY_LETTERS[Number(d)]).join(' ');
    lines.push(`${r.enabled ? '🟢' : '⚪️'} <code>${r.name}</code> ${r.local_time} ${days}`);
  }
  if (quietUntil && quietUntil >= today) lines.push('', `Paused through ${shortDate(quietUntil, today)} (/quiet off to resume)`);
  lines.push('', 'Change: <code>/routine morning 07:30</code>, <code>/routine checkin off</code>');
  return lines.join('\n');
}

export function taskCard(t: Task, today: string): { html: string; keyboard: Keyboard } {
  const lines = [taskHtml(t, today), `Status: ${t.status} · priority ${t.priority}`];
  if (t.notes) lines.push(rtl(esc(t.notes)));
  const keyboard: Keyboard = t.status === 'open' || t.status === 'waiting'
    ? [[
        { text: '✅ Done', callback_data: `t:done:${t.id}` },
        { text: '⏰ +1h', callback_data: `t:snz1h:${t.id}` },
        { text: '📅 Tomorrow', callback_data: `t:tmrw:${t.id}` },
        { text: '🗑 Drop', callback_data: `t:drop:${t.id}` }
      ]]
    : [];
  return { html: lines.join('\n'), keyboard };
}

// ---------------------------------------------------------------- commands

/** Commands that need the model: the webhook queues them instead of answering inline. */
export const QUEUED_COMMANDS = new Set(['plan', 'review']);

export function parseCommand(text: string): { name: string; args: string } | null {
  const m = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { name: (m[1] ?? '').toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

/** Handle an inline command. Returns false if the text isn't one (it then goes to the agent). */
export async function handleCommand(env: Env, name: string, args: string, now: Date): Promise<boolean> {
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const taskMatch = name.match(/^t(\d+)$/);
  if (taskMatch) {
    const task = await getTask(env.DB, Number(taskMatch[1]));
    if (!task) await sendHtml(env, `No task /T${taskMatch[1]}.`);
    else {
      const card = taskCard(task, today);
      await sendHtml(env, card.html, card.keyboard);
    }
    return true;
  }
  switch (name) {
    case 'start':
    case 'help':
      await sendHtml(env, [
        '<b>👋 Life-OS</b>',
        'Talk to me by text, voice note or photo: tasks, reminders, progress, how your day went.',
        '',
        ...COMMANDS.map(([c, d]) => `/${c} — ${esc(d)}`),
        '',
        'Tip: start by telling me your fixed commitments, e.g. "I do client calls 15:00–16:30 on weekdays".'
      ].join('\n'));
      return true;
    case 'today': {
      const [tasks, reminders, quiet] = await Promise.all([activeTasks(env.DB), pendingReminders(env.DB), getState<string | null>(env.DB, 'quiet_until', null)]);
      const view = formatToday(tasks, reminders, today, tz, quiet);
      await sendHtml(env, view.html, view.keyboard);
      return true;
    }
    case 'tasks':
      await sendHtml(env, formatTasks(await activeTasks(env.DB), today, args ? args.toLowerCase() : null));
      return true;
    case 'week':
      await sendHtml(env, formatWeek(await progressStats(env, weekStart(today), today, now), today));
      return true;
    case 'new':
      await closeSession(env);
      await sendHtml(env, '🆕 Fresh conversation. Your tasks and notes are all still here.');
      return true;
    case 'undo': {
      const change = await peekUndo(env.DB);
      if (!change) await sendHtml(env, 'Nothing to undo (routine and setting changes are changed back directly).');
      else await sendHtml(env, `↩️ ${esc(change.label)}?`, [[{ text: '↩️ Undo it', callback_data: `u:yes:${change.id}` }, { text: 'Cancel', callback_data: 'u:no:0' }]]);
      return true;
    }
    case 'routine':
      await routineCommand(env, args, today);
      return true;
    case 'quiet': {
      const off = /^(off|0|resume)$/i.test(args);
      const days = off ? 0 : Number((args.match(/\d+/) ?? ['1'])[0]);
      const until = days ? addDays(today, days - 1) : null;
      await setState(env.DB, 'quiet_until', until);
      await sendHtml(env, until ? `🤫 Brief and check-in paused through ${shortDate(until, today)}. Reminders still come.` : '🔔 Brief and check-in are back on.');
      return true;
    }
    case 'status':
      await sendHtml(env, await statusText(env, now));
      return true;
    case 'areas': {
      if (args) {
        const areas = [...new Set(args.toLowerCase().split(/[\s,]+/).filter(a => /^[\p{L}\p{N}_-]{2,24}$/u.test(a)))];
        if (areas.length) await setState(env.DB, 'areas', areas);
      }
      const areas = await getAreas(env.DB);
      await sendHtml(env, `<b>🧭 Areas</b>\n${areas.map(a => `• ${esc(a)}`).join('\n')}\n\nChange: <code>/areas phd lab mms mimmo health admin personal</code>`);
      return true;
    }
    default:
      return false;
  }
}

async function routineCommand(env: Env, args: string, today: string): Promise<void> {
  const [rawName, value] = args.split(/\s+/);
  const quiet = await getState<string | null>(env.DB, 'quiet_until', null);
  if (!rawName) {
    await sendHtml(env, formatRoutines(await routines(env.DB), quiet, today));
    return;
  }
  const name = ROUTINE_ALIASES[rawName.toLowerCase()];
  if (!name || !ROUTINE_NAMES.includes(name)) {
    await sendHtml(env, `Unknown routine "${esc(rawName)}". Try: morning, checkin, review, export, backup.`);
    return;
  }
  if (value && isTime(value)) await run(env.DB, 'UPDATE routines SET local_time = ? WHERE name = ?', value, name);
  else if (value && /^(on|off)$/i.test(value)) await run(env.DB, 'UPDATE routines SET enabled = ? WHERE name = ?', /^on$/i.test(value) ? 1 : 0, name);
  else if (value) {
    await sendHtml(env, 'Use a time like 07:30, or on / off.');
    return;
  }
  await sendHtml(env, formatRoutines(await routines(env.DB), quiet, today));
}

export async function statusText(env: Env, now: Date): Promise<string> {
  const [mtd, breaker, lastCron, lastError, session] = await Promise.all([
    monthToDateUsd(env, now),
    breakerState(env),
    getState<string | null>(env.DB, 'last_cron', null),
    getState<{ ts: string; text: string } | null>(env.DB, 'last_error', null),
    first<{ id: number; token_estimate: number }>(env.DB, 'SELECT id, token_estimate FROM sessions WHERE closed = 0 ORDER BY id DESC LIMIT 1')
  ]);
  const cap = Number(env.MONTHLY_CAP_USD) || 0;
  const tz = env.TIMEZONE;
  const at = (iso: string) => `${localParts(new Date(iso), tz).date} ${localParts(new Date(iso), tz).time}`;
  return [
    '<b>🩺 Status</b>',
    `Chat: <code>${esc(env.CHAT_MODEL)}</code> · routines: <code>${esc(env.ROUTINE_MODEL)}</code>`,
    `This month: $${mtd.toFixed(2)}${cap ? ` of $${cap} soft cap ${bar(mtd, cap)}` : ''}`,
    `Claude: ${breaker.openUntil > now.getTime() ? `paused until ${localParts(new Date(breaker.openUntil), tz).time}` : 'ok'}`,
    `DeepSeek fallback: ${env.DEEPSEEK_API_KEY ? 'available (asks first)' : 'not configured'}`,
    `Vault: ${env.GITHUB_TOKEN ? esc(env.VAULT_REPO) : 'not connected'}`,
    `Last cron: ${lastCron ? at(lastCron) : 'never'}`,
    `Conversation: ${session ? `#${session.id}, ~${Math.round(session.token_estimate / 1000)}k tokens` : 'none open'}`,
    lastError ? `Last error (${at(lastError.ts)}): ${esc(lastError.text.slice(0, 300))}` : 'No errors recorded.'
  ].join('\n');
}

// ---------------------------------------------------------------- buttons

/** Replace the pressed button with a label, keeping the rest of the keyboard. */
function markPressed(keyboard: Keyboard | undefined, data: string, label: string): Keyboard {
  return (keyboard ?? []).map(row => row.map(b => (b.callback_data === data ? { text: label, callback_data: 'noop' } : b)));
}

async function remindIn(env: Env, text: string, taskId: number | null, at: Date): Promise<number> {
  const p = localParts(at, env.TIMEZONE);
  const r = await insertRow<Reminder>(env.DB, 'reminders', {
    text,
    next_due_utc: at.toISOString(),
    local_date: p.date,
    local_time: p.time,
    repeat: 'none',
    task_id: taskId,
    created_at: new Date().toISOString()
  });
  return r.id;
}

export interface ButtonResult { toast: string; label?: string; enqueueFallback?: number; replaceText?: string }

/** Apply a button tap to the database. Pure of Telegram I/O so it can be tested. */
export async function applyButton(env: Env, data: string, now: Date): Promise<ButtonResult> {
  const [scope, action, rawId] = data.split(':');
  const id = Number(rawId);
  const tz = env.TIMEZONE;
  const today = localParts(now, tz).date;
  const tomorrowSameTime = (time: string) => zonedToUtc(addDays(today, 1), time, tz);

  if (scope === 't') {
    const task = await getTask(env.DB, id);
    if (!task) return { toast: 'That task no longer exists' };
    switch (action) {
      case 'done':
        await updateRow<Task>(env.DB, 'tasks', id, { status: 'done', done_at: now.toISOString() });
        return { toast: `✅ Done: ${task.title}`, label: `✅ T${id}` };
      case 'drop':
        await updateRow<Task>(env.DB, 'tasks', id, { status: 'dropped' });
        return { toast: `🗑 Dropped: ${task.title}`, label: `🗑 T${id}` };
      case 'tmrw':
        await updateRow<Task>(env.DB, 'tasks', id, { due_date: addDays(today, 1) });
        return { toast: `📅 Moved to tomorrow: ${task.title}`, label: `📅 T${id}` };
      case 'snz1h': {
        const at = new Date(now.getTime() + 3600_000);
        await remindIn(env, task.title, id, at);
        return { toast: `⏰ I'll remind you at ${localParts(at, tz).time}`, label: `⏰ ${localParts(at, tz).time}` };
      }
    }
  }

  if (scope === 'r') {
    const r = await first<Reminder>(env.DB, 'SELECT * FROM reminders WHERE id = ?', id);
    if (!r) return { toast: 'That reminder no longer exists' };
    switch (action) {
      case 'done':
        if (r.task_id) await updateRow<Task>(env.DB, 'tasks', r.task_id, { status: 'done', done_at: now.toISOString() });
        return { toast: r.task_id ? '✅ Task done' : '👍', label: '✅ Done' };
      case 'snz1h': {
        const at = new Date(now.getTime() + 3600_000);
        await remindIn(env, r.text, r.task_id, at);
        return { toast: `⏰ Again at ${localParts(at, tz).time}`, label: `⏰ ${localParts(at, tz).time}` };
      }
      case 'tmrw': {
        if (r.repeat === 'daily' || r.repeat === 'weekdays') return { toast: 'It repeats anyway 🙂' };
        await remindIn(env, r.text, r.task_id, tomorrowSameTime(r.local_time));
        return { toast: `📅 Tomorrow ${r.local_time}`, label: '📅 Tomorrow' };
      }
    }
  }

  if (scope === 'u') {
    if (action !== 'yes') return { toast: 'OK', replaceText: 'Nothing changed.' };
    const done = await applyUndo(env.DB, id, r => nextOccurrence(r.repeat, r.local_date, r.local_time, tz, now));
    return done ? { toast: '↩️ Undone', replaceText: `↩️ ${done}` } : { toast: 'Already undone' };
  }

  if (scope === 'fb') {
    const pending = await first<{ id: number }>(env.DB, "UPDATE pending_fallbacks SET status = ? WHERE id = ? AND status = 'pending' RETURNING id",
      action === 'yes' ? 'approved' : 'dismissed', id);
    if (!pending) return { toast: 'Already handled' };
    return action === 'yes'
      ? { toast: 'Sending via DeepSeek…', enqueueFallback: id, replaceText: '⚡ Sending via DeepSeek…' }
      : { toast: 'OK', replaceText: '👌 Kept your message; I\'ll answer it next time you write.' };
  }

  return { toast: 'Already handled' };
}

export async function handleCallback(env: Env, query: TgCallbackQuery, now: Date): Promise<void> {
  const data = query.data ?? '';
  if (data === 'noop') {
    await answerCallback(env, query.id);
    return;
  }
  const result = await applyButton(env, data, now);
  await answerCallback(env, query.id, result.toast);
  if (result.enqueueFallback) await env.QUEUE.send({ kind: 'fallback', id: result.enqueueFallback });
  const message = query.message;
  if (!message) return;
  if (result.replaceText) {
    await editHtml(env, message.message_id, esc(result.replaceText));
  } else if (result.label) {
    await tg(env, 'editMessageReplyMarkup', {
      chat_id: env.OWNER_ID,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: markPressed(message.reply_markup?.inline_keyboard, data, result.label) }
    }).catch(() => undefined);
  }
}
