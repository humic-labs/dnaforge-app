import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContactSourceReadRequest,
  ContactSourceReadResult,
} from '../../shared/contact-source';

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

import { registerContactSourceIpcHandlers } from './contact-sources';

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
  const temporary = await mkdtemp(join(tmpdir(), 'dnaforge-contact-ipc-'));
  folders.push(temporary);
  const root = await realpath(temporary);
  const reference = { id: 'source-reference', chrom: 'chr1', length: 100 };
  const content = JSON.stringify({
    schema: 'dnaforge.contact-matrix.v1',
    id: 'contact-source',
    label: 'Source measurements',
    unit: 'counts',
    xReference: reference,
    yReference: reference,
    cells: [{ id: 'cell-a', start: 0, end: 10, targetStart: 20, targetEnd: 30, value: 4 }],
    colorScale: {
      kind: 'continuous',
      domain: [0, 10],
      colors: ['#000000', '#ffffff'],
      missingColor: '#cccccc',
      transform: 'linear',
    },
  });
  await writeFile(join(root, 'contact.json'), content);
  mocks.rows = [{ name: 'Measured project', path: root }];
  mocks.roots = [root];
  registerContactSourceIpcHandlers();
  const [contract, handlers] = mocks.handleGroup.mock.calls[0] as [
    { name: string },
    {
      read(event: unknown, request: ContactSourceReadRequest): Promise<ContactSourceReadResult>;
    },
  ];
  const request: ContactSourceReadRequest = {
    project: 'Measured project',
    source: {
      schema: 'dnaforge.contact-source.v1',
      path: 'contact.json',
      sha256: createHash('sha256').update(content).digest('hex'),
      xReference: reference,
      yReference: reference,
    },
  };
  return { root, request, handlers, contract };
}

describe('contact source IPC project admission', () => {
  it('resolves a unique admitted project and reads its actual bounded source bytes', async () => {
    const state = await fixture();
    expect(state.contract.name).toBe('contactSources');
    const result = await state.handlers.read(undefined, state.request);
    expect(result.revision).toBe(state.request.source.sha256);
    expect(result.path).toBe(join(state.root, 'contact.json'));
    expect(result.projection.cells).toHaveLength(1);
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
    mocks.rows.push({ name: 'Measured project', path: '/another-admitted-project' });
    mocks.roots.push('/another-admitted-project');
    await expect(state.handlers.read(undefined, state.request)).rejects.toThrow('admitted project');
    await expect(
      state.handlers.read(undefined, { ...state.request, project: state.root })
    ).resolves.toMatchObject({ revision: state.request.source.sha256 });
  });
});
