import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
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

describe('named dataset palettes at the tool boundary', () => {
  const colorScale = {
    kind: 'continuous' as const,
    domain: [0, 16] as [number, number],
    missingColor: '#cbd5e1',
    transform: 'linear' as const,
  };
  const presentation = {
    sampleId: 'fitness',
    annotationColors: true,
    signalVisible: true,
    style: { geometry: 'band' as const, colorScale },
  };
  const withScale = (scale: object) => ({
    ...request,
    presentation: { ...presentation, style: { ...presentation.style, colorScale: scale } },
  });

  beforeEach(() => {
    run.mockResolvedValue({
      status: 'failed',
      disposition: 'not-published',
      message: 'Source changed.',
    });
  });

  it('resolves named Cividis to the registry colors before invoking the native command', async () => {
    const command = sequenceDataLayersToolSchema.parse(
      withScale({ ...colorScale, paletteId: 'cividis' })
    );
    await createSequenceDataLayersTool([project]).execute!(command, options);
    expect(run).toHaveBeenCalledWith(
      withScale({ ...colorScale, colors: [...SCIENTIFIC_COLOR_PALETTES.cividis.colors] })
    );
    expect(command).not.toHaveProperty('presentation.style.colorScale.paletteId');
  });

  it('preserves explicit custom RGB scales unchanged', async () => {
    const custom = withScale({ ...colorScale, colors: ['#123456', '#abcdef'] });
    const command = sequenceDataLayersToolSchema.parse(custom);
    await createSequenceDataLayersTool([project]).execute!(command, options);
    expect(command).toEqual(custom);
    expect(run).toHaveBeenCalledWith(custom);
  });

  it('rejects unknown named palettes', () => {
    expect(
      sequenceDataLayersToolSchema.safeParse(withScale({ ...colorScale, paletteId: 'invented' }))
        .success
    ).toBe(false);
  });

  it('rejects combining a named palette with conflicting custom colors', () => {
    expect(
      sequenceDataLayersToolSchema.safeParse(
        withScale({ ...colorScale, paletteId: 'cividis', colors: ['#123456', '#abcdef'] })
      ).success
    ).toBe(false);
  });

  it('retains the shared color-domain validation for named palettes', () => {
    expect(
      sequenceDataLayersToolSchema.safeParse(
        withScale({ ...colorScale, paletteId: 'cividis', domain: [16, 0] })
      ).success
    ).toBe(false);
  });
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
    'preserves the native %s disposition across the AI boundary',
    async (disposition) => {
      run.mockResolvedValue({
        status: 'failed',
        disposition,
        message: 'Native command did not confirm publication',
      });
      expect(
        await createSequenceDataLayersTool([project]).execute!(request, options)
      ).toMatchObject({
        ok: false,
        stateChanged: disposition === 'not-published' ? false : 'unknown',
      });
    }
  );
});

describe('reusing a retained dataset through the caller boundary', () => {
  const sourceProject = { name: 'Measurements', path: '/projects/measurements', addedAt: 2 };
  const source = {
    project: sourceProject.path,
    id: `layer-${'c'.repeat(64)}`,
    revision: 'd'.repeat(64),
  };
  const reuseRequest = { ...request, csv: { kind: 'layer' as const, source } };

  function published(projectPath?: string) {
    return {
      status: 'published',
      ...(projectPath ? { project: projectPath } : {}),
      document: {
        id: `layer-${'e'.repeat(64)}`,
        target: { documentId: request.targetDocumentId },
        label: request.label,
        unit: request.unit,
        valueColumns: request.valueColumns,
        source: { csv: request.csv.text, origin: source },
        report: { counts: { total: 2, mapped: 2 } },
        presentation: { sampleId: 'fitness' },
      },
      path: '/projects/existing/.dnaforge/sequence-data-layers/layer.json',
      revision: 'f'.repeat(64),
      availability: { status: 'current' },
      alreadyPublished: false,
    };
  }

  it('returns the saved CSV mapping recipe from every reusable response without changing source bytes', async () => {
    const csv = 'locus_tag,fitness\nb1007,0\nb1008,-3\n';
    const sha256 = `sha256:${createHash('sha256').update(csv).digest('hex')}`;
    const recipe = {
      mapping: {
        kind: 'annotation' as const,
        identifierColumn: 'locus_tag',
        identifierField: 'locus_tag' as const,
      },
      aggregation: 'none' as const,
      unresolvedPolicy: 'exclude' as const,
    };
    const saved = published('/canonical/projects/existing');
    const publication = {
      ...saved,
      document: {
        ...saved.document,
        ...recipe,
        source: { ...saved.document.source, csv, sha256 },
      },
    };
    const originalSource = { ...publication.document.source };
    const metadata = {
      ...recipe,
      source: { project: saved.project, id: saved.document.id, revision: saved.revision },
      unit: saved.document.unit,
      valueColumns: saved.document.valueColumns,
    };
    const tool = createSequenceDataLayersTool([project, sourceProject]);
    for (const operation of ['create', 'list', 'inspect'] as const) {
      run.mockResolvedValue(
        operation === 'list' ? { status: 'listed', layers: [publication], errors: [] } : publication
      );
      const input =
        operation === 'create'
          ? { ...reuseRequest, ...recipe }
          : operation === 'inspect'
            ? { operation, project: project.path, id: saved.document.id }
            : { operation, project: project.path };
      const result = await tool.execute!(input, options);
      expect(result).toMatchObject({
        ok: true,
        data: operation === 'list' ? { layers: [metadata] } : metadata,
      });
      expect(JSON.stringify(result)).not.toContain(JSON.stringify(csv).slice(1, -1));
    }
    expect(publication.document.source).toEqual(originalSource);
    expect(createHash('sha256').update(publication.document.source.csv).digest('hex')).toBe(
      sha256.slice('sha256:'.length)
    );
  });

  it('accepts an exact saved source version and rejects incomplete source references', () => {
    expect(sequenceDataLayersToolSchema.safeParse(reuseRequest).success).toBe(true);
    expect(
      sequenceDataLayersToolSchema.safeParse({
        ...reuseRequest,
        csv: { kind: 'layer', source: { ...source, revision: undefined } },
      }).success
    ).toBe(false);
  });

  it('does not submit a source outside the caller projects', async () => {
    expect(
      await createSequenceDataLayersTool([project]).execute!(reuseRequest, options)
    ).toMatchObject({
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      stateChanged: false,
      partialEffects: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not submit an ambiguously named source project', async () => {
    const folders = [
      project,
      sourceProject,
      { ...sourceProject, path: '/projects/other-measurements' },
    ];
    expect(
      await createSequenceDataLayersTool(folders).execute!(
        {
          ...reuseRequest,
          csv: { kind: 'layer', source: { ...source, project: sourceProject.name } },
        },
        options
      )
    ).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND', stateChanged: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('resolves both admitted project names without changing the selected source version', async () => {
    run.mockResolvedValue(published());
    await createSequenceDataLayersTool([project, sourceProject]).execute!(
      {
        ...reuseRequest,
        project: project.name,
        csv: { kind: 'layer', source: { ...source, project: sourceProject.name } },
      },
      options
    );
    expect(run).toHaveBeenCalledWith(reuseRequest);
  });

  it.each(['create', 'inspect'] as const)(
    'returns the published artifact reference and measurement metadata from %s without CSV bytes',
    async (operation) => {
      const saved = published('/canonical/projects/existing');
      run.mockResolvedValue(saved);
      const input =
        operation === 'create'
          ? reuseRequest
          : {
              operation,
              project: project.path,
              id: saved.document.id,
            };
      const result = await createSequenceDataLayersTool([project, sourceProject]).execute!(
        input,
        options
      );
      expect(result).toMatchObject({
        ok: true,
        status: 'published',
        data: {
          unit: request.unit,
          valueColumns: request.valueColumns,
          source: { project: saved.project, id: saved.document.id, revision: saved.revision },
          origin: source,
        },
      });
      expect(JSON.stringify(result)).not.toContain(request.csv.text);
    }
  );

  it('returns a reusable reference for each listed artifact with the admitted root as a legacy fallback', async () => {
    const saved = published();
    run.mockResolvedValue({ status: 'listed', errors: [], layers: [saved] });
    const result = await createSequenceDataLayersTool([project]).execute!(
      {
        operation: 'list',
        project: project.name,
      },
      options
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'listed',
      data: {
        layers: [
          {
            unit: request.unit,
            valueColumns: request.valueColumns,
            source: { project: project.path, id: saved.document.id, revision: saved.revision },
            origin: source,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(request.csv.text);
  });

  it.each(['not-published', 'publication-uncertain'] as const)(
    'preserves the native %s disposition for source reuse',
    async (disposition) => {
      run.mockResolvedValue({ status: 'failed', disposition, message: 'Source did not verify' });
      expect(
        await createSequenceDataLayersTool([project, sourceProject]).execute!(reuseRequest, options)
      ).toMatchObject({
        ok: false,
        stateChanged: disposition === 'not-published' ? false : 'unknown',
      });
    }
  );
});
