import { beforeEach, describe, expect, it } from 'vitest';
import { applyUndo, getTask, peekUndo } from '../src/db';
import type { Reminder } from '../src/db';
import { runTool } from '../src/tools';
import { resetDb, testEnv } from './helpers';

const env = testEnv();
const now = new Date('2026-11-02T14:00:00Z'); // Mon 15:00 in Rome
const call = (name: string, input: Record<string, unknown>) => runTool({ id: 'toolu_x', name, input }, { env, now, source: 'voice' });
const task = (id: number) => getTask(env.DB, id);
const noReschedule = () => null;
async function undoLast(): Promise<string | null> {
  const change = await peekUndo(env.DB);
  return change ? applyUndo(env.DB, change.id, noReschedule) : null;
}

beforeEach(() => resetDb(env));

describe('tasks', () => {
  it('adds a task, validating the area', async () => {
    const bad = await call('add_task', { title: 'Call Mimmo', area: 'clients', due_date: null, due_time: null, priority: null, notes: null });
    expect(bad.is_error).toBe(true);
    expect(bad.content).toContain('Areas: phd, lab, mms, mimmo');

    const ok = await call('add_task', { title: 'Call Mimmo', area: 'Mimmo', due_date: '2026-11-03', due_time: '10:00', priority: 1, notes: null });
    expect(ok.is_error).toBeUndefined();
    expect(ok.content).toMatch(/^Added T\d+ \| Call Mimmo \| mimmo \| due 2026-11-03 10:00 \| p1$/);
    const id = Number(String(ok.content).match(/T(\d+)/)![1]);
    expect(await task(id)).toMatchObject({ area: 'mimmo', source: 'voice', status: 'open' });
  });

  it('assumes today when only a time is given', async () => {
    const res = await call('add_task', { title: 'Gym', area: null, due_date: null, due_time: '18:00', priority: null, notes: null });
    expect(res.content).toContain('due 2026-11-02 18:00');
  });

  it('completes, clears dates, and rejects bad input', async () => {
    const added = await call('add_task', { title: 'Draft SOP', area: 'phd', due_date: '2026-11-01', due_time: null, priority: null, notes: null });
    const id = Number(String(added.content).match(/T(\d+)/)![1]);
    await call('update_task', { id, title: null, area: null, due_date: '', due_time: null, priority: null, status: 'done', notes: null });
    expect(await task(id)).toMatchObject({ status: 'done', due_date: null });
    expect((await task(id))?.done_at).toBe(now.toISOString());

    const bad = await call('update_task', { id, title: null, area: null, due_date: '2026-13-01', due_time: null, priority: null, status: null, notes: null });
    expect(bad).toMatchObject({ is_error: true });
    expect((await call('update_task', { id: 999, title: 'x', area: null, due_date: null, due_time: null, priority: null, status: null, notes: null })).is_error).toBe(true);
  });

  it('filters the list', async () => {
    for (const [title, due] of [['old', '2026-10-30'], ['now', '2026-11-02'], ['later', '2026-11-20'], ['someday', null]] as const) {
      await call('add_task', { title, area: null, due_date: due, due_time: null, priority: null, notes: null });
    }
    const today = String((await call('list_tasks', { filter: 'today', area: null })).content);
    expect(today).toContain('old');
    expect(today).toContain('now');
    expect(today).not.toContain('later');
    expect(String((await call('list_tasks', { filter: 'overdue', area: null })).content)).not.toContain('now');
    expect(String((await call('list_tasks', { filter: 'all_open', area: null })).content).split('\n')).toHaveLength(4);
  });

  it('undoes the last change, then the creation', async () => {
    const added = await call('add_task', { title: 'Write email', area: null, due_date: null, due_time: null, priority: null, notes: null });
    const id = Number(String(added.content).match(/T(\d+)/)![1]);
    await call('update_task', { id, title: 'Write the email', area: null, due_date: null, due_time: null, priority: null, status: null, notes: null });
    expect((await peekUndo(env.DB))?.label).toContain('Restore the previous version of task');
    expect(await undoLast()).toContain('Restored task');
    expect((await task(id))?.title).toBe('Write email');
    expect(await undoLast()).toContain('Removed task');
    expect(await task(id)).toBeNull();
    expect(await undoLast()).toBeNull();
  });
});

describe('reminders', () => {
  it('starts an every-weekday reminder set on a weekend on Monday', async () => {
    const saturday = new Date('2026-11-07T10:00:00Z');
    await runTool({ id: 't', name: 'set_reminder', input: { text: 'standup', date: '2026-11-08', time: '08:00', repeat: 'weekdays', task_id: null } }, { env, now: saturday, source: 'chat' });
    expect((await env.DB.prepare('SELECT local_date FROM reminders').first<Reminder>())?.local_date).toBe('2026-11-09');
  });

  it('undoing a cancel never fires a one-off reminder late', async () => {
    await env.DB.prepare(`INSERT INTO reminders (id, text, next_due_utc, local_date, local_time, repeat, created_at) VALUES (1, 'old', '2026-11-01T09:00:00.000Z', '2026-11-01', '10:00', 'none', '')`).run();
    await call('cancel_reminder', { id: 1 });
    expect(await undoLast()).toContain('stays off');
    expect((await env.DB.prepare('SELECT status FROM reminders').first<Reminder>())?.status).toBe('cancelled');
  });

  it('stores local time and the UTC instant', async () => {
    const res = await call('set_reminder', { text: 'Call Mimmo', date: '2026-11-03', time: '10:00', repeat: 'none', task_id: null });
    expect(res.content).toContain('R');
    const r = await env.DB.prepare('SELECT * FROM reminders').first<Reminder>();
    expect(r).toMatchObject({ local_date: '2026-11-03', local_time: '10:00', next_due_utc: '2026-11-03T09:00:00.000Z', status: 'pending' });
  });

  it('rejects one-off times in the past but rolls repeating ones forward', async () => {
    const past = await call('set_reminder', { text: 'x', date: '2026-11-02', time: '09:00', repeat: 'none', task_id: null });
    expect(past.is_error).toBe(true);
    await call('set_reminder', { text: 'standup', date: '2026-11-02', time: '09:00', repeat: 'daily', task_id: null });
    const r = await env.DB.prepare('SELECT * FROM reminders').first<Reminder>();
    expect(r?.local_date).toBe('2026-11-03');
  });

  it('checks the task id', async () => {
    expect((await call('set_reminder', { text: 'x', date: '2026-11-03', time: '09:00', repeat: 'none', task_id: 77 })).is_error).toBe(true);
  });
});

describe('logs, memory, routines', () => {
  it('validates mood and records progress', async () => {
    expect((await call('log_entry', { kind: 'mood', text: 'meh', area: null, value: 9 })).is_error).toBe(true);
    await call('log_entry', { kind: 'checkin', text: 'good day', area: null, value: 4 });
    await call('log_entry', { kind: 'win', text: 'sent INT form', area: 'admin', value: null });
    const progress = String((await call('get_progress', { period: 'week', area: null })).content);
    expect(progress).toContain('Mood avg 4');
    expect(progress).toContain('Check-ins 1/1 days');
  });

  it('remembers, forgets, changes routines and quiet days', async () => {
    const m = await call('remember', { fact: 'MMS calls 15:00-16:30 weekdays' });
    const id = Number(String(m.content).match(/M(\d+)/)![1]);
    expect((await call('forget', { id })).content).toBe(`Forgot M${id}`);
    expect((await call('update_routine', { name: 'morning_brief', time: '07:30', enabled: null })).content).toBe('morning_brief: 07:30 on');
    expect((await call('set_quiet', { days: 3 })).content).toContain('2026-11-04');
  });

  it('refuses vault paths outside notes, and works only with a token', async () => {
    expect((await call('read_vault_note', { path: 'TimeLine' })).content).toContain('not connected');
    const withToken = testEnv({ GITHUB_TOKEN: 'ghp_x' });
    const res = await runTool({ id: 't', name: 'read_vault_note', input: { path: '../secrets.txt' } }, { env: withToken, now, source: 'chat' });
    expect(res).toMatchObject({ is_error: true, content: 'Only Markdown notes and folders can be read.' });
  });
});
