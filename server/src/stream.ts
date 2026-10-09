import type { Request, Response } from 'express';

/**
 * Streams model output to the browser as NDJSON:
 *   {"type":"token","text":"..."}   (many)
 *   {"type":"done","text":"<full>", ...extra}
 *   {"type":"error","message":"..."}  (only if it fails mid-stream)
 *
 * Nothing is written until the first token arrives, so if the model is unavailable the
 * route still fails with a normal HTTP error (e.g. 503) that the UI can show.
 * Closing the browser tab aborts the model request.
 */
export async function streamText(
  _req: Request,
  res: Response,
  run: (emit: (text: string) => void, signal: AbortSignal) => Promise<string>,
  extra?: (text: string) => Record<string, unknown>,
): Promise<void> {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
  };
  const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);

  try {
    const text = await run((t) => {
      start();
      send({ type: 'token', text: t });
    }, controller.signal);
    start();
    send({ type: 'done', text, ...(extra?.(text) ?? {}) });
    res.end();
  } catch (err) {
    if (!started) throw err;
    if (!controller.signal.aborted) {
      send({ type: 'error', message: (err as Error).message });
      res.end();
    }
  }
}
