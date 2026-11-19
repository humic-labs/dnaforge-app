import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { StructurePreview } from './StructurePreview';
import { ChromatogramPreview } from './ChromatogramPreview';

const controls = { action: <button>Import to Project…</button>, destination: null };

const { readFileBounded, bindStructure, showViewport } = vi.hoisted(() => ({
  readFileBounded: vi.fn(),
  bindStructure: vi.fn(),
  showViewport: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ fs: { readFileBounded } }) }));
vi.mock('../page/public/embeds/structure3d/LazyMolstarViewer', () => ({
  LazyMolstarViewer: (props: unknown) => {
    bindStructure(props);
    return null;
  },
}));
vi.mock('@waypoint/workspace-editor', async (load) => ({
  ...(await load<typeof import('@waypoint/workspace-editor')>()),
  SequenceViewer1D: (props: {
    onViewportChange: () => void;
    onViewCursorChange: (i: number) => void;
  }) => {
    showViewport.mockImplementation(props.onViewportChange);
    return <button onClick={() => props.onViewCursorChange(1)}>Select second base</button>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

async function parseCoordinates(data: string | Uint8Array, format: 'pdb' | 'mmcif') {
  if (format === 'pdb') {
    if (typeof data !== 'string') throw new Error('PDB text expected');
    const pdb = await parsePDB(data, '1FS0').run();
    if (pdb.isError) throw new Error(pdb.message);
    return trajectoryFromPDB(pdb.result).run();
  }
  const cif = await CIF.parse(data).run();
  if (cif.isError) throw new Error(cif.message);
  return trajectoryFromMmCIF(cif.result.blocks[0]).run();
}

it.each(['pdb', 'cif', 'bcif'])(
  'uses the %s coordinate snapshot that actually reached the viewer',
  async (extension) => {
    const path = `/selected/model.${extension}`;
    const bytes = new Uint8Array(
      await readFile(
        resolve(
          __dirname,
          `../../../../../test-fixtures/structure-complexes/rcsb/1FS0.${extension}`
        )
      )
    );
    readFileBounded.mockResolvedValue(bytes);
    const snapshot = vi.fn();
    const { rerender } = render(
      <StructurePreview path={path} onSnapshot={snapshot} controls={controls} />
    );
    await waitFor(() => expect(bindStructure).toHaveBeenCalled());
    expect(snapshot).toHaveBeenLastCalledWith(null);
    expect(readFileBounded).toHaveBeenCalledWith(path, 100 * 1024 * 1024);
    const props = bindStructure.mock.lastCall![0];
    expect(props.structureData).toEqual(
      extension === 'bcif' ? bytes : new TextDecoder().decode(bytes)
    );
    expect(props.structureDataFormat).toBe(extension === 'pdb' ? 'pdb' : 'mmcif');
    const trajectory = await parseCoordinates(props.structureData, props.structureDataFormat);
    const structure = { cell: { obj: { data: Structure.ofModel(trajectory.representative) } } };
    act(() => {
      props.onPluginReady({
        managers: { structure: { hierarchy: { current: { structures: [structure] } } } },
      });
      props.onLoad();
    });
    const row = within(screen.getByRole('group', { name: 'Read-only preview · Not imported' }));
    expect(row.getByRole('button', { name: 'Import to Project…' })).toBeVisible();
    expect(row.getByTestId('external-structure-chains')).toHaveTextContent(
      '2,945 coordinate sites · Model chains E, G'
    );
    expect(snapshot).toHaveBeenLastCalledWith(createHash('sha256').update(bytes).digest('hex'));
    readFileBounded.mockResolvedValue(new Uint8Array());
    rerender(<StructurePreview path="/selected/empty.pdb" onSnapshot={snapshot} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('coordinate file is empty');
    expect(snapshot).toHaveBeenLastCalledWith(null);
  }
);

function sangerRead() {
  const tags = [
    { tag: 'FWO_', id: 1, size: 1, values: [...Buffer.from('GATC')] },
    { tag: 'PBAS', id: 2, size: 1, values: [...Buffer.from('AC')] },
    { tag: 'PCON', id: 2, size: 1, values: [27, 39] },
    { tag: 'PLOC', id: 2, size: 2, values: [1, 4] },
    ...[9, 10, 11, 12].map((id) => ({
      tag: 'DATA',
      id,
      size: 2,
      values: Array.from({ length: 33_000 }, (_, i) => i % 17),
    })),
  ];
  const offset = 34;
  let dataOffset = offset + tags.length * 28;
  const bytes = Buffer.alloc(dataOffset + 4 * 33_000 * 2);
  bytes.write('ABIF');
  bytes.writeUInt16BE(101, 4);
  bytes.writeInt32BE(tags.length, 18);
  bytes.writeInt32BE(offset, 26);
  tags.forEach(({ tag, id, size, values }, index) => {
    const entry = offset + index * 28;
    bytes.write(tag, entry);
    bytes.writeInt32BE(id, entry + 4);
    bytes.writeInt16BE(size, entry + 10);
    bytes.writeInt32BE(values.length, entry + 12);
    bytes.writeInt32BE(values.length * size, entry + 16);
    let payload = entry + 20;
    if (values.length * size > 4) {
      payload = dataOffset;
      bytes.writeInt32BE(payload, entry + 20);
      dataOffset += values.length * size;
    }
    for (let i = 0; i < values.length; i++) bytes.writeUIntBE(values[i], payload + i * size, size);
  });
  return new Uint8Array(bytes);
}

it('opens ABI base calls, trace samples and changing per-base quality without a project', async () => {
  const bytes = sangerRead();
  readFileBounded.mockResolvedValue(bytes);
  const snapshot = vi.fn();
  const { unmount } = render(
    <ChromatogramPreview path="/selected/read.abi" onSnapshot={snapshot} controls={controls} />
  );
  expect(await screen.findByTestId('external-chromatogram-call')).toHaveTextContent(
    'Base 1 · A · Phred 27'
  );
  const row = within(screen.getByRole('group', { name: 'Read-only preview · Not imported' }));
  expect(row.getByRole('button', { name: 'Import to Project…' })).toBeVisible();
  expect(row.getByText('2 base calls · 33,000 samples per channel')).toBeVisible();
  expect(snapshot).toHaveBeenLastCalledWith(null);
  act(() => showViewport());
  expect(snapshot).toHaveBeenLastCalledWith(createHash('sha256').update(bytes).digest('hex'));
  fireEvent.click(screen.getByText('Select second base'));
  expect(screen.getByTestId('external-chromatogram-call')).toHaveTextContent(
    'Base 2 · C · Phred 39'
  );
  unmount();
  expect(snapshot).toHaveBeenLastCalledWith(null);
});

it('reports an invalid chromatogram and never publishes its digest', async () => {
  readFileBounded.mockResolvedValue(new Uint8Array([1, 2, 3]));
  const snapshot = vi.fn();
  render(<ChromatogramPreview path="/selected/unreadable.ab1" onSnapshot={snapshot} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('AB1 file too small');
  expect(snapshot.mock.calls.flat()).toEqual([null]);
});
