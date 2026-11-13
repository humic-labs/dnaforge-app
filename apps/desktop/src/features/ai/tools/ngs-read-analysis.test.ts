import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferToolOutput } from 'ai';

const mocked = vi.hoisted(() => ({
  getOperation: vi.fn(),
  canvas: vi.fn(),
  openTab: vi.fn(),
  retain: vi.fn(),
  importAnalysis: vi.fn(),
  describeCalls: vi.fn((_data: unknown, _sequence: unknown, calls: unknown[]) => calls),
  loadAnalysis: vi.fn(),
}));

vi.mock('../../../services/managed-operations', () => ({ managedOperations: mocked }));
vi.mock('./path-utils', () => ({
  loadSequenceDocumentBiologyFile: vi.fn().mockResolvedValue({ documentId: 'reference' }),
  getUserFolders: vi.fn(),
  resolveMultiRootPath: vi.fn(),
}));
vi.mock('./open-tab', () => ({ openTabInCanvas: mocked.openTab }));
vi.mock('../../canvas/public/store', () => ({ useCanvasStore: { getState: mocked.canvas, subscribe: vi.fn(() => () => {}) } }));
vi.mock('../../alignment-manager/public/ngs-read-analysis', () => ({
  retainNgsReadOperation: mocked.retain,
  importNgsReadAnalysis: mocked.importAnalysis,
}));
vi.mock('../../alignment-manager/public/variant-analysis', () => ({ describeVariantCalls: mocked.describeCalls, loadVariantAnalysis: mocked.loadAnalysis }));
vi.mock('../../sequence/public/store', () => ({ useSequenceStore: { getState: () => ({ getSequence: () => ({ sequence: 'ACGT' }) }) } }));

import { createGetNgsAnalysisTool } from './ngs-read-analysis';
import { createGetVariantAnalysisTool } from './sequence-variant-analysis';
import { execTool } from './test-helpers';

const operationId = '01c1390a-c996-7667-92f8-9df9e55342df';
const input = { documentId: 'reference', operationId, name: 'Raw reads' };

beforeEach(() => {
  vi.clearAllMocks();
  mocked.canvas.mockReturnValue({ panels: {} });
});

describe('NGS operation lookup diagnostics', () => {
  it('keeps large requested pages native while continuation recovers every saved call exactly once', async () => {
    const calls = Array.from({ length: 106 }, (_, index) => ({ id: `call-${index}`, position: index + 1 }));
    mocked.loadAnalysis.mockResolvedValue({ documentId: 'reference', calls, referenceSha256: 'reference' });
    const tool = createGetVariantAnalysisTool([]);
    const seen: Array<{ id: string; position: number }> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await execTool<InferToolOutput<typeof tool>>(tool, { analysisId: operationId, offset, limit: 500 });
      if (!result.ok || !('calls' in result)) throw new Error('Expected a native variant page');
      expect(result.ok).toBe(true);
      expect(result.calls.length).toBeLessThanOrEqual(25);
      expect(result).toMatchObject({ offset, totalCalls: 106, matchingCalls: 106 });
      seen.push(...result.calls);
      if (result.nextOffset !== null) expect(result.nextOffset).toBe(offset + result.calls.length);
      offset = result.nextOffset;
      expect(seen.length).toBeLessThanOrEqual(106);
    }
    expect(seen).toEqual(calls);
  });
  it('pages a completed read population without losing counts or the exact continuation', async () => {
    const calls = Array.from({ length: 106 }, (_, index) => ({ id: `call-${index}`, position: index + 1 }));
    mocked.getOperation.mockResolvedValue({ kind: 'ngs-read-analysis', state: 'succeeded' });
    mocked.openTab.mockResolvedValue({});
    mocked.importAnalysis.mockResolvedValue({ analysisId: operationId, data: { calls, readEvidence: {
      sourceSha256: 'source', referenceSha256: 'reference', totalReads: 7631, totalBases: 14428559,
      mappedReads: 2079, unmappedReads: 5552, mappingQualityReads: 2055, coverage: [1, 0],
      circularMethod: 'circular', versions: {}, countBasis: 'reads',
    } } });
    const tool = createGetNgsAnalysisTool([]);
    const result = await execTool<InferToolOutput<typeof tool>>(tool, input);
    if (!result.ok || !('calls' in result)) throw new Error('Expected completed read analysis');
    expect(result).toMatchObject({ ok: true, status: 'imported', callCount: 106, totalReads: 7631,
      mappedReads: 2079, unmappedReads: 5552, mappingQualityReads: 2055, uncoveredBases: 1,
      sourceSha256: 'source', referenceSha256: 'reference', nextOffset: 25,
      continuation: { tool: 'get_variant_analysis', arguments: { analysisId: operationId, offset: 25, limit: 25 } },
    });
    expect(result.calls).toEqual(calls.slice(0, 25));
    expect(calls).toHaveLength(106);
  });
  it('distinguishes an unknown opaque ID from failure of the actual analysis', async () => {
    mocked.getOperation.mockRejectedValue({
      status: 404,
      statusText: 'Not Found',
      detail: '[object Object]',
      body: { detail: { code: 'OPERATION_NOT_FOUND', message: 'Managed operation was not found' } },
    });

    expect(await execTool(createGetNgsAnalysisTool([]), input)).toMatchObject({
      ok: false,
      code: 'OPERATION_NOT_FOUND',
      error: expect.stringContaining('Managed operation was not found'),
      stateChanged: false,
      details: { operationId },
    });
    expect(mocked.getOperation).toHaveBeenCalledOnce();
    expect(mocked.getOperation).toHaveBeenCalledWith(operationId);
    expect(mocked.openTab).not.toHaveBeenCalled();
    expect(mocked.retain).not.toHaveBeenCalled();
    expect(mocked.importAnalysis).not.toHaveBeenCalled();
  });

  it('refuses a mistyped identity and offers only exact retained operations for this reference', async () => {
    mocked.getOperation.mockRejectedValue({
      status: 404,
      body: { detail: { code: 'OPERATION_NOT_FOUND', message: 'Managed operation was not found' } },
    });
    const retained = { operationId: '01a15683-e0e1-708b-b08d-e1305a62bb9f', name: 'Actual raw reads' };
    mocked.canvas.mockReturnValue({ panels: { main: { tabs: [
      { type: 'sequence', entityId: 'reference', viewState: { ngsReadOperation: retained } },
      { type: 'sequence', entityId: 'other-reference', viewState: { ngsReadOperation: { operationId: 'private-other-job', name: 'Other reference' } } },
      { type: 'sequence', entityId: 'reference', viewState: { ngsReadOperation: retained } },
    ] } } });
    const result = await execTool(createGetNgsAnalysisTool([]), input);
    expect(result).toMatchObject({
      ok: false, code: 'OPERATION_NOT_FOUND', stateChanged: false,
      details: { operationId, recoveryActions: [{ tool: 'get_ngs_analysis', arguments: { documentId: 'reference', ...retained } }] },
    });
    expect(JSON.stringify(result)).not.toContain('private-other-job');
    expect(mocked.getOperation).toHaveBeenCalledExactlyOnceWith(operationId);
    expect(mocked.openTab).not.toHaveBeenCalled();
    expect(mocked.retain).not.toHaveBeenCalled();
    expect(mocked.importAnalysis).not.toHaveBeenCalled();
  });

  it('preserves a typed access refusal without changing or importing the job', async () => {
    mocked.getOperation.mockRejectedValue({
      status: 403,
      statusText: 'Forbidden',
      detail: '[object Object]',
      body: { detail: { code: 'OPERATION_ACCESS_DENIED', message: 'Operation access was denied' } },
    });

    expect(await execTool(createGetNgsAnalysisTool([]), input)).toMatchObject({
      ok: false,
      code: 'OPERATION_ACCESS_DENIED',
      error: 'Operation access was denied',
      stateChanged: false,
    });
    expect(mocked.openTab).not.toHaveBeenCalled();
    expect(mocked.importAnalysis).not.toHaveBeenCalled();
  });
});
