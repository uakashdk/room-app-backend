import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { requireRole } from '../middleware/authorize';
import { AppError } from '../middleware/error-handler';
import { removeVipAsset, setVipAsset, VIP_ASSET_KINDS } from '../services/vipAssets';

// PUT /admin/vip-levels/:id/assets/:kind   { data: "data:image/webp;base64,..." }   (super admin only)
// DELETE /admin/vip-levels/:id/assets/:kind
const router = Router();

const guard = [
  authenticate,
  requireRole('super_admin'),
  rateLimit({
    windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user?.uid ?? 'anonymous',
    handler: (_req, _res, next) => next(new AppError(429, 'rate-limited', 'Too many requests.')),
    validate: { keyGeneratorIpFallback: false },
  }),
];

const params = z.object({ id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/), kind: z.enum(VIP_ASSET_KINDS) });
const body = z
  .object({ data: z.string().max(560_000).regex(/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/, 'The picture must be a PNG, WebP or JPEG.') })
  .strict();

router.put('/:id/assets/:kind', ...guard, async (req, res, next) => {
  try {
    const p = params.parse(req.params);
    await setVipAsset(req.user!, p.id, p.kind, body.parse(req.body).data);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/assets/:kind', ...guard, async (req, res, next) => {
  try {
    const p = params.parse(req.params);
    await removeVipAsset(req.user!, p.id, p.kind);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
