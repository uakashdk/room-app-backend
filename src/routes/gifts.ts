import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { sendGift } from '../services/giftService';

const router = Router();

const body = z.object({
  roomId: z.string().min(1).max(40).regex(/^[A-Za-z0-9]+$/).optional(), // none = a gift in a private chat
  giftId: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/),
  receiverUid: z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/),
  count: z.number().int().min(1).max(99),
  requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

// at most 40 gift requests per minute for one person (the key is the user, not the IP)
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.uid ?? 'anonymous',
  handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'You are sending gifts too fast.')),
  validate: { keyGeneratorIpFallback: false },
});

router.post('/send', authenticate, limiter, async (req, res, next) => {
  try {
    const input = body.parse(req.body);
    const result = await sendGift(req.user!, input);
    res.json({ balance: result.balance, txId: result.txId, duplicate: result.duplicate, lucky: result.lucky, luckyReward: result.luckyReward });
  } catch (e) {
    next(e);
  }
});

export default router;
