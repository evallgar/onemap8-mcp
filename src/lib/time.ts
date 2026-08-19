/**
 * Relative time-range handling.
 *
 * Every report endpoint requires explicit ISO `from`/`to` timestamps, but users
 * ask for "last week" and models are unreliable at deriving calendar
 * boundaries. Resolving named periods here keeps that arithmetic out of the
 * model's hands.
 */

import { z } from 'zod';

export const PERIODS = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'last24Hours',
  'last7Days',
  'last30Days',
] as const;

export type Period = (typeof PERIODS)[number];

export const periodSchema = z
  .enum(PERIODS)
  .describe(
    'Named time range, resolved on the server. Use this instead of computing dates yourself. ' +
      'Weeks start Monday. Ignored when explicit `from`/`to` are supplied.',
  );

export interface TimeRange {
  from: string;
  to: string;
  label: string;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Monday-based start of week. */
function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const weekday = (start.getDay() + 6) % 7;
  return addDays(start, -weekday);
}

export function resolvePeriod(period: Period, now: Date = new Date()): TimeRange {
  const today = startOfDay(now);

  const range = (from: Date, to: Date, label: string): TimeRange => ({
    from: from.toISOString(),
    to: to.toISOString(),
    label,
  });

  switch (period) {
    case 'today':
      return range(today, now, 'today so far');
    case 'yesterday':
      return range(addDays(today, -1), today, 'yesterday');
    case 'thisWeek':
      return range(startOfWeek(now), now, 'this week so far');
    case 'lastWeek': {
      const start = addDays(startOfWeek(now), -7);
      return range(start, addDays(start, 7), 'last week');
    }
    case 'thisMonth': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return range(start, now, 'this month so far');
    }
    case 'lastMonth': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 1);
      return range(start, end, 'last month');
    }
    case 'last24Hours':
      return range(new Date(now.getTime() - 24 * 3600_000), now, 'the last 24 hours');
    case 'last7Days':
      return range(new Date(now.getTime() - 7 * 86_400_000), now, 'the last 7 days');
    case 'last30Days':
      return range(new Date(now.getTime() - 30 * 86_400_000), now, 'the last 30 days');
  }
}

function parseInstant(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`\`${field}\` is not a valid date-time: "${value}". Use ISO 8601, e.g. 2026-08-19T00:00:00Z.`);
  }
  return parsed.toISOString();
}

/**
 * Explicit `from`/`to` win over `period`; a bare `period` (or nothing at all,
 * which defaults to today) covers the conversational case.
 */
export function resolveTimeRange(input: {
  from?: string;
  to?: string;
  period?: Period;
}): TimeRange {
  if (input.from && input.to) {
    const from = parseInstant(input.from, 'from');
    const to = parseInstant(input.to, 'to');
    if (new Date(from) > new Date(to)) {
      throw new Error('`from` is after `to` — the time range is inverted.');
    }
    return { from, to, label: `${from} to ${to}` };
  }
  if (input.from || input.to) {
    throw new Error('Supply both `from` and `to`, or neither with a `period` instead.');
  }
  return resolvePeriod(input.period ?? 'today');
}
