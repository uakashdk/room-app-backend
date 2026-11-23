import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { cancelRecharge, captureRecharge, createRechargeOrder, handleWebhook, listReceipts } from '../services/paypalService';

const router = Router();

const orderIdParam = z.string().regex(/^[A-Za-z0-9]{8,40}$/, 'Wrong order id.');
const packageIdParam = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

// per person (never trusts the IP alone): a few payment tries per ten minutes
const payLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.uid ?? 'anonymous',
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many tries. Please wait a few minutes.')),
});

// 1. the app asks for a PayPal order for a package (the price comes from the database)
router.post('/paypal/orders', authenticate, payLimiter, async (req, res, next) => {
  try {
    const b = z.object({ packageId: packageIdParam }).strict().parse(req.body);
    res.json(await createRechargeOrder(req.user!.uid, b.packageId));
  } catch (e) { next(e); }
});

// 2. the app asks "did it work?" after the PayPal page closes (the server checks with PayPal, then adds the coins once)
router.post('/paypal/capture', authenticate, payLimiter, async (req, res, next) => {
  try {
    const b = z.object({ orderId: orderIdParam }).strict().parse(req.body);
    res.json(await captureRecharge(req.user!.uid, b.orderId));
  } catch (e) { next(e); }
});

// my receipts
router.get('/receipts', authenticate, async (req, res, next) => {
  try { res.json({ items: await listReceipts(req.user!.uid) }); } catch (e) { next(e); }
});

// ---- PayPal sends the browser back here (no login: the order itself says whose it is, and the amount is checked) ----
const backToApp = (status: string, orderId: string) => `${env.APP_SCHEME}://payment?status=${encodeURIComponent(status)}&orderId=${encodeURIComponent(orderId)}`;
const page = (title: string, url: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font-family:sans-serif;background:#0E0630;color:#fff;text-align:center;padding:48px 20px}a{display:inline-block;margin-top:24px;padding:14px 28px;border-radius:26px;background:#F4C542;color:#1a1020;text-decoration:none;font-weight:700}</style></head>` +
  `<body><h2>${title}</h2><p>You can go back to the app now.</p><a href="${url}">Open Hyper Live</a></body></html>`;

const webLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/paypal/return', webLimiter, async (req, res) => {
  const orderId = String(req.query.token ?? '');
  if (!orderIdParam.safeParse(orderId).success) return res.status(400).send('Wrong payment link.');
  let status = 'failed';
  try { status = (await captureRecharge(null, orderId)).status; } catch (e: any) { console.error('PayPal return failed:', e?.message ?? e); status = 'error'; }
  const url = backToApp(status, orderId);
  res.status(302).set('Location', url).send(page(status === 'completed' ? 'Payment received' : 'Payment status', url));
});

router.get('/paypal/cancel', webLimiter, async (req, res) => {
  const orderId = String(req.query.token ?? '');
  if (orderIdParam.safeParse(orderId).success) await cancelRecharge(orderId).catch(() => {});
  const url = backToApp('cancelled', orderId);
  res.status(302).set('Location', url).send(page('Payment cancelled', url));
});

// PayPal tells us about payments and refunds (a second way to add the coins, and the only way we hear about refunds)
router.post('/paypal/webhook', webLimiter, async (req, res, next) => {
  try {
    await handleWebhook(req.headers, req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
