import { describe, expect, it } from 'vitest';
import { addDays, isDate, isoWeekId, isTime, localParts, nextOccurrence, relativeDay, stamp, weekStart, zonedToUtc } from '../src/time';

const TZ = 'Europe/Rome';

describe('zonedToUtc', () => {
  it('converts winter (CET) and summer (CEST) times', () => {
    expect(zonedToUtc('2026-11-02', '10:00', TZ).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '10:00', TZ).toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('moves a time skipped by the spring jump forward (2026-03-29 02:30 → 03:30)', () => {
    const utc = zonedToUtc('2026-03-29', '02:30', TZ);
    expect(utc.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(localParts(utc, TZ).time).toBe('03:30');
  });

  it('takes the first of a repeated autumn time (2026-10-25 02:30)', () => {
    expect(zonedToUtc('2026-10-25', '02:30', TZ).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('round-trips through localParts', () => {
    const p = localParts(zonedToUtc('2026-12-31', '23:59', TZ), TZ);
    expect([p.date, p.time, p.weekday]).toEqual(['2026-12-31', '23:59', 4]);
  });
});

describe('nextOccurrence', () => {
  it('keeps 10:00 local across the autumn DST change', () => {
    const next = nextOccurrence('daily', '2026-10-24', '10:00', TZ, new Date('2026-10-24T08:00:00Z'));
    expect(next?.date).toBe('2026-10-25');
    expect(next?.utc.toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });

  it('skips weekends for weekdays', () => {
    const next = nextOccurrence('weekdays', '2026-11-06', '09:00', TZ, new Date('2026-11-06T08:00:00Z'));
    expect(next?.date).toBe('2026-11-09');
  });

  it('catches up past missed days', () => {
    const next = nextOccurrence('daily', '2026-11-01', '09:00', TZ, new Date('2026-11-04T12:00:00Z'));
    expect(next?.date).toBe('2026-11-05');
  });

  it('returns null for one-off reminders', () => {
    expect(nextOccurrence('none', '2026-11-01', '09:00', TZ, new Date())).toBeNull();
  });
});

describe('dates', () => {
  it('computes ISO weeks', () => {
    expect(isoWeekId('2026-11-02')).toBe('2026-W45');
    expect(isoWeekId('2027-01-01')).toBe('2026-W53');
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
  });

  it('validates dates and times', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('26-2-3')).toBe(false);
    expect(isTime('07:30')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('formats relative days and the turn stamp', () => {
    expect(relativeDay('2026-11-02', '2026-11-02')).toBe('today');
    expect(relativeDay('2026-11-03', '2026-11-02')).toBe('tomorrow');
    expect(relativeDay('2026-10-30', '2026-11-02')).toBe('3d overdue');
    expect(relativeDay('2026-11-05', '2026-11-02')).toBe('Thu 5 Nov');
    expect(stamp(new Date('2026-11-02T14:04:00Z'), TZ)).toBe('Mon 2 Nov 2026 15:04 Europe/Rome');
  });
});
