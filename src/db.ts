/** D1 access: small typed helpers, the shared queries, and the change log behind /undo. */

export type Entity = 'tasks' | 'logs' | 'reminders' | 'memory';

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  area: string | null;
  status: 'open' | 'waiting' | 'done' | 'dropped';
  priority: number;
  due_date: string | null;
  due_time: string | null;
  created_at: string;
  done_at: string | null;
  deleted_at: string | null;
  source: string;
}

export interface Reminder {
  id: number;
  text: string;
  next_due_utc: string;
  local_date: string;
  local_time: string;
  repeat: 'none' | 'daily' | 'weekdays' | 'weekly';
  status: 'pending' | 'sending' | 'sent' | 'cancelled';
  task_id: number | null;
  created_at: string;
}

export interface LogRow {
  id: number;
  ts: string;
  date: string;
  kind: 'progress' | 'win' | 'blocker' | 'mood' | 'habit' | 'note' | 'checkin';
  text: string;
  area: string | null;
  value: number | null;
  deleted_at: string | null;
}

export interface MemoryRow { id: number; fact: string; created_at: string; deleted_at: string | null }

export interface Routine { name: string; local_time: string; days: string; enabled: number; last_run_date: string | null }

export interface OutboxRow { id: number; ts: string; kind: string; text: string }

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

export function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

// ---------------------------------------------------------------- key/value state

export async function getState<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM state WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setState(db: D1Database, key: string, value: unknown): Promise<void> {
  await run(db, 'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export const getAreas = (db: D1Database) => getState<string[]>(db, 'areas', []);

// ---------------------------------------------------------------- writes with a change log

const COLUMN = /^[a-z_]+$/;

function columns(values: Record<string, unknown>): string[] {
  const keys = Object.keys(values).filter(k => values[k] !== undefined);
  for (const k of keys) if (!COLUMN.test(k)) throw new Error(`bad column ${k}`);
  return keys;
}

async function logChange(db: D1Database, entity: Entity, id: number, before: unknown, after: unknown): Promise<void> {
  await run(db, 'INSERT INTO changes (ts, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?)',
    new Date().toISOString(), entity, id, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}

export async function insertRow<T extends { id: number }>(db: D1Database, entity: Entity, values: Record<string, unknown>): Promise<T> {
  const keys = columns(values);
  const row = await first<T>(db, `INSERT INTO ${entity} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`,
    ...keys.map(k => values[k]));
  if (!row) throw new Error(`insert into ${entity} failed`);
  await logChange(db, entity, row.id, null, row);
  return row;
}

/** Update one row; returns null when it doesn't exist (or is deleted). */
export async function updateRow<T extends { id: number }>(db: D1Database, entity: Entity, id: number, patch: Record<string, unknown>): Promise<{ before: T; after: T } | null> {
  const before = await first<T>(db, `SELECT * FROM ${entity} WHERE id = ?`, id);
  if (!before || (before as { deleted_at?: string | null }).deleted_at) return null;
  const keys = columns(patch);
  if (!keys.length) return { before, after: before };
  const after = await first<T>(db, `UPDATE ${entity} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`,
    ...keys.map(k => patch[k]), id);
  if (!after) return null;
  await logChange(db, entity, id, before, after);
  return { before, after };
}

/** Revert the newest change from the last 7 days; returns a short description, or null if nothing to undo. */
export async function undoLast(db: D1Database): Promise<string | null> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const change = await first<{ id: number; entity: Entity; entity_id: number; before_json: string | null; after_json: string | null }>(db,
    'SELECT * FROM changes WHERE undone = 0 AND ts >= ? ORDER BY id DESC LIMIT 1', since);
  if (!change) return null;
  const label = describeRow(change.entity, JSON.parse(change.after_json ?? change.before_json ?? '{}'));
  if (change.before_json == null) {
    if (change.entity === 'reminders') await run(db, "UPDATE reminders SET status = 'cancelled' WHERE id = ?", change.entity_id);
    else await run(db, `UPDATE ${change.entity} SET deleted_at = ? WHERE id = ?`, new Date().toISOString(), change.entity_id);
  } else {
    const before = JSON.parse(change.before_json) as Record<string, unknown>;
    delete before.id;
    const keys = columns(before);
    await run(db, `UPDATE ${change.entity} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => before[k]), change.entity_id);
  }
  await run(db, 'UPDATE changes SET undone = 1 WHERE id = ?', change.id);
  return `${change.before_json == null ? 'Removed' : 'Restored'} ${label}`;
}

function describeRow(entity: Entity, row: Record<string, unknown>): string {
  const id = row.id;
  switch (entity) {
    case 'tasks': return `task /T${id} "${row.title}"`;
    case 'reminders': return `reminder R${id} "${row.text}"`;
    case 'logs': return `${row.kind} entry "${String(row.text).slice(0, 60)}"`;
    case 'memory': return `memory M${id} "${String(row.fact).slice(0, 60)}"`;
  }
}

// ---------------------------------------------------------------- shared reads

export function getTask(db: D1Database, id: number): Promise<Task | null> {
  return first<Task>(db, 'SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', id);
}

/** Open and waiting tasks: dated first (soonest), then by priority. */
export function activeTasks(db: D1Database): Promise<Task[]> {
  return all<Task>(db, `SELECT * FROM tasks WHERE status IN ('open', 'waiting') AND deleted_at IS NULL
    ORDER BY due_date IS NULL, due_date, priority, id`);
}

export function doneBetween(db: D1Database, fromUtc: string, toUtc: string): Promise<Task[]> {
  return all<Task>(db, `SELECT * FROM tasks WHERE status = 'done' AND deleted_at IS NULL AND done_at >= ? AND done_at < ? ORDER BY done_at`, fromUtc, toUtc);
}

export function logsBetween(db: D1Database, fromDate: string, toDate: string): Promise<LogRow[]> {
  return all<LogRow>(db, 'SELECT * FROM logs WHERE deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY ts', fromDate, toDate);
}

export function pendingReminders(db: D1Database): Promise<Reminder[]> {
  return all<Reminder>(db, "SELECT * FROM reminders WHERE status IN ('pending', 'sending') ORDER BY next_due_utc");
}

export function memoryFacts(db: D1Database): Promise<MemoryRow[]> {
  return all<MemoryRow>(db, 'SELECT * FROM memory WHERE deleted_at IS NULL ORDER BY id');
}

export function routines(db: D1Database): Promise<Routine[]> {
  return all<Routine>(db, 'SELECT * FROM routines ORDER BY local_time');
}

export async function addOutbox(db: D1Database, kind: string, text: string): Promise<void> {
  await run(db, 'INSERT INTO outbox (ts, kind, text) VALUES (?, ?, ?)', new Date().toISOString(), kind, text);
}

export function outboxAfter(db: D1Database, id: number): Promise<OutboxRow[]> {
  return all<OutboxRow>(db, 'SELECT * FROM outbox WHERE id > ? ORDER BY id', id);
}
