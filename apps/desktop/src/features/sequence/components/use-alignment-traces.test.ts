import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { sha256Hex } from '../../../shared/sha256-sync';
import type { VerificationTrack } from '../../alignment-manager/types';
import { useAlignmentTraces } from './use-alignment-traces';

const { readFile, retainedEvidencePaths, notify } = vi.hoisted(() => ({
  readFile: vi.fn(),
  retainedEvidencePaths: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: { readFile } }) }));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: notify }) },
}));
vi.mock('../../alignment-manager/public/trace-source', () => ({
  retainedEvidencePaths,
  resolveAlignmentQueryPath: (path: string) => path,
}));

function fixture() {
  const entries: Array<[string, number, number, number[]]> = [
    ['PBAS', 2, 1, [65, 65, 67, 71]],
    ['PCON', 2, 1, [10, 20, 30, 40]],
    ['PLOC', 2, 2, [1, 3, 5, 7]],
    ...[9, 10, 11, 12].map((channel): [string, number, number, number[]] => [
      'DATA',
      channel,
      2,
      [0, 1, 0, 3, 0, 5, 0, 7, 0],
    ]),
  ];
  const data = Buffer.alloc(1024);
  data.write('ABIF');
  data.writeInt16BE(100, 4);
  data.writeInt32BE(entries.length, 18);
  data.writeInt32BE(64, 26);
  let position = 64 + 28 * entries.length;
  entries.forEach(([tag, index, size, values], i) => {
    const entry = 64 + 28 * i;
    data.write(tag, entry);
    data.writeInt32BE(index, entry + 4);
    data.writeInt16BE(size, entry + 10);
    data.writeInt32BE(values.length, entry + 12);
    data.writeInt32BE(size * values.length, entry + 16);
    const start = size * values.length <= 4 ? entry + 20 : position;
    if (start === position) {
      data.writeInt32BE(position, entry + 20);
      position += size * values.length;
    }
    values.forEach((value, j) => data.writeIntBE(value, start + size * j, size));
  });
  return Uint8Array.from(data.subarray(0, position));
}

it('hydrates the frozen AB1 by run and query ID on each open and rejects changed trace bytes', async () => {
  const bytes = fixture();
  readFile.mockResolvedValue(bytes);
  retainedEvidencePaths.mockResolvedValue({
    queryPaths: new Map([['read', '/package/frozen.ab1']]),
    queryHashes: new Map([['read', `sha256:${sha256Hex(bytes)}`]]),
  });
  const tracks: VerificationTrack[] = [
    {
      id: 'read',
      queryPath: '/moved/original.ab1',
      label: 'Read',
      alignedAt: 'now',
      status: 'pass',
      mutations: [],
      evidenceRunId: 'run',
      alignment: {
        alignedReference: 'C-TT',
        alignedQuery: 'CGTT',
        identity: 75,
        coverageStart: 0,
        coverageEnd: 3,
        algorithm: 'MAFFT',
      },
    },
  ];
  for (let open = 0; open < 2; open++) {
    const hook = renderHook(() => useAlignmentTraces('/reference.gb', 'CTT', tracks));
    await waitFor(() =>
      expect(hook.result.current.get('read')).toMatchObject({
        sequence: 'CGTT',
        quality: [40, 30, 20, 10],
        sourcePeakPositions: [7, 5, 3, 1],
        sourceBaseIndices: [3, 2, 1, 0],
        insertionPeaks: [{ peak: 1, boundary: 1, index: 0 }],
      })
    );
    hook.unmount();
  }
  expect(readFile.mock.calls).toEqual([['/package/frozen.ab1'], ['/package/frozen.ab1']]);
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  const hook = renderHook(() => useAlignmentTraces('/reference.gb', 'CTT', tracks));
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  expect(hook.result.current.size).toBe(0);
  hook.unmount();
});
