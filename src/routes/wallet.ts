import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { listTransactions } from '../services/walletService';

const router = Router();

const query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

// the person's own history (the balance itself is read live from the user document by the app)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const q = query.parse(req.query);
    res.json(await listTransactions(req.user!.uid, q.limit, q.cursor));
  } catch (e) {
    next(e);
  }
});

export default router;
