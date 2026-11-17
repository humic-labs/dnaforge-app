// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { NativeTableDocumentCommands } from './table-document-commands';

vi.mock('electron', () => ({
  app: { getPath: (name: 'home' | 'userData') => identityTestPaths[name] },
}));
const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function fixture() {
  const f = await tableCommandFixture();
  fixtures.push(f);
  const destination = {
    workspaceRoot: f.workspaceRoot,
    packageRoot: join(f.workspaceRoot, 'Table'),
  };
  const made = await f.commands.execute({
    kind: 'create',
    requestId: randomUUID(),
    destination,
    title: 'Table',
    rows: 2,
    columns: 2,
  });
  if (made.kind !== 'created') throw new Error('Expected a saved table');
  return { ...f, destination, made };
}

it('resolves a table without repeatedly listing projects at each physical authority boundary', async () => {
  const f = await fixture();
  const workspaceRoots = vi.fn(f.options.workspaceRoots);
  const writableWorkspaceRoots = vi.fn(f.options.writableWorkspaceRoots);
  const workspaceAccess = vi.fn((root: string) =>
    root === f.workspaceRoot ? { readOnly: false } : null
  );
  const commands = new NativeTableDocumentCommands({
    ...f.options,
    workspaceRoots,
    writableWorkspaceRoots,
    ...{ workspaceAccess },
  });
  const result = await commands.execute({ kind: 'resolve', reference: f.made.table.reference });
  expect(result.kind).toBe('resolved');
  expect(workspaceRoots.mock.calls.length).toBeLessThanOrEqual(1);
  expect(writableWorkspaceRoots).not.toHaveBeenCalled();
  expect(workspaceAccess).toHaveBeenCalledWith(f.workspaceRoot);
});

it('refuses opening a table when exact scoped authority excludes its otherwise registered project', async () => {
  const f = await fixture();
  const commands = new NativeTableDocumentCommands({
    ...f.options,
    ...{ workspaceAccess: () => null },
  });
  await expect(commands.execute({ kind: 'open', location: f.destination })).rejects.toThrow();
});

it('refuses table creation when exact scoped authority is reference-only', async () => {
  const f = await fixture();
  const commands = new NativeTableDocumentCommands({
    ...f.options,
    ...{ workspaceAccess: () => ({ readOnly: true }) },
  });
  await expect(
    commands.execute({
      kind: 'create',
      requestId: randomUUID(),
      destination: {
        workspaceRoot: f.workspaceRoot,
        packageRoot: join(f.workspaceRoot, 'Forbidden'),
      },
      title: 'Forbidden',
      rows: 2,
      columns: 2,
    })
  ).rejects.toThrow();
});
