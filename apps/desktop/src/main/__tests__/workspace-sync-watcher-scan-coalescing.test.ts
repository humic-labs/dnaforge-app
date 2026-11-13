import { afterEach, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
  gates: [] as Array<{
    root: string;
    resolve: (entries: unknown[]) => void;
    reject: (error: Error) => void;
    settled: boolean;
  }>,
  version: new Map<string, number>(),
}));

vi.mock('node:fs', () => ({
  realpathSync: (root: string) => {
    const canonical = model.aliases.get(root);
    if (!canonical) throw new Error('root unavailable');
    return canonical;
  },
  watch: () => {
    throw new Error('Native watch forbidden in scan controls');
  },
}));
vi.mock('node:fs/promises', () => ({
  readdir: (root: string) =>
    new Promise<unknown[]>((resolve, reject) =>
      model.gates.push({ root, resolve, reject, settled: false })
    ),
  stat: async (file: string) => ({
    size: 8,
    mtimeMs: model.version.get(file.slice(0, file.lastIndexOf('/'))) ?? 1,
  }),
}));

import { computeWorkspaceTreeFingerprint } from '../workspace-sync-watcher';

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
async function release(index: number, version = 1): Promise<void> {
  const gate = model.gates[index];
  gate.settled = true;
  model.version.set(gate.root, version);
  gate.resolve([
    {
      name: 'notes.txt',
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    },
  ]);
  await flush();
}
afterEach(async () => {
  for (let attempt = 0; attempt < 20 && model.gates.some((gate) => !gate.settled); attempt++)
    for (let index = 0; index < model.gates.length; index++)
      if (!model.gates[index].settled) await release(index);
  model.gates.length = 0;
  model.aliases.clear();
  model.version.clear();
});

it('aliases share one physical walk and one coalesced fresh follow-up', async () => {
  model.aliases.set('/A', '/canonical/A');
  model.aliases.set('/alias/A', '/canonical/A');
  const first = computeWorkspaceTreeFingerprint('/A');
  const follow = computeWorkspaceTreeFingerprint('/alias/A');
  const joined = computeWorkspaceTreeFingerprint('/A');
  expect(follow).toBe(joined);
  expect(model.gates.map((gate) => gate.root)).toEqual(['/canonical/A']);
  await release(0, 1);
  const original = await first;
  expect(model.gates).toHaveLength(2);
  await release(1, 2);
  const next = await follow;
  expect(next).not.toBe(original);
  expect(await joined).toBe(next);
  const later = computeWorkspaceTreeFingerprint('/alias/A');
  expect(model.gates).toHaveLength(3);
  await release(2, 3);
  expect(await later).not.toBe(next);
});

it('failure settles its callers and permits the independently requested follow-up', async () => {
  model.aliases.set('/A', '/canonical/A');
  const first = computeWorkspaceTreeFingerprint('/A');
  const failure = expect(first).rejects.toThrow('read refused');
  const follow = computeWorkspaceTreeFingerprint('/A');
  model.gates[0].settled = true;
  model.gates[0].reject(new Error('read refused'));
  await failure;
  await flush();
  expect(model.gates).toHaveLength(2);
  await release(1);
  expect(await follow).toMatch(/^[a-f0-9]{64}$/);
});

it('independent roots and a retargeted alias do not share physical work', async () => {
  model.aliases.set('/alias', '/canonical/A');
  const first = computeWorkspaceTreeFingerprint('/alias');
  model.aliases.set('/alias', '/canonical/B');
  const second = computeWorkspaceTreeFingerprint('/alias');
  expect(model.gates.map((gate) => gate.root)).toEqual(['/canonical/A', '/canonical/B']);
  await release(1);
  expect(await second).toMatch(/^[a-f0-9]{64}$/);
  expect(model.gates[0].settled).toBe(false);
  await release(0);
  await first;
});

it('canonical admission failure starts no physical work and a later deliberate call recovers', async () => {
  await expect(computeWorkspaceTreeFingerprint('/missing')).rejects.toThrow('root unavailable');
  expect(model.gates).toHaveLength(0);
  model.aliases.set('/missing', '/canonical/A');
  const recovered = computeWorkspaceTreeFingerprint('/missing');
  expect(model.gates).toHaveLength(1);
  await release(0);
  expect(await recovered).toMatch(/^[a-f0-9]{64}$/);
});
