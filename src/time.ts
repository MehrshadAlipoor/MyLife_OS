/**
 * Local date and time in the user's timezone (Europe/Rome by default), DST-safe.
 * Dates are 'YYYY-MM-DD' and times 'HH:MM' local; instants are Date objects (UTC inside).
 */

export interface LocalParts {
  date: string;
  time: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    });
    formatters.set(tz, f);
  }
  return f;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localParts(at: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(at)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 1,
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`
  };
}

export const localDate = (at: Date, tz: string) => localParts(at, tz).date;
export const localTime = (at: Date, tz: string) => localParts(at, tz).time;

/** tz offset from UTC at instant `ms`, in ms (local wall clock = UTC + offset). */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a local wall-clock date and time. A time skipped by the spring DST jump moves
 * forward by the gap (02:30 → 03:30); a time that happens twice in autumn takes the first one.
 */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const before = offsetAt(wall - 12 * 3600_000, tz);
  const after = offsetAt(wall + 12 * 3600_000, tz);
  const matches = [wall - before, wall - after]
    .filter(ms => {
      const p = localParts(new Date(ms), tz);
      return p.date === date && p.time === time;
    })
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? wall - before);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000);
}

/** Monday of the ISO week containing `date`. */
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));

/** ISO week id, e.g. '2026-W45'. */
export function isoWeekId(date: string): string {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

export const monthName = (month: number) => MONTH_NAMES[month - 1] ?? '';

/** 'Mon 2 Nov 2026 15:04 Europe/Rome': the prefix of every user turn. */
export function stamp(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${DAY_NAMES[p.weekday]} ${p.day} ${monthName(p.month).slice(0, 3)} ${p.year} ${p.time} ${tz}`;
}

/** '2 Nov' (or '2 Nov 2027' outside the current year of `today`). */
export function shortDate(date: string, today: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${monthName(m).slice(0, 3)}${date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${y}`}`;
}

/** 'today', 'tomorrow', 'Wed 4 Nov', '3d overdue'. */
export function relativeDay(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${-days}d overdue`;
  return `${DAY_NAMES[isoWeekday(date)]} ${shortDate(date, today)}`;
}

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly';

/**
 * Next occurrence of a repeating local time after `after`, stepping from the previous local date
 * (never by adding 24 h to an instant, so 10:00 stays 10:00 across DST changes).
 */
export function nextOccurrence(repeat: Repeat, fromDate: string, time: string, tz: string, after: Date): { date: string; utc: Date } | null {
  if (repeat === 'none') return null;
  let date = fromDate;
  for (let i = 0; i < 800; i++) {
    date = addDays(date, repeat === 'weekly' ? 7 : 1);
    if (repeat === 'weekdays' && isoWeekday(date) > 5) continue;
    const utc = zonedToUtc(date, time, tz);
    if (utc > after) return { date, utc };
  }
  return null;
}

export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;

export const isTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Minutes since local midnight for 'HH:MM'. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}
