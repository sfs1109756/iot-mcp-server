import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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

export function createApp(): Express {
  const app = express();
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
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof LLMUnavailableError) {
      res.status(503).json({ error: err.message, aiUnavailable: true });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  });
}

/** Trims and caps user text so prompts stay inside the model's context window. */
export function clip(text: unknown, max = 12_000): string {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}
