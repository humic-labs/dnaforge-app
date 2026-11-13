import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OfficeResourcesDownloadGate } from './office-resources-download-gate';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'office-resources-gate-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OfficeResourcesDownloadGate', () => {
  it('does nothing when this machine has no office-resources policy', async () => {
    const root = await temporaryRoot();
    const gate = new OfficeResourcesDownloadGate({
      policyPath: join(root, 'missing-policy.json'),
      command: join(root, 'missing-command'),
    });

    await expect(gate.reserve(65_536, new AbortController().signal)).resolves.toBeUndefined();
    gate.dispose();
  });

  it('fails closed before a transfer when policy exists but the shared helper is unavailable', async () => {
    const root = await temporaryRoot();
    const policyPath = join(root, 'office-resources.json');
    await writeFile(policyPath, '{}\n');
    const gate = new OfficeResourcesDownloadGate({
      policyPath,
      command: join(root, 'missing-command'),
    });

    await expect(gate.reserve(65_536, new AbortController().signal)).rejects.toThrow(
      'shared office download limiter'
    );
    gate.dispose();
  });

  it('serializes reservations through one long-lived helper protocol', async () => {
    const root = await temporaryRoot();
    const policyPath = join(root, 'office-resources.json');
    const requestsPath = join(root, 'requests.jsonl');
    const helperPath = join(root, 'gate-helper.mjs');
    await writeFile(policyPath, '{}\n');
    await writeFile(
      helperPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        'const target = process.argv[2];',
        'const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'for await (const line of lines) {',
        '  const request = JSON.parse(line);',
        '  appendFileSync(target, `${JSON.stringify(request)}\\n`);',
        '  process.stdout.write(`${JSON.stringify({ ok: true, bytes: request.bytes })}\\n`);',
        '}',
      ].join('\n')
    );
    const gate = new OfficeResourcesDownloadGate({
      policyPath,
      command: process.execPath,
      commandArgs: [helperPath, requestsPath],
    });

    await Promise.all([
      gate.reserve(65_536, new AbortController().signal),
      gate.reserve(32_768, new AbortController().signal),
    ]);
    await unlink(policyPath);
    await gate.reserve(16_384, new AbortController().signal);
    gate.dispose();

    const requests = (await readFile(requestsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests).toEqual([{ bytes: 65_536 }, { bytes: 32_768 }, { bytes: 16_384 }]);
  });
});
