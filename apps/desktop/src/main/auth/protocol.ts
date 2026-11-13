import { app } from 'electron';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, unlink, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { getRedirectScheme, type RedirectScheme } from './auth-config';
import { isCommunityBuild } from '../distribution';

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

export interface PendingFlow {
  flowNonce: string;
  verifier: string;
  challenge: string;
  pollSecret: string;
  pollSecretHash: string;
  channel: string;
  createdAt: number;
}

const pendingByNonce = new Map<string, PendingFlow>();

export function createPendingFlow(channel: string): PendingFlow {
  const verifier = b64url(randomBytes(32));
  const pollSecret = b64url(randomBytes(32));
  const flowNonce = b64url(randomBytes(16));
  const flow: PendingFlow = {
    flowNonce,
    verifier,
    challenge: sha256Base64Url(verifier),
    pollSecret,
    pollSecretHash: sha256Base64Url(pollSecret),
    channel,
    createdAt: Date.now(),
  };
  pendingByNonce.set(flowNonce, flow);
  return flow;
}

export function getPendingFlow(nonce: string): PendingFlow | undefined {
  return pendingByNonce.get(nonce);
}
export function clearPendingFlow(nonce: string): void {
  pendingByNonce.delete(nonce);
}
export function clearAllPendingFlows(): void {
  pendingByNonce.clear();
}
export function pendingFlowNonces(): string[] {
  return [...pendingByNonce.keys()];
}

function markerDir(): string {
  return join(app.getPath('userData'), 'auth', 'markers');
}
function markerFileName(nonce: string): string {
  return `${createHash('sha256').update(nonce).digest('hex')}.json`;
}

export async function writeMarker(flow: PendingFlow): Promise<void> {
  await mkdir(markerDir(), { recursive: true });
  await writeFile(
    join(markerDir(), markerFileName(flow.flowNonce)),
    JSON.stringify({
      flow_nonce: flow.flowNonce,
      created_at: flow.createdAt,
      channel: flow.channel,
    }),
    'utf8'
  );
}

export async function deleteMarker(nonce: string): Promise<void> {
  try {
    await unlink(join(markerDir(), markerFileName(nonce)));
  } catch {}
}

export async function gcMarkers(maxAgeMs = 15 * 60 * 1000): Promise<void> {
  try {
    const dir = markerDir();
    const files = await readdir(dir);
    await Promise.all(
      files.map(async (f) => {
        const full = join(dir, f);
        try {
          const m = JSON.parse(await readFile(full, 'utf8')) as { created_at?: number };
          if (!m.created_at || Date.now() - m.created_at > maxAgeMs) await unlink(full);
        } catch {
          await unlink(full).catch(() => {});
        }
      })
    );
  } catch {}
}

const ALLOWED_SCHEMES = ['dnaforge', 'dnaforge-beta', 'dnaforge-dev'];

export interface ParsedCallback {
  flowNonce: string;
  code: string;
}

export function parseCallbackUrl(url: string): ParsedCallback | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) return null;
  if (u.hostname.toLowerCase() !== 'auth-callback') return null;
  const code = u.searchParams.get('code');
  const flowNonce = u.searchParams.get('flow_nonce');
  if (!code || !flowNonce) return null;
  return { flowNonce, code };
}

export function findCallbackUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (/^dnaforge(-beta|-dev)?:\/\//i.test(arg)) return arg;
  }
  return null;
}

export function registerProtocolScheme(): RedirectScheme {
  const scheme = getRedirectScheme();
  if (isCommunityBuild()) return scheme;
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1] ?? '']);
  } else {
    app.setAsDefaultProtocolClient(scheme);
  }
  return scheme;
}
