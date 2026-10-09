import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLMUnavailableError, checkHealth } from './llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Wraps async route handlers so thrown errors reach the error middleware. */
export const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Conservative security headers (the app only loads its own scripts and styles). */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
};

/**
 * Small in-memory rate limiter (per IP, fixed window). Protects AI routes from accidental
 * loops — a local model can only serve a request or two at a time anyway.
 */
export function rateLimit({ windowMs = 60_000, max = Number(process.env.AI_RATE_LIMIT ?? 30) } = {}): RequestHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req, res, next) => {
    const key = req.ip ?? 'local';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('retry-after', String(Math.ceil((entry.reset - now) / 1000)));
      res.status(429).json({ error: 'Too many AI requests. Please wait a moment and try again.' });
      return;
    }
    next();
  };
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));
  app.get(
    '/api/health',
    asyncRoute(async (_req, res) => {
      res.json(await checkHealth());
    }),
  );
  return app;
}

/** Serves the built React app (client/dist) in production, plus JSON error handling. */
export function finishApp(app: Express): void {
  const dist = path.resolve(here, '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', setHeaders: (res, file) => file.endsWith('index.html') && res.setHeader('cache-control', 'no-cache') }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { type?: string; code?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof LLMUnavailableError) {
      res.status(503).json({ error: err.message, aiUnavailable: true });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // Body parser and upload errors are the client's fault, not a server crash.
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'That upload is too large.' });
      return;
    }
    if (err.name === 'MulterError') {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
}

/** Trims and caps user text so prompts stay inside the model's context window. */
export function clip(text: unknown, max = 12_000): string {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
