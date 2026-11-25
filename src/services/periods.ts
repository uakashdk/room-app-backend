import { weekKey } from './roomLevels';
import type { SalaryPeriod } from '../config/salary';

/** India time (UTC+5:30), like the weekly room levels. */
const IST_MS = 5.5 * 3600_000;

/** 2026-11 : the calendar month in India time. */
export function monthKey(now = Date.now()): string {
  const ist = new Date(now + IST_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const periodKey = (period: SalaryPeriod, now = Date.now()): string => (period === 'monthly' ? monthKey(now) : weekKey(now));

/** When the current period ends (the deadline of the targets), in milliseconds: next Monday 00:00 or the 1st of next month 00:00, India time. */
export function periodEndsAt(period: SalaryPeriod, now = Date.now()): number {
  const ist = new Date(now + IST_MS);
  if (period === 'monthly') return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_MS;
  const day = ist.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (8 - day)) - IST_MS;
}
