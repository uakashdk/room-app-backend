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
