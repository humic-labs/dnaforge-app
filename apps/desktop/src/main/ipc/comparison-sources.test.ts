import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ComparisonSourceReadRequest,
  ComparisonSourceReadResult,
} from '../../shared/comparison-source';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ name: string; path: string }>,
  roots: [] as string[],
  handleGroup: vi.fn(),
  captureReadable: vi.fn(),
  assertCurrent: vi.fn(),
}));
vi.mock('../../shared/ipc-contract', () => ({ handleGroup: mocks.handleGroup }));
vi.mock('../features/native-documents', () => ({
  nativeDocuments: {
    workspaces: {
      readableRoots: () => mocks.roots,
      captureReadable: mocks.captureReadable,
    },
  },
}));
vi.mock('./database', () => ({ getDb: () => ({ prepare: () => ({ all: () => mocks.rows }) }) }));
vi.mock('./path-allowlist', () => ({ resolveCanonicalPath: (path: string) => realpath(path) }));

import { registerComparisonSourceIpcHandlers } from './comparison-sources';

const publicFixture = fileURLToPath(
  new URL(
    '../../../../../test-fixtures/genome-view-prototypes/MG1655-Shigella2457T-gapped.paf',
    import.meta.url
  )
);
const folders: string[] = [];
beforeEach(() => {
  mocks.rows = [];
  mocks.roots = [];
  mocks.handleGroup.mockReset();
  mocks.assertCurrent.mockReset();
  mocks.captureReadable.mockReset().mockReturnValue(mocks.assertCurrent);
});
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'dnaforge-comparison-ipc-'));
  folders.push(temporary);
  const root = await realpath(temporary);
  await copyFile(publicFixture, join(root, 'alignment.paf'));
  mocks.rows = [{ name: 'Comparison project', path: root }];
  mocks.roots = [root];
  registerComparisonSourceIpcHandlers();
  const [contract, handlers] = mocks.handleGroup.mock.calls[0] as [
    { name: string },
    {
      read(
        event: unknown,
        request: ComparisonSourceReadRequest
      ): Promise<ComparisonSourceReadResult>;
    },
  ];
  const request: ComparisonSourceReadRequest = {
    project: 'Comparison project',
    source: {
      schema: 'dnaforge.comparison-source.v1',
      path: 'alignment.paf',
      sha256: '87a00a4f29828486d242fdc9abc89ffb2309b08654f99b8c75e042500aabc211',
      targetReference: { id: 'NC_000913.3', chrom: 'NC_000913.3', length: 4_641_652 },
      queryReference: { id: 'NC_004741.1', chrom: 'NC_004741.1', length: 4_599_354 },
    },
  };
  return { root, request, handlers, contract };
}

describe('comparison source IPC project admission', () => {
  it('resolves a unique admitted project and returns all actual gapped source blocks', async () => {
    const state = await fixture();
    expect(state.contract.name).toBe('comparisonSources');
    const result = await state.handlers.read(undefined, state.request);
    expect(result.revision).toBe(state.request.source.sha256);
    expect(result.projectionId).toBe(`comparison:${state.request.source.sha256}`);
    expect(result.path).toBe(join(state.root, 'alignment.paf'));
    expect(result.comparison.blocks).toHaveLength(261);
    expect(mocks.captureReadable).toHaveBeenCalledWith(state.root);
    expect(mocks.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('refuses a stored project that is no longer admitted', async () => {
    const state = await fixture();
    mocks.roots = [];
    await expect(state.handlers.read(undefined, state.request)).rejects.toThrow('admitted project');
    expect(mocks.captureReadable).not.toHaveBeenCalled();
  });

  it('requires an exact path when admitted project names are ambiguous', async () => {
    const state = await fixture();
    mocks.rows.push({ name: 'Comparison project', path: '/another-admitted-project' });
    mocks.roots.push('/another-admitted-project');
    await expect(state.handlers.read(undefined, state.request)).rejects.toThrow('admitted project');
    await expect(
      state.handlers.read(undefined, { ...state.request, project: state.root })
    ).resolves.toMatchObject({ revision: state.request.source.sha256 });
  });
});
