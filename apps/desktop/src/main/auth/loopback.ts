import { createServer, type Server } from 'node:http';

export interface LoopbackResult {
  code?: string;
  error?: string;
  flowNonce: string;
}

export interface LoopbackListener {
  redirectUri: string;
  waitForCallback: Promise<LoopbackResult>;
  close: () => void;
}

const PAGE = (heading: string, color: string, body: string): string =>
  '<!doctype html><meta charset="utf-8"><title>DNAForge</title>' +
  '<body style="font-family:system-ui;background:#0b0b0c;color:#e7e7ea;text-align:center;padding:4rem">' +
  `<h2 style="color:${color}">${heading}</h2><p>${body}</p></body>`;

const DONE_HTML = PAGE(
  'Signed in &#10003;',
  '#4ade80',
  'You can close this tab and return to DNAForge.'
);
const FAIL_HTML = PAGE(
  "Sign-in didn't complete",
  '#f87171',
  'You can close this tab — return to DNAForge to try again.'
);

export async function startLoopback(expectedFlowNonce: string): Promise<LoopbackListener> {
  let resolveCb!: (r: LoopbackResult) => void;
  const waitForCallback = new Promise<LoopbackResult>((resolve) => {
    resolveCb = resolve;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const flowNonce = url.searchParams.get('flow_nonce');
    const matches = flowNonce === expectedFlowNonce;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(matches && code ? DONE_HTML : FAIL_HTML);
    if (matches && code) resolveCb({ code, flowNonce });
    else if (matches && error) resolveCb({ error, flowNonce });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  let closed = false;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCallback,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        server.close();
      } catch {}
    },
  };
}
