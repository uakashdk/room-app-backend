import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../config/firebase';
import { authenticate } from '../middleware/authenticate';
import { requireRole } from '../middleware/authorize';
import { AppError } from '../middleware/error-handler';
import { createPackage, updateEconomy, updatePackage } from '../services/economyService';
import { createAgency, decideApplication, listAgenciesAdmin, listApplicationsAdmin, updateAgency } from '../services/hostService';
import {
  CHAT_EFFECTS, ENTRY_EFFECTS, FRAME_STYLES, createVipLevel, grantVip, listAllVipSubscriptions, revokeVip, setGiftVipTier, updateVipLevel,
} from '../services/vipService';
import { setGiftLucky } from '../services/giftService';
import { decideSalary, generateWeek, getPolicy, getWithdrawalSettings, listSalaryAdmin, savePolicy, saveWithdrawalSettings } from '../services/salaryService';
import { weekKey } from '../services/roomLevels';
import { approveWithdrawal, listWithdrawalsAdmin, rejectWithdrawal } from '../services/withdrawalService';

const router = Router();

// everything here is for the SUPER ADMIN only (the `role` custom claim is checked on the server)
router.use(
  authenticate,
  requireRole('super_admin'),
  rateLimit({
    windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user?.uid ?? 'anonymous',
    handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many requests.')),
    validate: { keyGeneratorIpFallback: false },
  }),
);

const economyBody = z
  .object({
    coinsPerUSD: z.number().positive().max(100000),
    coinsPerINR: z.number().positive().max(10000),
    giftReceiverPercent: z.number().min(0).max(100),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change.' });

router.put('/economy', async (req, res, next) => {
  try {
    res.json({ ok: true, economy: await updateEconomy(req.user!, economyBody.parse(req.body)) });
  } catch (e) {
    next(e);
  }
});

const money = z.number().positive().max(1_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, { message: 'Max 2 decimals.' });
const coinCount = z.number().int().min(1).max(100_000_000);

const packageFields = {
  name: z.string().trim().min(1).max(40),
  currency: z.enum(['USD', 'INR']),
  price: money,
  coins: coinCount, // optional when creating: if empty, the server uses price x the rate
  bonusCoins: z.number().int().min(0).max(100_000_000),
  enabled: z.boolean(),
  order: z.number().int().min(0).max(1000),
};

const createBody = z
  .object({
    ...packageFields,
    coins: packageFields.coins.optional(),
    bonusCoins: packageFields.bonusCoins.default(0),
    enabled: packageFields.enabled.default(true),
    order: packageFields.order.default(0),
  })
  .strict();

const updateBody = z
  .object(packageFields)
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change.' });

router.post('/coin-packages', async (req, res, next) => {
  try {
    res.status(201).json(await createPackage(req.user!, createBody.parse(req.body)));
  } catch (e) {
    next(e);
  }
});

router.put('/coin-packages/:id', async (req, res, next) => {
  try {
    const id = z.string().min(1).max(40).regex(/^[A-Za-z0-9]+$/).parse(req.params.id);
    await updatePackage(req.user!, id, updateBody.parse(req.body));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------- VIP ----------------
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #F4C542.');
const vipFields = {
  name: z.string().trim().min(1).max(24),
  tier: z.number().int().min(1).max(20),
  priceCoins: z.number().int().min(0).max(100_000_000),
  days: z.number().int().min(1).max(3650),
  color: hex,
  color2: hex,
  badgeText: z.string().trim().min(1).max(10),
  frameStyle: z.enum(FRAME_STYLES),
  entryEffect: z.enum(ENTRY_EFFECTS),
  entryMessage: z.string().trim().max(60),
  chatEffect: z.enum(CHAT_EFFECTS),
  perks: z.array(z.string().trim().min(1).max(80)).max(12),
  // a small picture frame, stored inside the level (like the room pictures). At most about 190 KB of image.
  frameImage: z.union([z.literal(''), z.string().max(260_000).regex(/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/, 'The frame must be a PNG or WebP picture.')]),
  order: z.number().int().min(0).max(1000),
  enabled: z.boolean(),
};
const vipCreate = z
  .object({ ...vipFields, entryMessage: vipFields.entryMessage.default(''), perks: vipFields.perks.default([]), frameImage: vipFields.frameImage.default(''), order: vipFields.order.default(0), enabled: vipFields.enabled.default(true) })
  .strict();
const { tier: _tier, ...vipPatchFields } = vipFields; // the tier cannot be changed later
const vipPatch = z.object(vipPatchFields).partial().strict().refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change.' });
const idParam = z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/);

router.post('/vip-levels', async (req, res, next) => {
  try {
    res.status(201).json(await createVipLevel(req.user!, vipCreate.parse(req.body)));
  } catch (e) {
    next(e);
  }
});

router.put('/vip-levels/:id', async (req, res, next) => {
  try {
    await updateVipLevel(req.user!, idParam.parse(req.params.id), vipPatch.parse(req.body));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get('/vip-subscriptions', async (req, res, next) => {
  try {
    const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/).optional().parse(req.query.uid);
    res.json({ items: await listAllVipSubscriptions(uid) });
  } catch (e) {
    next(e);
  }
});

// give VIP to a person by their User ID (the 6 digits shown in the app)
router.post('/vip-grant', async (req, res, next) => {
  try {
    const b = z
      .object({ userId: z.string().regex(/^\d{6}$/, 'The User ID has 6 digits.'), levelId: idParam, days: z.number().int().min(1).max(3650), note: z.string().trim().max(120).default('') })
      .strict()
      .parse(req.body);
    const found = await db.collection('users').where('userId', '==', b.userId).limit(1).get();
    if (found.empty) throw new AppError(404, 'user-not-found', 'No user has this User ID.');
    res.json({ ok: true, ...(await grantVip(req.user!, found.docs[0].id, b.levelId, b.days, b.note)) });
  } catch (e) {
    next(e);
  }
});

router.post('/vip-revoke', async (req, res, next) => {
  try {
    const b = z.object({ userId: z.string().regex(/^\d{6}$/), reason: z.string().trim().min(3).max(120) }).strict().parse(req.body);
    const found = await db.collection('users').where('userId', '==', b.userId).limit(1).get();
    if (found.empty) throw new AppError(404, 'user-not-found', 'No user has this User ID.');
    await revokeVip(req.user!, found.docs[0].id, b.reason);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// VIP-only gifts: which tier a gift needs (0 = everybody)
router.put('/gifts/:id/vip-tier', async (req, res, next) => {
  try {
    const b = z.object({ minVipTier: z.number().int().min(0).max(20) }).strict().parse(req.body);
    await setGiftVipTier(req.user!, idParam.parse(req.params.id), b.minVipTier);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// lucky gifts: a gift becomes a random "win coins back" gift (the receiver earns no diamonds from it)
router.put('/gifts/:id/lucky', async (req, res, next) => {
  try {
    const b = z.object({ lucky: z.boolean() }).strict().parse(req.body);
    await setGiftLucky(req.user!, idParam.parse(req.params.id), b.lucky);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------- Host salary and withdrawals ----------------

const weekParam = z.string().regex(/^\d{4}-W\d{2}$/, 'Week looks like 2026-W47.');
const recordIds = z.array(z.string().min(3).max(80).regex(/^[A-Za-z0-9_-]+$/)).min(1).max(300);

// the salary levels (the host policy) and the withdrawal rules: the admin decides, nothing is hard-coded
router.get('/host-policy', async (_req, res, next) => {
  try { res.json({ policy: await getPolicy(), withdrawal: await getWithdrawalSettings(), currentWeek: weekKey() }); } catch (e) { next(e); }
});

router.put('/host-policy', async (req, res, next) => {
  try {
    const b = z.object({
      minActiveDays: z.number().int().min(0).max(7),
      minLiveMinutes: z.number().int().min(0).max(10080),
      levels: z.array(z.object({
        targetDiamonds: z.number().int().min(1).max(10_000_000_000),
        hostSalaryCents: z.number().int().min(0).max(100_000_000),
        agentSalaryCents: z.number().int().min(0).max(100_000_000),
      }).strict()).min(1).max(60),
    }).strict().parse(req.body);
    res.json({ ok: true, policy: await savePolicy(req.user!, { ...b, levels: b.levels.map((l, i) => ({ ...l, level: i + 1 })) }) });
  } catch (e) { next(e); }
});

router.put('/withdrawal-settings', async (req, res, next) => {
  try {
    const b = z.object({
      enabled: z.boolean(),
      minCents: z.number().int().min(1).max(100_000_000),
      maxCents: z.number().int().min(1).max(100_000_000),
      dailyLimitCents: z.number().int().min(1).max(1_000_000_000),
      methods: z.array(z.enum(['upi', 'bank', 'paypal'])).min(1),
    }).strict().refine((o) => o.minCents <= o.maxCents, { message: 'The smallest amount cannot be bigger than the largest.' }).parse(req.body);
    res.json({ ok: true, withdrawal: await saveWithdrawalSettings(req.user!, b) });
  } catch (e) { next(e); }
});

// weekly salary records: look, approve, reject (a bulk call takes many ids at once)
router.get('/salary', async (req, res, next) => {
  try {
    const q = z.object({ week: weekParam.optional(), status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query);
    res.json({ items: await listSalaryAdmin(q), currentWeek: weekKey() });
  } catch (e) { next(e); }
});

router.post('/salary/decision', async (req, res, next) => {
  try {
    const b = z.object({ ids: recordIds, decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(200).nullable().optional() }).strict().parse(req.body);
    res.json({ ok: true, ...(await decideSalary(req.user!, b.ids, b.decision, b.reason ?? null)) });
  } catch (e) { next(e); }
});

// makes the records of a finished week by hand (the server does it by itself every Monday)
router.post('/salary/run-week', async (req, res, next) => {
  try {
    const b = z.object({ week: weekParam }).strict().parse(req.body);
    if (b.week >= weekKey()) throw new AppError(400, 'week-not-finished', 'Only a finished week can be calculated.');
    res.json({ ok: true, ...(await generateWeek(b.week)) });
  } catch (e) { next(e); }
});

// withdrawal requests: pay outside the app, then approve with the payment reference (or reject with a reason)
router.get('/withdrawals', async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).default('pending') }).parse(req.query);
    res.json({ items: await listWithdrawalsAdmin(q.status) });
  } catch (e) { next(e); }
});

router.post('/withdrawals/:id/approve', async (req, res, next) => {
  try {
    const b = z.object({ paymentRef: z.string().trim().min(3).max(80) }).strict().parse(req.body);
    await approveWithdrawal(req.user!, z.string().min(1).max(60).parse(req.params.id), b.paymentRef);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/withdrawals/:id/reject', async (req, res, next) => {
  try {
    const b = z.object({ reason: z.string().trim().min(3).max(200) }).strict().parse(req.body);
    await rejectWithdrawal(req.user!, z.string().min(1).max(60).parse(req.params.id), b.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- Agencies and host requests ----------------
router.get('/agencies', async (_req, res, next) => {
  try { res.json({ items: await listAgenciesAdmin() }); } catch (e) { next(e); }
});

router.post('/agencies', async (req, res, next) => {
  try {
    const b = z.object({ name: z.string().trim().min(2).max(40), ownerUserId: z.string().regex(/^\d{6}$/, 'The owner User ID has 6 digits.'), commissionPercent: z.number().min(0).max(100).default(0) }).strict().parse(req.body);
    res.status(201).json(await createAgency(req.user!, b));
  } catch (e) { next(e); }
});

router.put('/agencies/:id', async (req, res, next) => {
  try {
    const b = z.object({ name: z.string().trim().min(2).max(40), status: z.enum(['active', 'suspended']), commissionPercent: z.number().min(0).max(100) }).partial().strict().refine((o) => Object.keys(o).length > 0, { message: 'Nothing to change.' }).parse(req.body);
    await updateAgency(req.user!, z.string().regex(/^\d{6}$/).parse(req.params.id), b);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/host-applications', async (_req, res, next) => {
  try { res.json({ items: await listApplicationsAdmin() }); } catch (e) { next(e); }
});

// a Super admin can decide for an agency owner who is not there; it is written to the audit log with viaAdmin: true
router.post('/host-applications/:uid/decision', async (req, res, next) => {
  try {
    const b = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(120).default('') }).strict().parse(req.body);
    await decideApplication(req.user!, z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/).parse(req.params.uid), b.decision, b.reason, true);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
