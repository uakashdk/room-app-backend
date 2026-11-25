// NEW FILE.
//   GET  /arcade/games           the games and the stake amounts (logged-in people)
//   POST /arcade/start           { gameId, stake, roomId? }  -> { sessionId, launchUrl, stake, balance }
//   POST /arcade/end             { sessionId }               -> { payout, stake, balance }
//   POST /arcade/webhook/:secret PrimeArcade calls this (session.created, round.completed). No login: the secret in the URL is the proof.
import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import { getArcadeSettings, handleRound, listGames, settleSession, startGame } from '../services/arcadeService';

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user?.uid ?? 'anonymous',
  handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many requests. Please wait a moment.')),
  validate: { keyGeneratorIpFallback: false },
});

router.get('/games', authenticate, limiter, async (_req, res, next) => {
  try {
    const settings = await getArcadeSettings();
    res.json({ ok: true, enabled: settings.enabled, stakes: settings.stakes, games: settings.enabled ? await listGames() : [] });
  } catch (e) {
    next(e);
  }
});

const startBody = z
  .object({
    gameId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    stake: z.number().int().positive().max(1_000_000),
    roomId: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();

router.post('/start', authenticate, limiter, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await startGame(req.user!, startBody.parse(req.body))) });
  } catch (e) {
    next(e);
  }
});

router.post('/end', authenticate, limiter, async (req, res, next) => {
  try {
    const b = z.object({ sessionId: z.string().min(5).max(40).regex(/^[A-Za-z0-9]+$/) }).strict().parse(req.body);
    res.json({ ok: true, ...(await settleSession(b.sessionId, 'player-closed', req.user!.uid)) });
  } catch (e) {
    next(e);
  }
});

router.post('/webhook/:secret', async (req, res, next) => {
  try {
    const secret = env.ARCADE_WEBHOOK_SECRET;
    if (!secret) throw new AppError(503, 'arcade-not-set-up', 'Games are not set up yet.');
    const given = Buffer.from(String(req.params.secret));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new AppError(404, 'not-found', 'Not found.');
    const event = String(req.get('x-event') ?? req.body?.event ?? '');
    if (event === 'round.completed') await handleRound(req.body?.data);
    res.json({ ok: true }); // session.created and other events: just acknowledged
  } catch (e) {
    next(e);
  }
});

export default router;
