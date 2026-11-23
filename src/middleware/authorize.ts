import type { RequestHandler } from 'express';
import { AppError } from './error-handler';

/** For admin routes (later): only these roles (the `role` custom claim) may continue. Use after `authenticate`. */
export const requireRole = (...roles: string[]): RequestHandler => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'forbidden', 'You are not allowed to do this.'));
  next();
};
