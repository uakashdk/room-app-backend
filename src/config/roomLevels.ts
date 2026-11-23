/**
 * Room levels. The level decides how many host seats a room can have and how many partners the owner can add.
 * Listeners are never limited. The level goes up weekly (see services/roomLevels.ts).
 * To change a rule, change this table: the app has the same table in src/constants/roomLevels.ts and firestore.rules has seatLimit().
 */
export const MAX_ROOM_LEVEL = 50;

// "upTo" = this row holds up to and including this level
const TABLE: { upTo: number; seats: number; partners: number }[] = [
  { upTo: 10, seats: 8, partners: 3 },
  { upTo: 15, seats: 12, partners: 3 }, // partner limit above level 10 is not decided yet: 3 for now
  { upTo: 20, seats: 15, partners: 3 },
  { upTo: 30, seats: 20, partners: 3 },
  { upTo: MAX_ROOM_LEVEL, seats: 26, partners: 3 },
];

const rowOf = (level: number) => TABLE.find((r) => level <= r.upTo) ?? TABLE[TABLE.length - 1];

export const seatLimitForLevel = (level: number): number => rowOf(Math.max(1, Math.floor(level))).seats;
export const partnerLimitForLevel = (level: number): number => rowOf(Math.max(1, Math.floor(level))).partners;

/** What a room must reach in one week to go up. The values can be changed without a new release in the document app_settings/room_levels. */
export const DEFAULT_LEVEL_RULES = {
  fullMinutesPerWeek: 600, // all seats taken for 10 hours in the week
  giftCoinsPerWeek: 20000, // gifts worth 20000 coins received in the week
};
