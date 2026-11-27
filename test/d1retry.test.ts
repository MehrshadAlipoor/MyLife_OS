import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, isTransientD1Error, withD1Retry } from '../src/db';
import { cronTick, runCron } from '../src/routines';
import { mockFetch, resetDb, telegramCalls, testEnv } from './helpers';
import type { TestEnv } from './helpers';

const D1_INTERNAL = 'D1_ERROR: internal error; reference = e_test';

let env: TestEnv;
beforeEach(async () => {
  env = testEnv();
  await resetDb(env);
});
afterEach(() => vi.restoreAllMocks());

/** The real D1, but the first `failures` prepared-statement calls throw a D1 internal error. */
function flakyDb(real: D1Database, failures: number): D1Database {
  let left = failures;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args));
      return (...args: unknown[]) => {
        if (left > 0) {
          left--;
          return Promise.reject(new Error(D1_INTERNAL));
        }
        return value.apply(target, args);
      };
    }
  });
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'prepare') return (sql: string) => wrap(value.call(target, sql));
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

describe('D1 retries', () => {
  it('tells transient D1 errors from real ones', () => {
    expect(isTransientD1Error(new Error(D1_INTERNAL))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: no such table: nope: SQLITE_ERROR'))).toBe(false);
  });

  it('retries transient errors, but not real ones', async () => {
    let n = 0;
    expect(await withD1Retry(async () => (++n < 3 ? Promise.reject(new Error(D1_INTERNAL)) : 'ok'), 5, 1)).toBe('ok');
    expect(n).toBe(3);
    n = 0;
    await expect(withD1Retry(async () => { n++; throw new Error('SQLITE_ERROR: syntax error'); }, 5, 1)).rejects.toThrow('syntax');
    expect(n).toBe(1);
  });

  it('a cron tick survives a few D1 internal errors', async () => {
    await env.DB.prepare(`INSERT INTO reminders (text, next_due_utc, local_date, local_time, repeat, created_at) VALUES
      ('one-off', '2026-11-02T09:00:00.000Z', '2026-11-02', '10:00', 'none', '')`).run();
    const calls = mockFetch();
    await runCron({ ...env, DB: flakyDb(env.DB, 3) }, new Date('2026-11-02T09:02:00Z'));
    expect(telegramCalls(calls).map(c => c.body.text)).toEqual(['⏰ one-off']);
  });
});

describe('scheduler warnings', () => {
  it('stays quiet on one failed tick, warns once on the second, and resets after recovery', async () => {
    const calls = mockFetch();
    const now = new Date('2026-11-02T03:02:00Z');
    // A bad time zone makes the routines step throw on every tick.
    const failing = { ...env, TIMEZONE: 'Not/AZone' };
    await cronTick(failing, now);
    expect(telegramCalls(calls)).toHaveLength(0);
    await cronTick(failing, now);
    expect(telegramCalls(calls)).toHaveLength(1);
    expect(telegramCalls(calls)[0]!.body.text).toContain('2 runs in a row');
    await cronTick(failing, now);
    expect(telegramCalls(calls)).toHaveLength(1);
    await cronTick(env, now);
    expect(await getState(env.DB, 'cron_failures', -1)).toBe(0);
  });
});
