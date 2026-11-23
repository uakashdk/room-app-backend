// NEW FILE. POST /room-themes/buy  { roomId, themeId, requestId }
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { buyRoomTheme } from '../services/roomThemeService';

const router = Router();

const body = z
  .object({
    roomId: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
    themeId: z.string().min(1).max(30).regex(/^[a-z0-9_-]+$/),
    requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

router.post(
  '/buy',
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
      res.json({ ok: true, ...(await buyRoomTheme(req.user!, b.roomId, b.themeId, b.requestId)) });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
