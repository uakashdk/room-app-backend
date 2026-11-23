import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';
import { activeVipTier } from './vipService';
import { drawLucky, normalizeTiers } from '../config/luckyGift';

export type SendGiftInput = { roomId: string; giftId: string; receiverUid: string; count: number; requestId: string };

/** How much of a gift's price the receiver earns (in diamonds). Admin can change it: app_settings/economy { giftReceiverPercent }. */
const DEFAULT_RECEIVER_PERCENT = 50;

/**
 * Pays for a gift. Everything happens in ONE Firestore transaction, so either all of it is saved or none of it:
 *   - sender coins go down (never below zero)
 *   - receiver earns diamonds (the percent is saved inside the record, so old gifts keep their old percent)
 *   - a LUCKY gift (gift.lucky = true) is a random draw: the sender gets coins back (or nothing), and the receiver earns NO diamonds,
 *     so a lucky gift never counts for the host's target
 *   - gift_transactions + two wallet_transactions records are written (nobody can edit them: the rules refuse every write)
 *   - a gift_events document tells everybody in the room to play the animation
 * The same requestId is never charged twice (a retry after a bad connection returns the first result).
 */
export async function sendGift(
  sender: AuthedUser, input: SendGiftInput,
): Promise<{ balance: number; txId: string; duplicate: boolean; lucky: boolean; luckyReward: number }> {
  const { roomId, giftId, receiverUid, count, requestId } = input;
  if (receiverUid === sender.uid) throw new AppError(400, 'self-gift', 'You cannot send a gift to yourself.');

  const txId = `${sender.uid}_${requestId}`;
  const txRef = db.doc(`gift_transactions/${txId}`);
  const senderRef = db.doc(`users/${sender.uid}`);
  const receiverRef = db.doc(`users/${receiverUid}`);
  const giftRef = db.doc(`gifts/${giftId}`);
  const roomRef = db.doc(`rooms/${roomId}`);
  const senderMemberRef = db.doc(`rooms/${roomId}/members/${sender.uid}`);
  const receiverMemberRef = db.doc(`rooms/${roomId}/members/${receiverUid}`);
  const economyRef = db.doc('app_settings/economy');
  const luckyRef = db.doc('app_settings/lucky_gift');

  return db.runTransaction(async (t) => {
    // ---- all reads first ----
    const [txSnap, senderSnap, receiverSnap, giftSnap, roomSnap, senderMember, receiverMember, economySnap, luckySnap] = await t.getAll(
      txRef, senderRef, receiverRef, giftRef, roomRef, senderMemberRef, receiverMemberRef, economyRef, luckyRef,
    );

    if (txSnap.exists) {
      return {
        balance: Number(txSnap.data()?.senderBalanceAfter ?? 0), txId, duplicate: true,
        lucky: txSnap.data()?.lucky === true, luckyReward: Number(txSnap.data()?.luckyReward ?? 0),
      };
    }

    const room = roomSnap.data();
    if (!roomSnap.exists || !room || room.isLive !== true) throw new AppError(409, 'room-closed', 'This room has ended.');
    if (room.allowGifts === false) throw new AppError(409, 'gifts-off', 'Gifts are turned off in this room.');
    if (!senderMember.exists) throw new AppError(403, 'sender-not-in-room', 'You are not in this room.');
    if (!receiverMember.exists) throw new AppError(409, 'receiver-not-in-room', 'That person already left the room.');

    const receiver = receiverSnap.data();
    if (!receiverSnap.exists || !receiver || receiver.status !== 'active') {
      throw new AppError(409, 'receiver-not-in-room', 'That person cannot receive gifts.');
    }

    const gift = giftSnap.data();
    const price = Number(gift?.price);
    if (!giftSnap.exists || !gift || gift.enabled !== true || !Number.isInteger(price) || price <= 0) {
      throw new AppError(409, 'gift-disabled', 'This gift is not available right now.');
    }

    const senderData = senderSnap.data();
    // VIP-only gifts: the gift names the tier it needs (minVipTier), the sender's tier comes from the database, never from the app
    const needTier = Number(gift.minVipTier ?? 0);
    if (needTier > 0 && activeVipTier(senderData) < needTier) {
      throw new AppError(403, 'vip-required', 'This gift is only for VIP members.');
    }
    const balance = Number(senderData?.coins ?? 0);
    const totalCoins = price * count;
    if (!Number.isInteger(balance) || balance < totalCoins) throw new AppError(402, 'insufficient-coins', 'You do not have enough coins.');

    // ---- lucky gift: the draw (server only) ----
    const isLucky = gift.lucky === true;
    const luckyCfg = luckySnap.data();
    if (isLucky && luckyCfg?.enabled === false) throw new AppError(409, 'gift-disabled', 'Lucky gifts are paused right now.');
    const draw = isLucky ? drawLucky(price, count, normalizeTiers(luckyCfg?.tiers)) : { reward: 0, best: 0 };
    const reward = draw.reward;

    // a lucky gift earns the receiver nothing (no diamonds, so no target for the host)
    const percentRaw = Number(economySnap.data()?.giftReceiverPercent ?? DEFAULT_RECEIVER_PERCENT);
    const percent = isLucky ? 0 : Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, percentRaw)) : DEFAULT_RECEIVER_PERCENT;
    const diamonds = Math.floor((totalCoins * percent) / 100);
    const receiverDiamondsAfter = Number(receiver.diamonds ?? 0) + diamonds;
    const afterPayment = balance - totalCoins;
    const balanceAfter = afterPayment + reward;
    const now = FieldValue.serverTimestamp();
    // does a lucky gift count for the weekly room level? (app_settings/lucky_gift { countForRoomLevel }, default no)
    const countsForLevel = !isLucky || luckyCfg?.countForRoomLevel === true;

    // ---- then all writes ----
    t.update(senderRef, { coins: balanceAfter, giftSpent: FieldValue.increment(totalCoins) }); // giftSpent = the Wealth ranking (coins paid for gifts)
    if (diamonds > 0) t.update(receiverRef, { diamonds: receiverDiamondsAfter, diamondsEarned: FieldValue.increment(diamonds) }); // diamondsEarned = the Host ranking (never goes down when diamonds are paid out)
    t.update(roomRef, {
      giftCoins: FieldValue.increment(totalCoins), // the room ranking
      ...(countsForLevel ? { weekGiftCoins: FieldValue.increment(totalCoins) } : {}), // the weekly room level
    });

    t.create(txRef, {
      senderUid: sender.uid, senderName: sender.name, receiverUid, receiverName: String(receiver.name ?? 'User'),
      roomId, giftId, giftName: String(gift.name ?? 'Gift'), unitPrice: price, count, totalCoins,
      receiverPercent: percent, receiverDiamonds: diamonds, senderBalanceAfter: balanceAfter, createdAt: now,
      lucky: isLucky, luckyReward: reward, luckyBestMultiplier: draw.best,
    });
    t.create(db.doc(`wallet_transactions/${txId}_sent`), {
      uid: sender.uid, type: 'gift_sent', currency: 'coins', amount: -totalCoins, balanceAfter: afterPayment, refId: txId, roomId, createdAt: now,
    });
    if (reward > 0) {
      t.create(db.doc(`wallet_transactions/${txId}_lucky`), {
        uid: sender.uid, type: 'lucky_reward', currency: 'coins', amount: reward, balanceAfter, refId: txId, roomId, createdAt: now,
      });
    }
    if (diamonds > 0) {
      t.create(db.doc(`wallet_transactions/${txId}_received`), {
        uid: receiverUid, type: 'gift_received', currency: 'diamonds', amount: diamonds, balanceAfter: receiverDiamondsAfter, refId: txId, roomId, createdAt: now,
      });
    }
    t.create(db.doc(`rooms/${roomId}/gift_events/${txId}`), {
      senderUid: sender.uid, senderName: sender.name, senderPhotoURL: sender.photoURL,
      receiverUid, receiverName: String(receiver.name ?? 'User'),
      giftId, giftName: String(gift.name ?? 'Gift'), emoji: String(gift.emoji ?? '🎁'), imageUrl: gift.imageUrl ?? null,
      count, totalCoins, lucky: isLucky, luckyReward: reward, luckyMultiplier: draw.best, createdAt: now,
    });

    return { balance: balanceAfter, txId, duplicate: false, lucky: isLucky, luckyReward: reward };
  });
}

/** Admin: marks a gift as a lucky gift (or not). */
export async function setGiftLucky(actor: AuthedUser, giftId: string, lucky: boolean): Promise<void> {
  const ref = db.doc(`gifts/${giftId}`);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new AppError(404, 'not-found', 'This gift does not exist.');
    t.update(ref, { lucky });
    t.create(db.collection('admin_logs').doc(), {
      actorUid: actor.uid, actorName: actor.name, action: 'set_gift_lucky', collection: 'gifts', targetId: giftId,
      details: { from: snap.data()?.lucky === true, to: lucky }, at: FieldValue.serverTimestamp(),
    });
  });
}
