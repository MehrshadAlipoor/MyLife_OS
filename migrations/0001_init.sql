-- Life-OS schema. Times: *_utc / ts / created_at are ISO-8601 UTC; date / due_date are local
-- YYYY-MM-DD and *_time / local_time are local HH:MM in the TIMEZONE var (Europe/Rome).

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  area TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'dropped')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  due_date TEXT,
  due_time TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  deleted_at TEXT,
  source TEXT NOT NULL DEFAULT 'chat'
);
CREATE INDEX tasks_by_status ON tasks (status, due_date);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress', 'win', 'blocker', 'mood', 'habit', 'note', 'checkin')),
  text TEXT NOT NULL,
  area TEXT,
  value REAL,
  deleted_at TEXT
);
CREATE INDEX logs_by_date ON logs (date);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  next_due_utc TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'cancelled')),
  task_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX reminders_due ON reminders (status, next_due_utc);

-- days: ISO weekdays that the routine runs on, 1 = Monday ... 7 = Sunday.
CREATE TABLE routines (
  name TEXT PRIMARY KEY,
  local_time TEXT NOT NULL,
  days TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT
);
INSERT INTO routines (name, local_time, days) VALUES
  ('morning_brief', '08:00', '12345'),
  ('evening_checkin', '21:30', '1234567'),
  ('weekly_review', '18:00', '7'),
  ('vault_export', '23:30', '1234567'),
  ('backup', '03:00', '7');

CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Chat sessions: append-only turns, replayed verbatim (thinking blocks included).
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  last_outbox_id INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  update_ids TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX turns_by_session ON turns (session_id, id);

-- Messages the bot sent on its own (briefs, check-ins, reminders), shown to the chat model
-- in the next user turn so a reply like "snooze that" has context.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  ts TEXT NOT NULL
);

CREATE TABLE pending_fallbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at TEXT NOT NULL
);

-- Every write made by a tool or button, so /undo can revert it.
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('tasks', 'logs', 'reminders', 'memory')),
  entity_id INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  usd REAL NOT NULL
);
CREATE INDEX usage_by_ts ON usage (ts);

CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO state (key, value) VALUES
  ('areas', '["phd","lab","mms","mimmo","health","admin","personal"]');
