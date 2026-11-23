import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** An error with an HTTP status and a short `code` the app can understand (for example "insufficient-coins"). */
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ code: 'not-found', message: 'Not found.' });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) return void res.status(err.status).json({ code: err.code, message: err.message });
  if (err instanceof ZodError) return void res.status(400).json({ code: 'bad-request', message: 'The request is not valid.' });
  console.error('Unexpected error:', err); // the details stay in the server log, the app only gets a generic message
  res.status(500).json({ code: 'server-error', message: 'Something went wrong on the server.' });
};
