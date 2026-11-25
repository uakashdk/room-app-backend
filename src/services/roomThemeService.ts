// NEW FILE. A room owner buys a theme for his room with coins. One transaction:
// the coins go down, the theme is added to rooms/<id>.ownedThemes (only this server writes it) and becomes the room's theme,
// and a wallet record is written. The same requestId is never charged twice.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { ROOM_THEME_PRICES } from '../config/roomThemes';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';

export type ThemeResult = { balance: number; theme: string; duplicate: boolean };

export async function buyRoomTheme(user: AuthedUser, roomId: string, themeId: string, requestId: string): Promise<ThemeResult> {
  const price = ROOM_THEME_PRICES[themeId];
  if (price === undefined) throw new AppError(404, 'theme-not-found', 'This theme does not exist.');

  const userRef = db.doc(`users/${user.uid}`);
  const roomRef = db.doc(`rooms/${roomId}`);
  const walletRef = db.doc(`wallet_transactions/${user.uid}_${requestId}_theme`);

  return db.runTransaction(async (t) => {
    const [wallet, userSnap, roomSnap] = await Promise.all([t.get(walletRef), t.get(userRef), t.get(roomRef)]);
    if (wallet.exists) return { balance: Number(wallet.data()?.balanceAfter ?? 0), theme: themeId, duplicate: true };
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'Your account was not found.');
    if (!roomSnap.exists) throw new AppError(404, 'room-not-found', 'The room was not found.');
    const room = roomSnap.data()!;
    if (room.hostUid !== user.uid) throw new AppError(403, 'not-owner', 'Only the room owner can buy a theme.');

    const coins = Number(userSnap.data()?.coins ?? 0);
    const owned: string[] = Array.isArray(room.ownedThemes) ? room.ownedThemes.map(String) : [];

    // free theme, or one the room already owns: just use it, nothing is charged
    if (price === 0 || owned.includes(themeId)) {
      t.update(roomRef, { theme: themeId });
      return { balance: coins, theme: themeId, duplicate: false };
    }
    if (coins < price) throw new AppError(402, 'insufficient-coins', 'You do not have enough coins for this theme.');

    const balance = coins - price;
    t.update(userRef, { coins: balance });
    t.update(roomRef, { theme: themeId, ownedThemes: FieldValue.arrayUnion(themeId) });
    t.create(walletRef, {
      uid: user.uid, type: 'room_theme', currency: 'coins', amount: -price, balanceAfter: balance,
      note: `Room theme ${themeId}`, refId: roomId, createdAt: Timestamp.now(),
    });
    return { balance, theme: themeId, duplicate: false };
  });
}

const BG_PREFIX = 'data:image/jpeg;base64,';
const MAX_BG_CHARS = 240_000; // the same number is in the app (services/roomBackground.ts)

/**
 * The owner sets his OWN picture as the room background (custom theme).
 * Everything happens in ONE transaction, so there is no half result:
 *   - the picture is saved (rooms/<id>/media/background, written by the server, the apps cannot write it)
 *   - if the room does not own the custom theme yet, the coins are taken ONCE and 'custom' is added to ownedThemes
 *   - if anything fails (no coins, bad picture, not the owner), NOTHING is charged and nothing is saved
 * A room that already owns the custom theme changes its picture for free.
 */
export async function setCustomBackground(user: AuthedUser, roomId: string, imageUrl: string, requestId: string): Promise<ThemeResult> {
  if (!imageUrl.startsWith(BG_PREFIX) || imageUrl.length > MAX_BG_CHARS || !/^[A-Za-z0-9+/=]+$/.test(imageUrl.slice(BG_PREFIX.length))) {
    throw new AppError(400, 'bad-image', 'This picture cannot be used. Please choose another one.');
  }
  const price = ROOM_THEME_PRICES.custom ?? 500;
  const userRef = db.doc(`users/${user.uid}`);
  const roomRef = db.doc(`rooms/${roomId}`);
  const walletRef = db.doc(`wallet_transactions/${user.uid}_${requestId}_theme`);
  const bgRef = db.doc(`rooms/${roomId}/media/background`);

  return db.runTransaction(async (t) => {
    const [wallet, userSnap, roomSnap] = await Promise.all([t.get(walletRef), t.get(userRef), t.get(roomRef)]);
    if (wallet.exists) return { balance: Number(wallet.data()?.balanceAfter ?? 0), theme: 'custom', duplicate: true };
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'Your account was not found.');
    if (!roomSnap.exists) throw new AppError(404, 'room-not-found', 'The room was not found.');
    const room = roomSnap.data()!;
    if (room.hostUid !== user.uid) throw new AppError(403, 'not-owner', 'Only the room owner can change the room theme.');

    const coins = Number(userSnap.data()?.coins ?? 0);
    const owned: string[] = Array.isArray(room.ownedThemes) ? room.ownedThemes.map(String) : [];
    t.set(bgRef, { url: imageUrl, updatedAt: FieldValue.serverTimestamp() });

    if (owned.includes('custom')) {
      t.update(roomRef, { theme: 'custom' });
      return { balance: coins, theme: 'custom', duplicate: false };
    }
    if (coins < price) throw new AppError(402, 'insufficient-coins', `You need ${price} coins for the custom theme.`);
    const balance = coins - price;
    t.update(userRef, { coins: balance });
    t.update(roomRef, { theme: 'custom', ownedThemes: FieldValue.arrayUnion('custom') });
    t.create(walletRef, {
      uid: user.uid, type: 'room_theme', currency: 'coins', amount: -price, balanceAfter: balance,
      note: 'Room theme custom', refId: roomId, createdAt: Timestamp.now(),
    });
    return { balance, theme: 'custom', duplicate: false };
  });
}

/** The owner removes his picture. The room keeps the custom theme it paid for and goes back to a normal colour theme. */
export async function removeCustomBackground(user: AuthedUser, roomId: string): Promise<void> {
  const roomRef = db.doc(`rooms/${roomId}`);
  const snap = await roomRef.get();
  if (!snap.exists) throw new AppError(404, 'room-not-found', 'The room was not found.');
  if (snap.data()?.hostUid !== user.uid) throw new AppError(403, 'not-owner', 'Only the room owner can change the room theme.');
  await db.doc(`rooms/${roomId}/media/background`).delete();
  if (snap.data()?.theme === 'custom') await roomRef.update({ theme: 'violet' });
}
