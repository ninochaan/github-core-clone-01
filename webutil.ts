// Small HTTP helpers shared by every surface: body reading and JSON replies
// in the forge's house style (every API reply carries a request id).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique, non-empty request id for the X-GitHub-Request-Id header. */
export function requestId(): string {
  requestCounter += 1;
  return `MAKEFUN:${requestCounter.toString(16).toUpperCase().padStart(4, '0')}:FORGE`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(payload);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

/** GitHub's canonical 404 body. */
export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** GitHub's bad-credentials body. */
export function badCredentials(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}
