import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { DEFAULT_LEVEL_RULES, MAX_ROOM_LEVEL } from '../config/roomLevels';

/**
 * Room levels, weekly:
 *  - every few minutes the server looks at the live rooms; when every seat of a room is taken it adds those minutes to weekFullMinutes
 *  - gifts add to weekGiftCoins (see giftService)
 *  - once a week (Monday, India time) a room goes up one level for each goal it reached, and the weekly counters start again at 0
 * Only the server writes level, weekFullMinutes and weekGiftCoins (the rules refuse the apps).
 */
const SAMPLE_EVERY_MS = 5 * 60 * 1000;
const SAMPLE_MINUTES = SAMPLE_EVERY_MS / 60000;
const CHECK_WEEK_EVERY_MS = 30 * 60 * 1000;
const STATE_DOC = 'app_settings/room_levels_state';
const RULES_DOC = 'app_settings/room_levels';

/** "2026-W47": the week number in India time, weeks start on Monday. */
export function weekKey(now = Date.now()): string {
  const ist = new Date(now + 5.5 * 3600_000); // India time
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // the Thursday of this week decides the week and the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Adds the minutes of "all seats taken" to every live room that is full right now. */
export async function sampleFullRooms(): Promise<number> {
  const live = await db.collection('rooms').where('isLive', '==', true).get();
  let full = 0;
  for (const room of live.docs) {
    const x = room.data();
    const seatCount = Number(x.seatCount ?? 0);
    if (!x.hostUid || seatCount < 2) continue;
    const taken = (await room.ref.collection('seats').count().get()).data().count;
    if (taken >= seatCount) {
      await room.ref.update({ weekFullMinutes: FieldValue.increment(SAMPLE_MINUTES) });
      full++;
    }
  }
  return full;
}

/** Moves every room up for the week that just ended. Safe to call once per week only (the state document stops a second run). */
export async function evaluateWeek(): Promise<number> {
  const rules = { ...DEFAULT_LEVEL_RULES, ...((await db.doc(RULES_DOC).get()).data() ?? {}) };
  const rooms = await db.collection('rooms').get();
  let raised = 0;
  for (let i = 0; i < rooms.docs.length; i += 300) {
    const batch = db.batch();
    for (const room of rooms.docs.slice(i, i + 300)) {
      const x = room.data();
      if (!x.hostUid) continue;
      const level = Math.max(1, Number(x.level ?? 1));
      const full = Number(x.weekFullMinutes ?? 0);
      const gifts = Number(x.weekGiftCoins ?? 0);
      const goals = (full >= Number(rules.fullMinutesPerWeek) ? 1 : 0) + (gifts >= Number(rules.giftCoinsPerWeek) ? 1 : 0);
      const next = Math.min(MAX_ROOM_LEVEL, level + goals);
      if (next > level) raised++;
      batch.update(room.ref, {
        level: next, weekFullMinutes: 0, weekGiftCoins: 0,
        lastWeekFullMinutes: full, lastWeekGiftCoins: gifts, levelUpdatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return raised;
}

async function checkWeek(): Promise<void> {
  const state = db.doc(STATE_DOC);
  const now = weekKey();
  const last = (await state.get()).data()?.week as string | undefined;
  if (last === now) return;
  if (last) {
    const n = await evaluateWeek();
    console.log(`Weekly room levels done for ${last}: ${n} room(s) went up.`);
  }
  await state.set({ week: now, at: FieldValue.serverTimestamp() }); // the very first run only remembers the week
}

export function startRoomLevels(): void {
  const guard = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`${name} failed:`, e?.message ?? e));
  setInterval(guard('Room seat sampling', sampleFullRooms), SAMPLE_EVERY_MS).unref();
  const week = guard('Weekly room levels', checkWeek);
  week();
  setInterval(week, CHECK_WEEK_EVERY_MS).unref();
}
