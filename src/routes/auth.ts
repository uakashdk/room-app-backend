import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler';
import { sendEmailOtp, verifyEmailOtp } from '../services/emailOtpService';

const router = Router();

const email = z.string().trim().toLowerCase().max(254).email();

// per IP: the email itself is also limited inside the service (resend gap, 10 codes a day, 5 wrong tries)
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 10 * 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many attempts. Please try again in a few minutes.')),
  });

router.post('/send-otp', limiter(15), async (req, res, next) => {
  try {
    const input = z.object({ email }).parse(req.body);
    res.json({ ok: true, ...(await sendEmailOtp(input.email)) });
  } catch (e) {
    next(e);
  }
});

router.post('/verify-otp', limiter(30), async (req, res, next) => {
  try {
    const input = z.object({ email, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    res.json({ token: await verifyEmailOtp(input.email, input.code) });
  } catch (e) {
    next(e);
  }
});

export default router;
