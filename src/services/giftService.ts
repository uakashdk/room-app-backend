import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase';
import { monthKey } from './periods';
import { weekKey } from './roomLevels';
import { AppError } from '../middleware/error-handler';
import type { AuthedUser } from '../middleware/authenticate';
import { activeVipTier } from './vipService';
import { drawLucky, normalizeTiers } from '../config/luckyGift';

export type SendGiftInput = { roomId?: string; // no roomId = a gift in a private chat (the room records are skipped, a chat message is written instead)
   giftId: string; receiverUid: string; count: number; requestId: string };

/** How much of a gift's price the receiver earns (in diamonds). Admin can change it: app_settings/economy { giftReceiverPercent }. */
const DEFAULT_RECEIVER_PERCENT = 50;
/**
 * A gift in a PRIVATE CHAT also puts COINS in the receiver's wallet (so the receiver really sees the credit), as a percent of the gift price.
 * Admin can change it: app_settings/economy { chatGiftCoinsPercent } (0 = off). Lucky gifts never pay the receiver.
 */
const DEFAULT_CHAT_COINS_PERCENT = 50;

/**
 * Pays for a gift. Everything happens in ONE Firestore transaction, so either all of it is saved or none of it:
 *   - sender coins go down (never below zero)
 *   - receiver earns diamonds (the percent is saved inside the record, so old gifts keep their old percent)
 *   - a LUCKY gift (gift.lucky = true) is a random draw: the sender gets coins back (or nothing), and the receiver earns NO diamonds,
 *     so a lucky gift never counts for the host's target
 *   - gift_transactions + two wallet_transactions records are written (nobody can edit them: the rules refuse every write)
 *   - a gift_events document tells everybody in the room to play the animation
 * The same requestId is never charged twice (a retry after a bad connection returns the first result).
 * A gift in a PRIVATE CHAT (no roomId) works the same, but there is no room: nothing is added to a room, and a message
 * "sent a gift" is written into the chat of the two people.
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
  const inRoom = !!roomId;
  const roomRef = db.doc(`rooms/${roomId ?? 'none'}`);
  const senderMemberRef = db.doc(`rooms/${roomId ?? 'none'}/members/${sender.uid}`);
  const receiverMemberRef = db.doc(`rooms/${roomId ?? 'none'}/members/${receiverUid}`);
  const chatId = sender.uid < receiverUid ? `${sender.uid}_${receiverUid}` : `${receiverUid}_${sender.uid}`;
  const chatRef = db.doc(`private_chats/${chatId}`);
  const blockedRef = db.doc(`users/${receiverUid}/blocks/${sender.uid}`); // the receiver blocked me
  const economyRef = db.doc('app_settings/economy');
  const luckyRef = db.doc('app_settings/lucky_gift');

  return db.runTransaction(async (t) => {
    // ---- all reads first ----
    const refs = [txRef, senderRef, receiverRef, giftRef, economyRef, luckyRef, ...(inRoom ? [roomRef, senderMemberRef, receiverMemberRef] : [chatRef, blockedRef])];
    const snaps = await t.getAll(...refs);
    const [txSnap, senderSnap, receiverSnap, giftSnap, economySnap, luckySnap, extra1, extra2, extra3] = snaps;

    if (txSnap.exists) {
      return {
        balance: Number(txSnap.data()?.senderBalanceAfter ?? 0), txId, duplicate: true,
        lucky: txSnap.data()?.lucky === true, luckyReward: Number(txSnap.data()?.luckyReward ?? 0),
      };
    }

    if (inRoom) {
      const room = extra1.data();
      if (!extra1.exists || !room || room.isLive !== true) throw new AppError(409, 'room-closed', 'This room has ended.');
      if (room.allowGifts === false) throw new AppError(409, 'gifts-off', 'Gifts are turned off in this room.');
      if (!extra2.exists) throw new AppError(403, 'sender-not-in-room', 'You are not in this room.');
      if (!extra3.exists) throw new AppError(409, 'receiver-not-in-room', 'That person already left the room.');
    } else if (extra2.exists) {
      throw new AppError(403, 'blocked', 'This person cannot receive your gifts.');
    }

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
    // private chat only: coins for the receiver's wallet
    const chatPctRaw = Number(economySnap.data()?.chatGiftCoinsPercent ?? DEFAULT_CHAT_COINS_PERCENT);
    const chatPct = !inRoom && !isLucky && Number.isFinite(chatPctRaw) ? Math.min(100, Math.max(0, chatPctRaw)) : 0;
    const receiverCoins = Math.floor((totalCoins * chatPct) / 100);
    const receiverCoinsAfter = Number(receiver.coins ?? 0) + receiverCoins;
    const receiverDiamondsAfter = Number(receiver.diamonds ?? 0) + diamonds;
    const afterPayment = balance - totalCoins;
    const balanceAfter = afterPayment + reward;
    const now = FieldValue.serverTimestamp();
    // does a lucky gift count for the weekly room level? (app_settings/lucky_gift { countForRoomLevel }, default no)
    const countsForLevel = !isLucky || luckyCfg?.countForRoomLevel === true;

    // ---- then all writes ----
    t.update(senderRef, { coins: balanceAfter, giftSpent: FieldValue.increment(totalCoins) }); // giftSpent = the Wealth ranking (coins paid for gifts)
    // the receiver: diamonds (host target / ranking), coins (private chat), and the number of gifts received (the "Gifts" number on the profile)
    t.update(receiverRef, {
      giftsReceived: FieldValue.increment(count),
      ...(diamonds > 0 ? { diamonds: receiverDiamondsAfter, diamondsEarned: FieldValue.increment(diamonds) } : {}), // diamondsEarned = the Host ranking (never goes down when diamonds are paid out)
      ...(receiverCoins > 0 ? { coins: receiverCoinsAfter } : {}),
    });
    if (diamonds > 0) {
      // the targets of the host: what he received this week and this month (the salary run reads these two documents)
      const wk = weekKey();
      const mk = monthKey();
      t.set(db.doc(`host_weeks/${wk}_${receiverUid}`), { uid: receiverUid, week: wk, diamonds: FieldValue.increment(diamonds), updatedAt: now }, { merge: true });
      t.set(db.doc(`host_months/${mk}_${receiverUid}`), { uid: receiverUid, month: mk, diamonds: FieldValue.increment(diamonds), updatedAt: now }, { merge: true });
    }
    if (inRoom) {
      t.update(roomRef, {
        giftCoins: FieldValue.increment(totalCoins), // the room ranking
        ...(countsForLevel ? { weekGiftCoins: FieldValue.increment(totalCoins) } : {}), // the weekly room level
      });
    }

    t.create(txRef, {
      senderUid: sender.uid, senderName: sender.name, receiverUid, receiverName: String(receiver.name ?? 'User'),
      roomId: roomId ?? null, chatId: inRoom ? null : chatId, giftId, giftName: String(gift.name ?? 'Gift'), unitPrice: price, count, totalCoins,
      receiverPercent: percent, receiverDiamonds: diamonds, receiverCoins, senderBalanceAfter: balanceAfter, createdAt: now,
      lucky: isLucky, luckyReward: reward, luckyBestMultiplier: draw.best,
    });
    t.create(db.doc(`wallet_transactions/${txId}_sent`), {
      uid: sender.uid, type: 'gift_sent', currency: 'coins', amount: -totalCoins, balanceAfter: afterPayment, refId: txId, roomId: roomId ?? null, createdAt: now,
    });
    if (reward > 0) {
      t.create(db.doc(`wallet_transactions/${txId}_lucky`), {
        uid: sender.uid, type: 'lucky_reward', currency: 'coins', amount: reward, balanceAfter, refId: txId, roomId: roomId ?? null, createdAt: now,
      });
    }
    if (diamonds > 0) {
      t.create(db.doc(`wallet_transactions/${txId}_received`), {
        uid: receiverUid, type: 'gift_received', currency: 'diamonds', amount: diamonds, balanceAfter: receiverDiamondsAfter, refId: txId, roomId: roomId ?? null, createdAt: now,
      });
    }
    if (receiverCoins > 0) {
      t.create(db.doc(`wallet_transactions/${txId}_received_coins`), {
        uid: receiverUid, type: 'gift_received', currency: 'coins', amount: receiverCoins, balanceAfter: receiverCoinsAfter, refId: txId, roomId: null, createdAt: now,
      });
    }
    if (inRoom) {
      t.create(db.doc(`rooms/${roomId}/gift_events/${txId}`), {
        senderUid: sender.uid, senderName: sender.name, senderPhotoURL: sender.photoURL,
        receiverUid, receiverName: String(receiver.name ?? 'User'),
        giftId, giftName: String(gift.name ?? 'Gift'), emoji: String(gift.emoji ?? '🎁'), imageUrl: gift.imageUrl ?? null,
        count, totalCoins, lucky: isLucky, luckyReward: reward, luckyMultiplier: draw.best, createdAt: now,
      });
    } else {
      // a gift in a private chat: a message in the chat of the two people (the chat is made if it does not exist yet)
      const text = `🎁 Sent ${String(gift.emoji ?? '')} ${String(gift.name ?? 'a gift')} x${count}${receiverCoins > 0 ? ` (+${receiverCoins} coins)` : ''}`.replace(/\s+/g, ' ');
      const last = { text, senderUid: sender.uid };
      t.create(db.doc(`private_chats/${chatId}/messages/gift_${txId}`), { senderUid: sender.uid, text, createdAt: now });
      if (extra1.exists) {
        t.update(chatRef, { lastMessage: last, lastMessageAt: now, [`unread.${receiverUid}`]: FieldValue.increment(1) });
      } else {
        t.create(chatRef, { members: [sender.uid, receiverUid].sort(), lastMessage: last, lastMessageAt: now, unread: { [receiverUid]: 1 }, createdAt: now });
      }
    }

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
