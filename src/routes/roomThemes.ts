// NEW FILE. POST /room-themes/buy  { roomId, themeId, requestId }
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { buyRoomTheme, removeCustomBackground, setCustomBackground } from '../services/roomThemeService';

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

// POST /room-themes/custom  { roomId, requestId, imageUrl }: the owner's own picture. Buys the custom theme the first time
// (coins are taken only if the picture is saved too: one transaction). The body can be big: app.ts allows 400kb for this path.
const customBody = z
  .object({
    roomId: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
    requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    imageUrl: z.string().min(50).max(240_000),
  })
  .strict();

router.post(
  '/custom',
  authenticate,
  rateLimit({
    windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user?.uid ?? 'anonymous',
    handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many requests. Please wait a moment.')),
    validate: { keyGeneratorIpFallback: false },
  }),
  async (req, res, next) => {
    try {
      const b = customBody.parse(req.body);
      res.json({ ok: true, ...(await setCustomBackground(req.user!, b.roomId, b.imageUrl, b.requestId)) });
    } catch (e) {
      next(e);
    }
  },
);

// POST /room-themes/custom/remove  { roomId }
router.post('/custom/remove', authenticate, async (req, res, next) => {
  try {
    const b = z.object({ roomId: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/) }).strict().parse(req.body);
    await removeCustomBackground(req.user!, b.roomId);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
