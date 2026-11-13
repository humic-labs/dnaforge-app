import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import {
  SourceContextRegistry,
  createAssemblyWorkbenchSourceContext,
  createJunctionSourceWindowRequests,
  loadSourceSequenceForKey,
} from './SourceContextRegistry';
import { projectSourceProvenance } from './provenance/projectJunctionProvenance';
import { deriveSourceRowFields } from './provenance/deriveRowFields';
import { DEFAULT_JUNCTION_WINDOW_BP } from './coord-mapping';
import { buildJunctionWorkbenchModels } from './model';
import { SOURCE_ROW_BUFFER_BP } from './registered-window';

describe('SourceContextRegistry workbench command bridge', () => {
  it('feeds bounded source windows to source-boundary reducer commands', () => {
    const source = annotatedSource(
      'source-1',
      `${'T'.repeat(600)}${'ACGT'.repeat(40)}${'G'.repeat(600)}`
    );
    const design = draftedDesignFromSource(source.sequence, 600, 600 + 'ACGT'.repeat(40).length);
    const registry = new SourceContextRegistry({ [source.id]: source });
    const windows = registry.resolveWindows(
      createJunctionSourceWindowRequests(design, { maxWindowBp: 80 })
    );
    const sourceContext = createAssemblyWorkbenchSourceContext(windows);
    const viewState = createAssemblyWorkbenchViewState(design);
    const nextSourceEnd = design.regions[0].sourceEnd + 240;

    expect(sourceContext.regions?.r1?.sourceStart).toBeLessThanOrEqual(
      design.regions[0].sourceStart
    );
    expect(sourceContext.regions?.r1?.sourceEnd).toBeGreaterThanOrEqual(nextSourceEnd);
    expect(sourceContext.regions?.r1?.sourceLength).toBe(source.sequence.length);
    expect(sourceContext.regions?.r1?.sequence.length).toBeLessThan(source.sequence.length);

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      sourceContext,
      command: {
        type: 'setSourceContributionBoundary',
        regionId: 'r1',
        side: 'downstream',
        sourcePosition: nextSourceEnd,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-05-02T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.regions[0].sourceEnd).toBe(nextSourceEnd);
    expect(result.nextDesign.regions[0].sequence).toBe(
      source.sequence.slice(design.regions[0].sourceStart, nextSourceEnd)
    );
  });

  it('buffers circular source windows so source boundaries can move both directions', () => {
    const source = annotatedSource(
      'source-1',
      `${'T'.repeat(600)}${'ACGT'.repeat(40)}${'G'.repeat(600)}`,
      true
    );
    const design = draftedDesignFromSource(source.sequence, 600, 600 + 'ACGT'.repeat(40).length);
    const registry = new SourceContextRegistry({ [source.id]: source });
    const windows = registry.resolveWindows(
      createJunctionSourceWindowRequests(design, { maxWindowBp: 80 })
    );
    const sourceContext = createAssemblyWorkbenchSourceContext(windows);

    expect(sourceContext.regions?.r1?.sourceStart).toBeLessThan(design.regions[0].sourceStart);
    expect(sourceContext.regions?.r1?.sourceEnd).toBeGreaterThan(design.regions[0].sourceEnd);
    expect(sourceContext.regions?.r1?.sourceLength).toBe(source.sequence.length);
    expect(sourceContext.regions?.r2?.sourceStart).toBeLessThan(design.regions[1].sourceStart);
    expect(sourceContext.regions?.r2?.sourceEnd).toBeGreaterThan(design.regions[1].sourceEnd);
  });

  it('treats wrapped circular source ranges as contributing on both sides of origin', () => {
    const source = annotatedSource('wrapped-source', 'AAAACCCCGGGGTTTT', true);
    const projection = projectSourceProvenance({
      rowId: 'gibson:0:left',
      side: 'left',
      region: {
        ...region('r1', source.id, source.sequence, 12, 20),
        sourceSequence: source.sequence,
        sourceIsCircular: true,
      },
      assemblyMethod: 'gibson',
      registeredStartBioCol: -8,
      registeredEndBioCol: 8,
      productJunctionPosition: 20,
      spacerLength: 0,
      bufferLeft: 0,
      bufferRight: 0,
    });

    expect(projection.intervals.assembledContributionIntervals).toEqual([
      { start: 12, end: 20, sourceLength: 16, circular: true },
    ]);
    expect(projection.bases.find((base) => base.sourceBase === 14)?.owner).toBe('contributing');
    expect(projection.bases.find((base) => base.sourceBase === 18)?.owner).toBe('contributing');
    expect(projection.bases.find((base) => base.normalizedSourceBase === 8)?.owner).toBe('muted');
  });

  it('keeps circular source-window positions in the unwrapped row coordinate frame', () => {
    const source = annotatedSource('wrapped-source', 'AAAACCCCGGGGTTTT', true);
    const design = draftedDesignFromSource(source.sequence, 12, 20);
    const registry = new SourceContextRegistry({ [source.id]: source });
    const windows = registry.resolveWindows(
      createJunctionSourceWindowRequests(design, { maxWindowBp: 80 })
    );
    const leftWindow = windows['gibson:0:left'];

    expect(leftWindow.sourceContextStart).toBeLessThan(0);
    expect(leftWindow.sourceContextEnd).toBeGreaterThan(source.length);
    expect(leftWindow.sourceContextSequence.replace(/\s/g, '')).toContain('TTTTAAAA');
  });

  it('does not turn a wrap-around part into the complementary 12kb plasmid arc', () => {
    const sourceSequence = `${'T'.repeat(200)}${'A'.repeat(400)}${'C'.repeat(11100)}${'G'.repeat(300)}`;
    expect(sourceSequence).toHaveLength(12_000);
    const source = annotatedSource('plasmid', sourceSequence, true);
    const design = draftedWrapAroundPlasmidDesign(sourceSequence);
    const registry = new SourceContextRegistry({ [source.id]: source });
    const windows = registry.resolveWindows(createJunctionSourceWindowRequests(design));
    const wrapWindows = Object.values(windows).filter((window) => window.regionId === 'backbone');

    expect(wrapWindows.length).toBeGreaterThan(0);
    for (const window of wrapWindows) {
      expect(window.sourceStart).toBe(11_700);
      expect(window.sourceEnd).toBe(200);
      const context = window.sourceContextSequence.replace(/\s/g, '');
      expect(context.length).toBeLessThan(2_500);
      expect(window.sourceContextEnd - window.sourceContextStart).toBeLessThan(2_500);
      expect(context).toContain('G'.repeat(20));
      expect(context).toContain('T'.repeat(20));
      expect(context).not.toContain('C'.repeat(2_000));
    }

    const models = buildJunctionWorkbenchModels(design, { sourceWindows: windows });
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      for (const row of model.rows) {
        expect(row.sequence.length).toBeLessThanOrEqual(
          DEFAULT_JUNCTION_WINDOW_BP + SOURCE_ROW_BUFFER_BP * 2
        );
      }
    }
  });

  it('preserves circular included ranges as unwrapped intervals for contribution masks', () => {
    const source = annotatedSource('wrapped-source', 'AAAACCCCGGGGTTTT', true);
    const design = draftedDesignFromSource(source.sequence, 12, 20);
    const registry = new SourceContextRegistry({ [source.id]: source });
    const windows = registry.resolveWindows(
      createJunctionSourceWindowRequests(design, { maxWindowBp: 80 })
    );
    const leftWindow = windows['gibson:0:left'];

    expect(leftWindow.sourceStart).toBe(12);
    expect(leftWindow.sourceEnd).toBe(20);
    const projection = projectSourceProvenance({
      rowId: 'gibson:0:left',
      side: 'left',
      region: design.regions[0],
      assemblyMethod: 'gibson',
      registeredStartBioCol: -8,
      registeredEndBioCol: 8,
      productJunctionPosition: 20,
      spacerLength: 0,
      bufferLeft: 0,
      bufferRight: 0,
      sourceWindow: leftWindow,
    });
    const derived = deriveSourceRowFields(projection);

    expect(projection.intervals.assembledContributionIntervals).toEqual([
      { start: 12, end: 20, sourceLength: 16, circular: true },
    ]);
    expect(projection.bases.find((base) => base.sourceBase === 14)?.owner).toBe('contributing');
    expect(projection.bases.find((base) => base.sourceBase === 18)?.owner).toBe('contributing');
    expect(projection.bases.find((base) => base.normalizedSourceBase === 8)?.owner).toBe('muted');
    expect(derived.contributingColumns.length + derived.mutedColumns.length).toBe(
      derived.visibleColumns.length
    );
  });

  it('rehydrates bundled real assembly source fixtures when persisted designs reopen without sequence cache', async () => {
    const source = await loadSourceSequenceForKey('fixture:sequence:puc19-real-assembly');

    expect(source?.sequence.length).toBeGreaterThan(2000);
    expect(source?.circular).toBe(true);
    expect(source?.id).toBe('fixture:sequence:puc19-real-assembly');
  });

  it('requests the full default registered window for long RD fragments instead of the legacy narrow cap', () => {
    const source = annotatedSource(
      'source-1',
      `${'A'.repeat(900)}${'C'.repeat(700)}${'G'.repeat(700)}${'T'.repeat(900)}`
    );
    const base = draftedDesignFromSource(source.sequence, 900, 1600);
    const design: SequenceDesign = {
      ...base,
      regions: [
        {
          ...base.regions[0],
          sourceType: 'rd',
          sourceStart: 900,
          sourceEnd: 1600,
          sequence: source.sequence.slice(900, 1600),
        },
        {
          ...base.regions[1],
          sourceStart: 1604,
          sourceEnd: 2304,
          sequence: source.sequence.slice(1604, 2304),
        },
      ],
    };

    const requests = createJunctionSourceWindowRequests(design);
    const left = requests.find((request) => request.side === 'left' && request.junctionIndex === 0);
    const right = requests.find(
      (request) => request.side === 'right' && request.junctionIndex === 0
    );

    expect(left?.registeredStartBioCol).toBe(-DEFAULT_JUNCTION_WINDOW_BP / 2);
    expect(left?.registeredEndBioCol).toBe(DEFAULT_JUNCTION_WINDOW_BP / 2);
    expect(right?.registeredStartBioCol).toBe(-DEFAULT_JUNCTION_WINDOW_BP / 2);
    expect(right?.registeredEndBioCol).toBe(DEFAULT_JUNCTION_WINDOW_BP / 2);
  });
});

function draftedWrapAroundPlasmidDesign(sourceSequence: string): SequenceDesign {
  const now = new Date('2026-08-12T00:00:00.000Z');
  const insert: DesignRegion = {
    ...region('insert', 'plasmid', sourceSequence, 200, 600),
    sourceSequence,
    sourceIsCircular: true,
  };
  const backbone: DesignRegion = {
    id: 'backbone',
    sourceSequenceId: 'plasmid',
    sourceSequenceName: 'plasmid',
    sourceStart: 11_700,
    sourceEnd: 200,
    sequence: sliceSource(sourceSequence, 11_700, 500),
    annotations: [],
    sourceType: 'pcr',
    sourceSequence,
    sourceIsCircular: true,
  };
  const design: SequenceDesign = {
    id: 'wrap-around-plasmid-workbench',
    name: 'Wrap-around plasmid workbench',
    topology: 'circular',
    regions: [insert, backbone],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 24,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
  const draft = computeDraftAssembly(design);
  return ensureAssemblyWorkbenchIdentity({
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  });
}

function draftedDesignFromSource(
  sourceSequence: string,
  sourceStart: number,
  sourceEnd: number
): SequenceDesign {
  const now = new Date('2026-05-02T00:00:00.000Z');
  const design: SequenceDesign = {
    id: 'source-context-workbench',
    name: 'Source Context Workbench',
    topology: 'linear',
    regions: [
      region('r1', 'source-1', sourceSequence, sourceStart, sourceEnd),
      region('r2', 'source-1', sourceSequence, sourceEnd + 4, sourceEnd + 84),
    ],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 24,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
  const draft = computeDraftAssembly(design);
  return ensureAssemblyWorkbenchIdentity({
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  });
}

function region(
  id: string,
  sourceSequenceId: string,
  sourceSequence: string,
  sourceStart: number,
  sourceEnd: number
): DesignRegion {
  return {
    id,
    sourceSequenceId,
    sourceSequenceName: sourceSequenceId,
    sourceStart,
    sourceEnd,
    sequence: sliceSource(sourceSequence, sourceStart, sourceEnd - sourceStart),
    annotations: [],
    sourceType: 'pcr',
  };
}

function sliceSource(sequence: string, start: number, length: number): string {
  if (length <= 0) return '';
  if (start >= 0 && start + length <= sequence.length) return sequence.slice(start, start + length);
  let result = '';
  for (let offset = 0; offset < length; offset++) {
    const position = (((start + offset) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[position] ?? '';
  }
  return result;
}

function annotatedSource(id: string, sequence: string, circular = false): AnnotatedSequence {
  return {
    id,
    name: id,
    sequence,
    length: sequence.length,
    circular,
    annotations: [],
  };
}
