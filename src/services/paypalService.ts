import { randomUUID } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { env } from '../config/env';
import { db } from '../config/firebase';
import { AppError } from '../middleware/error-handler';

/**
 * Coin recharge with PayPal (Orders v2, "capture" flow).
 *
 *  1. The app asks for an order for a package id. The PRICE IS READ FROM THE DATABASE, never from the app.
 *  2. The person approves the payment on PayPal's page (opened inside the app).
 *  3. Our server captures the payment, checks the paid amount against the package and ONLY THEN adds the coins.
 *  4. A webhook from PayPal is a second way to reach step 3, so coins arrive even if the phone closes in between.
 *
 * Every order is saved in recharge_transactions/<PayPal order id>. A completed order can never be credited twice
 * (the status is checked and changed inside one Firestore transaction). The app never changes a balance.
 */

const BASE = env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const MAX_ORDERS_PER_DAY = 15;

export const paypalConfigured = (): boolean => !!env.PAYPAL_CLIENT_ID && !!env.PAYPAL_CLIENT_SECRET;

// ---------------------------------------------------------------- PayPal HTTP
let cached: { token: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (!paypalConfigured()) throw new AppError(503, 'payments-off', 'Payments are not set up yet. Please try again later.');
  if (cached && cached.until > Date.now() + 30_000) return cached.token;
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error('PayPal login failed:', res.status, data?.error, data?.error_description); // never print the keys
    throw new AppError(502, 'paypal-auth', 'Payment service is not available. Please try again later.');
  }
  cached = { token: String(data.access_token), until: Date.now() + Number(data.expires_in ?? 300) * 1000 };
  return cached.token;
}

async function paypal(path: string, init: { method: 'GET' | 'POST'; body?: unknown; requestId?: string }): Promise<{ status: number; data: any }> {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.requestId ? { 'PayPal-Request-Id': init.requestId } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const cents = (v: unknown): number => Math.round(Number(v) * 100);

// ---------------------------------------------------------------- 1. create the order
export type CreatedOrder = { orderId: string; approveUrl: string };

export async function createRechargeOrder(uid: string, packageId: string): Promise<CreatedOrder> {
  const pkgSnap = await db.doc(`recharge_packages/${packageId}`).get();
  const pkg = pkgSnap.data();
  if (!pkgSnap.exists || !pkg || pkg.enabled !== true) throw new AppError(404, 'package-not-found', 'This package is not available.');
  const price = Number(pkg.price);
  const coins = Math.floor(Number(pkg.coins));
  const bonusCoins = Math.max(0, Math.floor(Number(pkg.bonusCoins ?? 0)));
  const currency = pkg.currency === 'INR' ? 'INR' : 'USD';
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(coins) || coins <= 0) throw new AppError(409, 'package-invalid', 'This package is not available.');

  // a limit on how many orders one person can start in a day
  const mine = await db.collection('recharge_transactions').where('uid', '==', uid).limit(60).get();
  const dayAgo = Date.now() - 24 * 3600_000;
  if (mine.docs.filter((d) => (d.data().createdAt?.toMillis?.() ?? 0) > dayAgo).length >= MAX_ORDERS_PER_DAY) {
    throw new AppError(429, 'recharge-limit', 'Too many recharge tries today. Please try again tomorrow.');
  }

  const invoiceId = `HL-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { status, data } = await paypal('/v2/checkout/orders', {
    method: 'POST',
    requestId: randomUUID(),
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: packageId, custom_id: uid, invoice_id: invoiceId,
        description: `${coins + bonusCoins} coins - Hyper Live`.slice(0, 120),
        amount: { currency_code: currency, value: price.toFixed(2) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Hyper Live', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
            return_url: `${env.PUBLIC_API_URL}/payments/paypal/return`, cancel_url: `${env.PUBLIC_API_URL}/payments/paypal/cancel`,
          },
        },
      },
    },
  });
  const approveUrl = (data.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (status >= 300 || !data.id || !approveUrl) {
    console.error('PayPal create order failed:', status, JSON.stringify(data).slice(0, 500));
    throw new AppError(502, 'paypal-create', 'Could not start the payment. Please try again.');
  }

  await db.doc(`recharge_transactions/${data.id}`).create({
    uid, provider: 'paypal', status: 'created', packageId, packageName: String(pkg.name ?? 'Package'),
    currency, price, coins, bonusCoins, invoiceId, createdAt: FieldValue.serverTimestamp(),
  });
  return { orderId: String(data.id), approveUrl: String(approveUrl) };
}

// ---------------------------------------------------------------- 2/3. capture + credit
export type RechargeResult = {
  status: 'completed' | 'pending' | 'failed' | 'refunded';
  coins: number; bonusCoins: number; balance: number | null; orderId: string; receipt: string | null;
};

async function readResult(orderId: string, status: RechargeResult['status']): Promise<RechargeResult> {
  const doc = (await db.doc(`recharge_transactions/${orderId}`).get()).data();
  const user = doc?.uid ? (await db.doc(`users/${doc.uid}`).get()).data() : null;
  return {
    status, orderId, coins: Number(doc?.coins ?? 0), bonusCoins: Number(doc?.bonusCoins ?? 0),
    balance: user ? Number(user.coins ?? 0) : null, receipt: doc?.captureId ? String(doc.captureId) : null,
  };
}

/** Adds the coins for a paid order. Runs inside a transaction: calling it twice (phone + webhook) credits only once. */
async function creditOrder(orderId: string, capture: { id: string; amount: { value: string; currency_code: string }; payerEmail?: string | null }): Promise<boolean> {
  const orderRef = db.doc(`recharge_transactions/${orderId}`);
  return db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    const o = snap.data();
    if (!snap.exists || !o) throw new AppError(404, 'order-not-found', 'This payment was not found.');
    if (o.status === 'completed' || o.status === 'refunded') return false; // already done
    // the paid amount must be exactly the package price
    if (cents(capture.amount.value) !== cents(o.price) || capture.amount.currency_code !== o.currency) {
      t.update(orderRef, { status: 'failed', failReason: 'amount-mismatch', paidValue: capture.amount.value, paidCurrency: capture.amount.currency_code });
      console.error(`Recharge ${orderId}: paid ${capture.amount.value} ${capture.amount.currency_code}, expected ${o.price} ${o.currency}`);
      return false;
    }
    const userRef = db.doc(`users/${o.uid}`);
    const userSnap = await t.get(userRef);
    if (!userSnap.exists) throw new AppError(404, 'user-not-found', 'This account does not exist.');
    const before = Number(userSnap.data()?.coins ?? 0);
    const afterBase = before + Number(o.coins);
    const afterAll = afterBase + Number(o.bonusCoins ?? 0);
    const now = FieldValue.serverTimestamp();

    t.update(userRef, { coins: afterAll, coinsBought: FieldValue.increment(Number(o.coins)) }); // coinsBought = the Coin buyers ranking (paid coins, bonus not counted)
    t.update(orderRef, { status: 'completed', captureId: capture.id, payerEmail: capture.payerEmail ?? null, completedAt: now });
    t.create(db.doc(`wallet_transactions/${orderId}_recharge`), {
      uid: o.uid, type: 'recharge', currency: 'coins', amount: Number(o.coins), balanceAfter: afterBase, refId: orderId,
      note: `${o.packageName} (${o.price} ${o.currency})`, createdAt: now,
    });
    if (Number(o.bonusCoins ?? 0) > 0) {
      t.create(db.doc(`wallet_transactions/${orderId}_bonus`), {
        uid: o.uid, type: 'recharge_bonus', currency: 'coins', amount: Number(o.bonusCoins), balanceAfter: afterAll, refId: orderId, note: 'Bonus coins', createdAt: now,
      });
    }
    return true;
  });
}

/** Called after the person comes back from PayPal (and by the return page). Safe to call many times. */
export async function captureRecharge(uid: string | null, orderId: string): Promise<RechargeResult> {
  const orderRef = db.doc(`recharge_transactions/${orderId}`);
  const o = (await orderRef.get()).data();
  if (!o) throw new AppError(404, 'order-not-found', 'This payment was not found.');
  if (uid && o.uid !== uid) throw new AppError(403, 'forbidden', 'This payment belongs to another account.');
  if (o.status === 'completed' || o.status === 'refunded') return readResult(orderId, o.status);
  if (o.status === 'failed') return readResult(orderId, 'failed');

  let r = await paypal(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST', body: {}, requestId: `capture-${orderId}` });
  const issue = r.data?.details?.[0]?.issue;
  if (r.status === 422 && issue === 'ORDER_NOT_APPROVED') return readResult(orderId, 'pending'); // the person did not pay (yet)
  if (r.status === 422 && issue === 'ORDER_ALREADY_CAPTURED') r = await paypal(`/v2/checkout/orders/${orderId}`, { method: 'GET' });
  if (r.status >= 300) {
    console.error('PayPal capture failed:', r.status, JSON.stringify(r.data).slice(0, 500));
    if ([400, 404, 422].includes(r.status)) { await orderRef.update({ status: 'failed', failReason: String(r.data?.details?.[0]?.issue ?? 'paypal-error') }); return readResult(orderId, 'failed'); } // declined, expired ...
    throw new AppError(502, 'paypal-capture', 'Could not confirm the payment right now. If money was taken, the coins will arrive automatically.');
  }

  const unit = r.data?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (!cap) return readResult(orderId, 'pending');
  if (unit.custom_id && unit.custom_id !== o.uid) throw new AppError(409, 'order-mismatch', 'This payment does not match your account.');
  if (cap.status === 'COMPLETED') {
    await creditOrder(orderId, { id: String(cap.id), amount: cap.amount, payerEmail: r.data?.payer?.email_address ?? null });
    return readResult(orderId, ((await orderRef.get()).data()?.status as RechargeResult['status']) ?? 'failed');
  }
  if (cap.status === 'PENDING') { await orderRef.update({ status: 'pending_review', captureId: String(cap.id) }); return readResult(orderId, 'pending'); }
  await orderRef.update({ status: 'failed', failReason: `capture-${String(cap.status).toLowerCase()}` });
  return readResult(orderId, 'failed');
}

/** The person closed or cancelled the PayPal page. */
export async function cancelRecharge(orderId: string): Promise<void> {
  const ref = db.doc(`recharge_transactions/${orderId}`);
  const o = (await ref.get()).data();
  if (o?.status === 'created') await ref.update({ status: 'cancelled' });
}

/** My own recharge receipts, newest first. */
export async function listReceipts(uid: string) {
  const snap = await db.collection('recharge_transactions').where('uid', '==', uid).limit(60).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as any)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
    .slice(0, 30)
    .map((x) => ({
      orderId: x.id, status: String(x.status), packageName: String(x.packageName ?? ''), currency: String(x.currency), price: Number(x.price),
      coins: Number(x.coins), bonusCoins: Number(x.bonusCoins ?? 0), receipt: x.captureId ?? null,
      createdAt: x.createdAt?.toMillis?.() ?? null, completedAt: x.completedAt?.toMillis?.() ?? null,
    }));
}

// ---------------------------------------------------------------- 4. webhook (PayPal tells us about payments and refunds)
export async function handleWebhook(headers: Record<string, string | string[] | undefined>, event: any): Promise<void> {
  if (!env.PAYPAL_WEBHOOK_ID) throw new AppError(503, 'webhook-off', 'Webhook is not set up.');
  const h = (k: string) => String(headers[k] ?? '');
  const verify = await paypal('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: event,
    },
  });
  if (verify.data?.verification_status !== 'SUCCESS') throw new AppError(400, 'bad-signature', 'Webhook signature is not valid.');

  const type = String(event?.event_type ?? '');
  const res = event?.resource ?? {};
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const orderId = String(res?.supplementary_data?.related_ids?.order_id ?? '');
    if (orderId && res.status === 'COMPLETED') await creditOrder(orderId, { id: String(res.id), amount: res.amount });
  } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    // a refund is only RECORDED here for the admin to look at; coins are not taken back by themselves
    const found = await db.collection('recharge_transactions').where('captureId', '==', String(res?.id ?? res?.links?.find?.((l: any) => l.rel === 'up')?.href?.split('/').pop() ?? '')).limit(1).get();
    const doc = found.docs[0];
    if (doc && doc.data().status !== 'refunded') {
      await doc.ref.update({ status: 'refunded', refundedAt: FieldValue.serverTimestamp() });
      await db.doc(`users/${doc.data().uid}`).update({ coinsBought: FieldValue.increment(-Number(doc.data().coins ?? 0)) }).catch(() => undefined); // a refunded purchase must not stay in the ranking
      await db.collection('admin_logs').doc().create({
        actorUid: 'paypal', actorName: 'PayPal', action: 'recharge_refunded', collection: 'recharge_transactions', targetId: doc.id,
        details: { uid: doc.data().uid, coins: doc.data().coins, bonusCoins: doc.data().bonusCoins ?? 0, event: type }, at: FieldValue.serverTimestamp(),
      });
    }
  }
}
