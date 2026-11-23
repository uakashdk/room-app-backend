import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';
import {
  applyToAgency, cancelApplication, decideApplication, getHostStatus, listAgencies, listApplications, listPartnerCandidates, removeHost, roomAction, setPartner, transferRoom,
} from '../services/hostService';

const uidParam = z.string().min(1).max(128).regex(/^[A-Za-z0-9]+$/);
const agencyIdParam = z.string().regex(/^\d{6}$/, 'An Agency ID has 6 digits.');

// the ones that write something are limited per person
const writeLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.uid ?? ipKeyGenerator(req.ip ?? '0.0.0.0'),
  handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many tries. Please wait a few minutes.')),
});

// ---------------------------------------------------------------- /host (every logged-in user)
export const hostRouter = Router();
hostRouter.use(authenticate);

hostRouter.get('/status', async (req, res, next) => {
  try { res.json(await getHostStatus(req.user!.uid)); } catch (e) { next(e); }
});

hostRouter.get('/agencies', async (req, res, next) => {
  try {
    const q = z.string().trim().max(40).default('').parse(req.query.q ?? '');
    res.json({ items: await listAgencies(q) });
  } catch (e) { next(e); }
});

hostRouter.post('/apply', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ agencyId: agencyIdParam }).strict().parse(req.body);
    await applyToAgency(req.user!.uid, b.agencyId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

hostRouter.post('/cancel', writeLimiter, async (req, res, next) => {
  try { await cancelApplication(req.user!.uid); res.json({ ok: true }); } catch (e) { next(e); }
});

hostRouter.get('/partner-candidates', async (req, res, next) => {
  try { res.json({ items: await listPartnerCandidates(req.user!.uid) }); } catch (e) { next(e); }
});

hostRouter.put('/partner', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ partnerUid: uidParam.nullable() }).strict().parse(req.body);
    await setPartner(req.user!.uid, b.partnerUid);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// the owner makes his partner the owner of the room
hostRouter.post('/transfer', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ partnerUid: uidParam }).strict().parse(req.body);
    res.json(await transferRoom(req.user!, b.partnerUid));
  } catch (e) { next(e); }
});

// the host or his partner: open / close the room, "still live" beat, show the partner in the room
hostRouter.post('/room', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ hostUid: uidParam, action: z.enum(['start', 'close', 'beat', 'sync']), listeners: z.number().int().min(0).max(5000).default(0) }).strict().parse(req.body);
    res.json(await roomAction(req.user!, b.hostUid, b.action, b.listeners));
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- /agency (the agency owner)
export const agencyRouter = Router();
agencyRouter.use(authenticate);

agencyRouter.get('/applications', async (req, res, next) => {
  try { res.json({ items: await listApplications(req.user!) }); } catch (e) { next(e); }
});

agencyRouter.post('/applications/:uid/decision', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(120).default('') }).strict().parse(req.body);
    await decideApplication(req.user!, uidParam.parse(req.params.uid), b.decision, b.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

agencyRouter.post('/hosts/:uid/remove', writeLimiter, async (req, res, next) => {
  try {
    const b = z.object({ reason: z.string().trim().max(120).default('') }).strict().parse(req.body);
    await removeHost(req.user!, uidParam.parse(req.params.uid), b.reason);
    res.json({ ok: true });
  } catch (e) { next(e); }
});