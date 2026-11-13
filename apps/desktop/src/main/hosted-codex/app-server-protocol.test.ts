import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCodexAppServerBinary } from './app-server-binary';
import { manifest } from '@waypoint/codex-app-server-contract';

import {
  ANSWERABLE_SERVER_REQUESTS,
  EXPECTED_SERVER_NOTIFICATIONS,
  REFUSED_SERVER_REQUESTS,
} from './app-server-protocol';

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';

function declaredMethods(schema: unknown): string[] {
  const root = schema as { oneOf?: unknown[] };
  const names: string[] = [];
  for (const entry of root.oneOf ?? []) {
    const method = (entry as { properties?: { method?: { enum?: unknown; const?: unknown } } })
      .properties?.method;
    if (Array.isArray(method?.enum)) names.push(...(method.enum as string[]));
    else if (typeof method?.const === 'string') names.push(method.const);
  }
  return names;
}

describe.skipIf(!IS_DARWIN_ARM64)('App Server protocol contract', () => {
  let out: string;
  let notifications: string[];
  let requests: string[];

  beforeAll(() => {
    const binary = resolveCodexAppServerBinary();
    out = mkdtempSync(path.join(os.tmpdir(), 'codex-protocol-'));
    execFileSync(binary.path, ['app-server', 'generate-json-schema', '--out', out], {
      encoding: 'utf8',
    });
    notifications = declaredMethods(
      JSON.parse(readFileSync(path.join(out, 'ServerNotification.json'), 'utf8'))
    );
    requests = declaredMethods(
      JSON.parse(readFileSync(path.join(out, 'ServerRequest.json'), 'utf8'))
    );
  });

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('reads a protocol that actually declares something', () => {
    expect(notifications.length).toBeGreaterThan(20);
    expect(requests.length).toBeGreaterThan(5);
  });

  it('expects only notifications the pinned binary declares', () => {
    const undeclared = EXPECTED_SERVER_NOTIFICATIONS.filter(
      (name) => !notifications.includes(name)
    );
    expect(undeclared).toEqual([]);
  });

  it('answers only requests the pinned binary declares', () => {
    const undeclared = ANSWERABLE_SERVER_REQUESTS.filter((name) => !requests.includes(name));
    expect(undeclared).toEqual([]);
  });

  it('refuses only requests the pinned artifact declares somewhere', () => {
    const declared = new Set([...requests, ...manifest.upstreamProtocolMethods.server]);
    const undeclared = Object.keys(REFUSED_SERVER_REQUESTS).filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
  });

  it('decides about every request either source declares', () => {
    const declared = [...new Set([...requests, ...manifest.upstreamProtocolMethods.server])];
    const undecided = declared.filter(
      (name) => !ANSWERABLE_SERVER_REQUESTS.includes(name) && !(name in REFUSED_SERVER_REQUESTS)
    );
    expect(undecided).toEqual([]);
  });

  it('has a decision for every request the server can make', () => {
    const undecided = requests.filter(
      (name) => !ANSWERABLE_SERVER_REQUESTS.includes(name) && !(name in REFUSED_SERVER_REQUESTS)
    );
    expect(undecided).toEqual([]);
  });

  it('can still reach a tool call, which is the request everything depends on', () => {
    expect(requests).toContain('item/tool/call');
    expect(ANSWERABLE_SERVER_REQUESTS).toContain('item/tool/call');
  });

  it('does not expect the invented envelope the earlier build assumed', () => {
    for (const invented of ['thread/event', 'turn/event', 'log']) {
      expect(notifications).not.toContain(invented);
      expect(EXPECTED_SERVER_NOTIFICATIONS).not.toContain(invented);
    }
  });
});
