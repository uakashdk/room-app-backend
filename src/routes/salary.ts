import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { getAgencyEarnings, getHostCenter, listMyRecords } from '../services/salaryService';
import { cancelWithdrawal, listMyWithdrawals, requestWithdrawal } from '../services/withdrawalService';

const router = Router();
router.use(authenticate);

const writeLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user?.uid ?? 'anonymous',
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many tries. Please wait a few minutes.')),
});

const idParam = z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/);

// ---- salary (host, and agency owner for the commission)
router.get('/me', async (req, res, next) => {
  try { res.json(await getHostCenter(req.user!.uid)); } catch (e) { next(e); }
});
router.get('/records', async (req, res, next) => {
  try { res.json({ items: await listMyRecords(req.user!.uid) }); } catch (e) { next(e); }
});
router.get('/agency', async (req, res, next) => {
  try { res.json(await getAgencyEarnings(req.user!.uid)); } catch (e) { next(e); }
});

// ---- withdrawals
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const details = z.discriminatedUnion('method', [
  z.object({ method: z.literal('upi'), upiId: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,64}@[a-z]{2,32}$/, 'Enter a valid UPI ID, like name@bank.') }).strict(),
  z.object({
    method: z.literal('bank'),
    accountName: text(2, 60),
    accountNumber: z.string().trim().regex(/^\d{9,18}$/, 'The account number has 9 to 18 digits.'),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code.'),
  }).strict(),
  z.object({ method: z.literal('paypal'), paypalEmail: z.string().trim().toLowerCase().email('Enter a valid PayPal email.').max(100) }).strict(),
]);

router.get('/withdrawals', async (req, res, next) => {
  try { res.json({ items: await listMyWithdrawals(req.user!.uid) }); } catch (e) { next(e); }
});

router.post('/withdrawals', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ amountCents: z.number().int().min(1).max(100_000_000), details }).strict().parse(req.body);
    res.json(await requestWithdrawal(req.user!, b.amountCents, b.details));
  } catch (e) { next(e); }
});

router.post('/withdrawals/:id/cancel', writeLimiter, async (req, res, next) => {
  try {
    await cancelWithdrawal(req.user!, idParam.parse(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
