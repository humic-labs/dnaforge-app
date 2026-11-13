import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';

export type GoogleSheetsCallback =
  | { kind: 'code'; code: string }
  | { kind: 'denied' | 'cancelled' | 'timeout' | 'error' };

const RETURN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>DNAForge</title><h1>Return to DNAForge</h1><p>You can close this tab. Google Sheets connection status is shown in the app.</p>';

export function startGoogleSheetsLoopback(input: { state: string; timeoutMs?: number }): Promise<{
  redirectUri: string;
  result: Promise<GoogleSheetsCallback>;
  cancel(): void;
}> {
  const state = z.string().min(32).max(256).parse(input.state);
  const timeoutMs = z
    .number()
    .positive()
    .max(300000)
    .parse(input.timeoutMs ?? 300000);
  return new Promise((resolveStarted, rejectStarted) => {
    let settled = false;
    const result: Promise<GoogleSheetsCallback> = new Promise((resolveCallback) => {
      const server = createServer((request, response) => {
        const address = server.address();
        const expectedHost =
          address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : null;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'");
        if (request.method !== 'GET') {
          response.writeHead(405).end();
          return;
        }
        if (
          !expectedHost ||
          request.headers.host !== expectedHost ||
          request.socket.remoteAddress !== '127.0.0.1'
        ) {
          response.writeHead(400).end();
          return;
        }
        let url: URL;
        try {
          url = new URL(request.url ?? '/', `http://${expectedHost}`);
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (url.origin !== `http://${expectedHost}`) {
          response.writeHead(400).end();
          return;
        }
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }
        if (
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.getAll('code').length > 1 ||
          url.searchParams.getAll('error').length > 1
        ) {
          response.writeHead(400).end();
          return;
        }
        const receivedState = Buffer.from(url.searchParams.get('state') ?? '');
        const expectedState = Buffer.from(state);
        if (
          receivedState.length !== expectedState.length ||
          !timingSafeEqual(receivedState, expectedState)
        ) {
          response.writeHead(400).end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if ((!code && !error) || (code && error) || (code && code.length > 8192)) {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RETURN_PAGE);
        finish(
          code ? { kind: 'code', code } : { kind: error === 'access_denied' ? 'denied' : 'error' }
        );
      });
      const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
      timer.unref();
      function finish(value: GoogleSheetsCallback) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        if (value.kind === 'cancelled' || value.kind === 'timeout') server.closeAllConnections();
        resolveCallback(value);
      }
      server.once('error', () => {
        finish({ kind: 'error' });
        rejectStarted(new Error('Google connection could not open its local callback.'));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish({ kind: 'error' });
          rejectStarted(new Error('Google connection has no local callback address.'));
          return;
        }
        resolveStarted({
          redirectUri: `http://127.0.0.1:${address.port}/callback`,
          result,
          cancel: () => finish({ kind: 'cancelled' }),
        });
      });
    });
  });
}
