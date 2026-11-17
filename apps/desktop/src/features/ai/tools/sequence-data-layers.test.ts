import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSequenceDataLayersTool, sequenceDataLayersToolSchema } from './sequence-data-layers';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../platform', () => ({ platform: () => ({ sequenceDataLayers: { run } }) }));

const project = { name: 'Existing sequences', path: '/projects/existing', addedAt: 1 };
const options = { toolCallId: 'layer-call', messages: [] };
const sequenceFingerprint = `sha256:${'a'.repeat(64)}`;
const request = {
  operation: 'create' as const,
  project: project.path,
  requestId: 'dataset-on-old-sequence',
  targetDocumentId: 'sequence-already-in-project',
  expectedSequenceFingerprint: sequenceFingerprint,
  csv: { kind: 'text' as const, text: 'position,fitness\n1,0\n2,-3\n' },
  mapping: {
    kind: 'positions' as const,
    startColumn: 'position',
    coordinateSystem: 'one-based-inclusive' as const,
  },
  valueColumns: ['fitness'],
  label: 'Fitness measurements',
  unit: 'log2 fitness',
  unresolvedPolicy: 'reject' as const,
  aggregation: 'none' as const,
};

beforeEach(() => {
  run.mockReset();
});

describe('sequence_data_layers command boundary', () => {
  it('requires explicit coordinate and target revision interpretation before creation', () => {
    expect(sequenceDataLayersToolSchema.safeParse(request).success).toBe(true);
    expect(
      sequenceDataLayersToolSchema.safeParse({ ...request, expectedSequenceFingerprint: undefined })
        .success
    ).toBe(false);
    expect(
      sequenceDataLayersToolSchema.safeParse({
        ...request,
        mapping: { kind: 'positions', startColumn: 'position' },
      }).success
    ).toBe(false);
  });

  it('inspects the exact saved target through the common native owner', async () => {
    const target = { documentId: request.targetDocumentId, sequenceFingerprint, length: 200 };
    run.mockResolvedValue({ status: 'target', target, annotationIdentifiers: [] });
    const result = await createSequenceDataLayersTool([project]).execute!(
      { operation: 'target', project: project.name, targetDocumentId: request.targetDocumentId },
      options
    );
    expect(run).toHaveBeenCalledWith({
      operation: 'target',
      project: project.path,
      targetDocumentId: request.targetDocumentId,
    });
    expect(result).toEqual({
      ok: true,
      status: 'target',
      data: { target, annotationIdentifiers: [] },
    });
  });

  it('does not submit outside the caller projects or after cancellation', async () => {
    const tool = createSequenceDataLayersTool([project]);
    expect(await tool.execute!({ ...request, project: '/someone-else' }, options)).toMatchObject({
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      stateChanged: false,
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await tool.execute!(request, { ...options, abortSignal: controller.signal })
    ).toMatchObject({ ok: false, code: 'CANCELLED', stateChanged: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('retains needs-input mapping outcomes without claiming a published layer', async () => {
    const report = {
      counts: { total: 2, mapped: 1, unmapped: 0, ambiguous: 1, rejected: 0 },
      outcomes: [{ kind: 'ambiguous', rowId: 'row-2' }],
    };
    run.mockResolvedValue({
      status: 'needs-input',
      target: { documentId: request.targetDocumentId },
      prepared: { report },
    });
    expect(await createSequenceDataLayersTool([project]).execute!(request, options)).toMatchObject({
      ok: true,
      status: 'needs-input',
      data: { report, published: false },
    });
  });

  it('returns a durable publication summary and signals views without duplicating the source data', async () => {
    const changed = vi.fn();
    window.addEventListener('dnaforge:sequence-data-layers-changed', changed);
    try {
      run.mockResolvedValue({
        status: 'published',
        document: {
          id: `layer-${'b'.repeat(64)}`,
          target: { documentId: request.targetDocumentId },
          label: request.label,
          source: { csv: request.csv.text },
          report: { counts: { total: 2, mapped: 2 } },
          presentation: { sampleId: 'fitness' },
        },
        path: '/projects/existing/.dnaforge/sequence-data-layers/layer.json',
        revision: 'revision-1',
        availability: { status: 'current' },
        alreadyPublished: false,
      });
      const result = await createSequenceDataLayersTool([project]).execute!(request, options);
      expect(result).toMatchObject({
        ok: true,
        status: 'published',
        data: { revision: 'revision-1', counts: { mapped: 2 } },
      });
      expect(JSON.stringify(result)).not.toContain(request.csv.text);
      expect(changed).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(request);
    } finally {
      window.removeEventListener('dnaforge:sequence-data-layers-changed', changed);
    }
  });

  it('reports an uncertain mutation after a lost native response without pretending rollback', async () => {
    run.mockRejectedValue(new Error('connection closed after native write'));
    const result = await createSequenceDataLayersTool([project]).execute!(request, options);
    expect(result).toMatchObject({
      ok: false,
      stateChanged: 'unknown',
      partialEffects: [expect.stringContaining('requestId')],
    });
  });

  it.each(['not-published', 'publication-uncertain'] as const)(
    'preserves the native %s disposition across the AI boundary', async (disposition) => {
      run.mockResolvedValue({ status: 'failed', disposition, message: 'Native command did not confirm publication' });
      expect(await createSequenceDataLayersTool([project]).execute!(request, options)).toMatchObject({
        ok: false, stateChanged: disposition === 'not-published' ? false : 'unknown',
      });
    }
  );
});
