import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/error-handler';
import adminRouter from './routes/admin';
import arcadeRouter from './routes/arcade';
import authRouter from './routes/auth';
import { agencyRouter, hostRouter } from './routes/host';
import framesRouter from './routes/Frames';
import giftsRouter from './routes/gifts';
import paymentsRouter from './routes/payments';
import roomThemesRouter from './routes/roomThemes';
import vipRouter from './routes/vip';
import walletRouter from './routes/wallet';

export const app = express();

app.set('trust proxy', 1); // behind the host's proxy: the real client IP is used for rate limiting
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.corsOrigins.length ? env.corsOrigins : false })); // the phone app does not need CORS; browsers must be listed
// the VIP level form carries a small frame picture (about 100 KB), so only that one route accepts a bigger body
app.use('/admin/vip-levels', express.json({ limit: '400kb' }));
app.use('/room-themes/custom', express.json({ limit: '400kb' })); // the owner's own room background picture
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false })); // a general limit per IP

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRouter);
app.use('/host', hostRouter);
app.use('/agency', agencyRouter);
app.use('/gifts', giftsRouter);
app.use('/wallet', walletRouter);
app.use('/payments', paymentsRouter);
app.use('/frames', framesRouter);
app.use('/vip', vipRouter);
app.use('/room-themes', roomThemesRouter);
app.use('/arcade', arcadeRouter);
app.use('/admin', adminRouter);

app.use(notFound);
app.use(errorHandler);