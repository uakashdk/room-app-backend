import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';

/** Extra details of a gift row (taken from gift_transactions). The app shows them when present and works without them. */
export type GiftInfo = { giftId: string; giftName: string; count: number; senderName: string; receiverName: string; senderUid: string; receiverUid: string };

export type WalletTx = {
  id: string; type: string; currency: string; amount: number; balanceAfter: number; note: string | null; createdAt: number | null;
  gift?: GiftInfo;
};

/**
 * The person's own wallet history, newest first. `cursor` is the id of the last record of the previous page.
 * NOTE: this query needs ONE Firestore index (wallet_transactions: uid ascending + createdAt descending).
 * The first time it runs, the server log shows a link that creates it with one click.
 */
export async function listTransactions(uid: string, limit: number, cursor?: string): Promise<{ items: WalletTx[]; nextCursor: string | null }> {
  try {
    let q = db.collection('wallet_transactions').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit + 1);
    if (cursor) {
      const last = await db.doc(`wallet_transactions/${cursor}`).get();
      if (last.exists && last.data()?.uid === uid) q = q.startAfter(last);
    }
    const snap = await q.get();
    const docs = snap.docs.slice(0, limit);
    // gift rows point to their gift_transactions record (refId): read them all at once to add the gift name and the other person
    const refIds = [...new Set(docs.filter((d) => String(d.data().type).startsWith('gift_') && d.data().refId).map((d) => String(d.data().refId)))];
    const giftDocs = refIds.length ? await db.getAll(...refIds.map((id) => db.doc(`gift_transactions/${id}`))) : [];
    const gifts = new Map<string, GiftInfo>();
    for (const g of giftDocs) {
      const y = g.data();
      if (!g.exists || !y) continue;
      gifts.set(g.id, {
        giftId: String(y.giftId ?? ''), giftName: String(y.giftName ?? 'Gift'), count: Number(y.count ?? 1),
        senderName: String(y.senderName ?? 'User'), receiverName: String(y.receiverName ?? 'User'),
        senderUid: String(y.senderUid ?? ''), receiverUid: String(y.receiverUid ?? ''),
      });
    }
    const items: WalletTx[] = docs.map((d) => {
      const x = d.data();
      const gift = x.refId ? gifts.get(String(x.refId)) : undefined;
      return {
        id: d.id, type: String(x.type ?? ''), currency: String(x.currency ?? 'coins'), amount: Number(x.amount ?? 0),
        balanceAfter: Number(x.balanceAfter ?? 0), note: x.note ? String(x.note) : null,
        createdAt: x.createdAt?.toMillis ? x.createdAt.toMillis() : null,
        ...(gift ? { gift } : {}),
      };
    });
    return { items, nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null };
  } catch (e: any) {
    if (e?.code === 9 || String(e?.message).includes('FAILED_PRECONDITION')) {
      console.error('Wallet history needs a Firestore index. Open this link once to create it:\n', e.message);
      throw new AppError(503, 'index-needed', 'History is being set up. Please try again in a few minutes.');
    }
    throw e;
  }
}
