import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { listMyVipHistory, purchaseVip } from '../services/vipService';

const router = Router();

const body = z
  .object({
    levelId: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
    requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

router.post(
  '/purchase',
  authenticate,
  rateLimit({
    windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user?.uid ?? 'anonymous',
    handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many requests. Please wait a moment.')),
    validate: { keyGeneratorIpFallback: false },
  }),
  async (req, res, next) => {
    try {
      const b = body.parse(req.body);
      res.json({ ok: true, ...(await purchaseVip(req.user!, b.levelId, b.requestId)) });
    } catch (e) {
      next(e);
    }
  },
);

router.get('/history', authenticate, async (req, res, next) => {
  try {
    res.json({ items: await listMyVipHistory(req.user!.uid) });
  } catch (e) {
    next(e);
  }
});

export default router;
