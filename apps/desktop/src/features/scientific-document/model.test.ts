// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  addProtocolStep,
  appendProtocolRunTextAmendment,
  deleteProtocolStep,
  migrationWorkspaceMarkerPath,
  moveProtocolStep,
  parseScientificDocument,
  renameScientificDocument,
  reviseProtocolStepWithHistory,
  safeExternalHttpUrl,
  serializeScientificDocument,
  updateProtocolOverview,
  updateProtocolStep,
  updateProteinSequence,
} from './model';

describe('scientific document model', () => {
  it('keeps saved formula results and source formulas in the run view without changing its raw data', () => {
    const raw = JSON.parse(protocolRunDocument('completed'));
    raw.tables = [
      {
        id: 't1',
        name: 'Results',
        cells: [
          [
            {
              type: 'formula',
              value: '=BENCHLING(A1)',
              computed: 0,
              formulaCompatibility: 'unsupported',
              stale: true,
            },
            { type: 'formula', value: '=BENCHLING(B1)', formulaCompatibility: 'unsupported' },
            { type: 'number', value: '9' },
          ],
        ],
      },
    ];
    const parsed = parseScientificDocument(
      '/ws/run.dnaforge-protocol-run.json',
      JSON.stringify(raw)
    );
    expect(parsed).toMatchObject({
      kind: 'protocol_run',
      tables: [
        {
          cells: [
            [
              { value: '0', savedResult: { formula: '=BENCHLING(A1)', value: '0', stale: true } },
              { value: '', savedResult: { formula: '=BENCHLING(B1)', value: null, stale: false } },
              { value: '9', savedResult: null },
            ],
          ],
        },
      ],
    });
    expect(JSON.parse(serializeScientificDocument(parsed))).toEqual(raw);
  });
  it('parses and safely edits a native protocol without changing ordered content or provenance', () => {
    const source = protocolDocument();
    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', source);
    expect(parsed).toMatchObject({
      kind: 'protocol',
      title: 'PCR',
      overviewText: 'Amplify DNA',
      steps: [{ ordinal: 1, title: 'Prepare', text: 'Mix reagents' }],
      versionLabel: 'version_3',
    });

    const renamed = renameScientificDocument(parsed, 'PCR amplification');
    const persisted = JSON.parse(serializeScientificDocument(renamed));
    expect(persisted.title).toBe('PCR amplification');
    expect(persisted.steps).toEqual(JSON.parse(source).steps);
    expect(persisted.provenance).toEqual(JSON.parse(source).provenance);
  });

  it('keeps completed ProtocolRuns immutable and adds append-only amendments to in-progress runs', async () => {
    const completed = parseScientificDocument(
      '/ws/run.dnaforge-protocol-run.json',
      protocolRunDocument('completed')
    );
    expect(completed).toMatchObject({ kind: 'protocol_run', mutable: false });
    await expect(
      appendProtocolRunTextAmendment(
        completed.kind === 'protocol_run' ? completed : neverProtocolRun(),
        { path: '/outputs/result', reason: 'Correction', value: '42' }
      )
    ).rejects.toThrow('Completed protocol runs are immutable');

    const inProgress = parseScientificDocument(
      '/ws/run.dnaforge-protocol-run.json',
      protocolRunDocument('in_progress')
    );
    const amended = await appendProtocolRunTextAmendment(
      inProgress.kind === 'protocol_run' ? inProgress : neverProtocolRun(),
      {
        path: '/measurements/yield',
        reason: 'Instrument correction',
        value: '81.5 ng/uL',
        at: '2026-07-18T01:02:03.000Z',
      }
    );
    expect(amended.amendments).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^amendment-1-[a-f0-9]{16}$/),
        sequence: 1,
        path: '/measurements/yield',
      }),
    ]);
    expect((amended.raw.amendments as unknown[])[0]).toMatchObject({
      reason: 'Instrument correction',
      value: { type: 'text', value: '81.5 ng/uL' },
    });
  });

  it('preserves external and exact local TipTap marks as typed rich-text links', () => {
    const raw = JSON.parse(protocolDocument());
    raw.overview.content[0].content = [
      { type: 'text', text: 'Read ' },
      {
        type: 'text',
        text: 'the paper',
        marks: [{ type: 'link', attrs: { href: 'https://example.org/pcr' } }],
      },
      { type: 'text', text: ' and ' },
      {
        type: 'text',
        text: 'open template',
        marks: [
          {
            type: 'link',
            attrs: {
              href: 'entity://workspace/benchling-template-1',
              destinationTargetId: 'benchling-template-1',
            },
          },
        ],
      },
    ];

    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');
    expect(parsed.overview.segments).toEqual([
      { text: 'Read ', link: null },
      { text: 'the paper', link: { kind: 'external', href: 'https://example.org/pcr' } },
      { text: ' and ', link: null },
      {
        text: 'open template',
        link: {
          kind: 'local',
          href: 'entity://workspace/benchling-template-1',
          destinationTargetId: 'benchling-template-1',
        },
      },
    ]);
    const titleOnlyEdit = updateProtocolStep(parsed, 'step-1', { title: 'Renamed step' });
    expect((titleOnlyEdit.raw.steps as Array<Record<string, unknown>>)[0].content).toEqual(
      raw.steps[0].content
    );
  });

  it('allows only credential-free HTTP(S) navigation while leaving raw provenance untouched', () => {
    expect(safeExternalHttpUrl('https://example.org/source')).toBe('https://example.org/source');
    expect(safeExternalHttpUrl('http://example.org/source')).toBe('http://example.org/source');
    expect(safeExternalHttpUrl('https://user:secret@example.org/source')).toBeNull();
    expect(safeExternalHttpUrl('javascript:alert(1)')).toBeNull();

    const raw = JSON.parse(protocolDocument());
    const unsafe = 'https://user:secret@example.benchling.com/example/protocols/prtl_pcr';
    raw.provenance.sourceUrl = unsafe;
    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw));
    expect(parsed.kind === 'protocol' ? parsed.sourceUrl : null).toBe(unsafe);
    expect(parsed.kind === 'protocol' ? parsed.raw.provenance : null).toEqual(raw.provenance);
  });

  it('edits protocol body and deterministically adds, reorders, and deletes steps without touching source version or provenance', async () => {
    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', protocolDocument());
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');
    const sourceVersion = structuredClone(parsed.raw.version);
    const sourceProvenance = structuredClone(parsed.raw.provenance);

    const overviewEdited = updateProtocolOverview(parsed, 'Edited overview\nSecond paragraph');
    const stepEdited = updateProtocolStep(overviewEdited, 'step-1', {
      title: 'Prepare master mix',
      contentText: 'Combine template and primers.',
    });
    const firstAddition = await addProtocolStep(stepEdited, {
      title: 'Verify product',
      contentText: 'Inspect the gel.',
    });
    const replayedAddition = await addProtocolStep(stepEdited, {
      title: 'Verify product',
      contentText: 'Inspect the gel.',
    });
    expect(firstAddition.steps.at(-1)?.id).toBe(replayedAddition.steps.at(-1)?.id);

    const addedId = firstAddition.steps.at(-1)!.id;
    const moved = moveProtocolStep(firstAddition, addedId, 'up');
    expect(moved.steps.map((step) => [step.id, step.ordinal])).toEqual([
      [addedId, 1],
      ['step-1', 2],
    ]);
    const deleted = deleteProtocolStep(moved, 'step-1');
    expect(deleted.steps).toHaveLength(1);
    expect(deleted.steps[0]).toMatchObject({ id: addedId, ordinal: 1 });
    expect(deleted.overview.text).toBe('Edited overview\nSecond paragraph');
    expect(stepEdited.steps[0]).toMatchObject({
      title: 'Prepare master mix',
      text: 'Combine template and primers.',
    });
    expect(deleted.raw.version).toEqual(sourceVersion);
    expect(deleted.raw.provenance).toEqual(sourceProvenance);
    expect(() => deleteProtocolStep(deleted, addedId)).toThrow(
      'A protocol must retain at least one step'
    );
  });

  it('invalidates exact source-span claims when paper-derived step content is edited', () => {
    const raw = JSON.parse(protocolDocument());
    raw.steps[0].sourceStatus = 'source';
    raw.steps[0].sourceSpans = [
      {
        sourceId: 'paper:10.1000/example',
        sectionId: 'methods',
        start: 0,
        end: 12,
        text: 'Mix reagents',
        textSha256: 'a'.repeat(64),
      },
    ];
    raw.steps[0].content.content[0].content[0].marks = [
      {
        type: 'sourceSpan',
        attrs: {
          sourceId: 'paper:10.1000/example',
          sectionId: 'methods',
          start: 0,
          end: 12,
          textSha256: 'a'.repeat(64),
        },
      },
    ];
    const parsed = parseScientificDocument('/ws/paper.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    const titleOnly = updateProtocolStep(parsed, 'step-1', { title: 'Renamed source step' });
    expect((titleOnly.raw.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceStatus: 'source',
      sourceSpans: raw.steps[0].sourceSpans,
    });

    const contentEdited = updateProtocolStep(titleOnly, 'step-1', {
      contentText: 'Mix reagents, then inspect the result.',
    });
    expect((contentEdited.raw.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      sourceStatus: 'edited',
      sourceSpans: [],
    });
    expect(
      ((contentEdited.raw.steps as Array<Record<string, unknown>>)[0].content as JsonDocument)
        .content[0].content[0].marks
    ).toBeUndefined();
  });

  it('records an agent revision with reversible before and after step snapshots', async () => {
    const raw = JSON.parse(protocolDocument());
    raw.steps[0].sourceStatus = 'source';
    raw.steps[0].sourceSpans = [
      {
        sourceId: 'paper:10.1000/example',
        sectionId: 'methods',
        sectionTitle: 'Methods',
        start: 0,
        end: 12,
        sha256: 'a'.repeat(64),
      },
    ];
    const parsed = parseScientificDocument('/ws/paper.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    const revision = await reviseProtocolStepWithHistory(
      parsed,
      'step-1',
      { contentText: 'Mix reagents carefully' },
      { actor: 'agent', at: '2026-08-18T21:00:00.000Z' }
    );

    expect(revision.revisionId).toMatch(/^protocol-revision-[a-f0-9]{20}$/);
    expect(revision.document.steps[0]).toMatchObject({
      text: 'Mix reagents carefully',
      sourceStatus: 'edited',
      sourceSpans: [],
    });
    expect(revision.document.raw.revisions).toEqual([
      expect.objectContaining({
        id: revision.revisionId,
        kind: 'protocol_step_revision',
        actor: 'agent',
        at: '2026-08-18T21:00:00.000Z',
        stepId: 'step-1',
        before: expect.objectContaining({
          title: 'Prepare',
          sourceStatus: 'source',
          sourceSpans: raw.steps[0].sourceSpans,
        }),
        after: expect.objectContaining({
          title: 'Prepare',
          sourceStatus: 'edited',
          sourceSpans: [],
        }),
      }),
    ]);
  });

  it('parses an immutable paper source bundle and exact protocol evidence spans', () => {
    const raw = JSON.parse(protocolDocument());
    raw.sourceBundle = {
      schema: 'dnaforge.paper-source-bundle.v1',
      immutable: true,
      sources: [
        {
          sourceId: 'paper:10.1000/example',
          kind: 'paper',
          title: 'An ordinary cloning paper',
          sections: [
            {
              sectionId: 'methods',
              sectionTitle: 'Methods',
              text: 'Mix reagents',
              offsetBase: 0,
              order: 1,
              sha256: 'a'.repeat(64),
            },
          ],
        },
      ],
    };
    raw.steps[0].sourceStatus = 'source';
    raw.steps[0].sourceSpans = [
      {
        sourceId: 'paper:10.1000/example',
        sectionId: 'methods',
        sectionTitle: 'Methods',
        start: 0,
        end: 12,
        sha256: 'a'.repeat(64),
      },
    ];

    const parsed = parseScientificDocument('/ws/paper.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    expect(parsed.sourceBundle).toEqual({
      immutable: true,
      sources: [
        {
          sourceId: 'paper:10.1000/example',
          kind: 'paper',
          title: 'An ordinary cloning paper',
          sections: [
            {
              sectionId: 'methods',
              sectionTitle: 'Methods',
              text: 'Mix reagents',
              offsetBase: 0,
              order: 1,
              sha256: 'a'.repeat(64),
            },
          ],
        },
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      sourceStatus: 'source',
      sourceSpans: [
        {
          sourceId: 'paper:10.1000/example',
          sectionId: 'methods',
          start: 0,
          end: 12,
        },
      ],
    });
  });

  it('keeps ordinary protocols valid without a source bundle and rejects mutable bundles', () => {
    const ordinary = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', protocolDocument());
    expect(ordinary.kind === 'protocol' ? ordinary.sourceBundle : null).toBeNull();

    const raw = JSON.parse(protocolDocument());
    raw.sourceBundle = {
      schema: 'dnaforge.paper-source-bundle.v1',
      immutable: false,
      sources: [],
    };
    expect(() =>
      parseScientificDocument('/ws/paper.dnaforge-protocol.json', JSON.stringify(raw))
    ).toThrow('Paper source bundle must be immutable');
  });

  it('parses PDF identity and normalized page anchors without embedding paper text', () => {
    const raw = JSON.parse(protocolDocument());
    raw.pdfSources = [
      {
        sourceId: 'paper-main',
        title: 'Source paper',
        workspacePath: 'papers/source.pdf',
        sha256: 'b'.repeat(64),
        pageCount: 12,
      },
    ];
    raw.steps[0].sourceStatus = 'source';
    raw.steps[0].pdfAnchors = [
      {
        anchorId: 'anchor-step-1',
        sourceId: 'paper-main',
        page: 4,
        quote: 'Mix reagents',
        rects: [{ x: 0.12, y: 0.31, width: 0.43, height: 0.04 }],
      },
    ];

    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    expect(parsed.pdfSources).toEqual(raw.pdfSources);
    expect(parsed.steps[0].pdfAnchors).toEqual(raw.steps[0].pdfAnchors);
    expect(JSON.stringify(parsed.raw)).not.toContain('paper-source-bundle');
  });

  it('rejects PDF anchors that escape the page or target mismatched source identity', () => {
    const raw = JSON.parse(protocolDocument());
    raw.pdfSources = [
      {
        sourceId: 'paper-main',
        title: 'Source paper',
        workspacePath: 'papers/source.pdf',
        sha256: 'b'.repeat(64),
        pageCount: 2,
      },
    ];
    raw.steps[0].pdfAnchors = [
      {
        anchorId: 'anchor-step-1',
        sourceId: 'paper-main',
        page: 1,
        quote: 'Mix reagents',
        rects: [{ x: 0.9, y: 0.3, width: 0.2, height: 0.04 }],
      },
    ];
    expect(() =>
      parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw))
    ).toThrow('exceeds the page');

    raw.steps[0].pdfAnchors[0] = {
      ...raw.steps[0].pdfAnchors[0],
      sourceId: 'different-paper',
      rects: [{ x: 0.1, y: 0.3, width: 0.2, height: 0.04 }],
    };
    expect(() =>
      parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw))
    ).toThrow('unknown source');
  });

  it('invalidates PDF anchors when source-derived instructions change', () => {
    const raw = JSON.parse(protocolDocument());
    raw.pdfSources = [
      {
        sourceId: 'paper-main',
        title: 'Source paper',
        workspacePath: 'papers/source.pdf',
        sha256: 'b'.repeat(64),
        pageCount: 2,
      },
    ];
    raw.steps[0].sourceStatus = 'source';
    raw.steps[0].pdfAnchors = [
      {
        anchorId: 'anchor-step-1',
        sourceId: 'paper-main',
        page: 1,
        quote: 'Mix reagents',
        rects: [{ x: 0.1, y: 0.3, width: 0.2, height: 0.04 }],
      },
    ];
    const parsed = parseScientificDocument('/ws/PCR.dnaforge-protocol.json', JSON.stringify(raw));
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    const titleOnly = updateProtocolStep(parsed, 'step-1', { title: 'Prepare reaction' });
    expect(titleOnly.steps[0].pdfAnchors).toHaveLength(1);

    const contentEdited = updateProtocolStep(parsed, 'step-1', {
      contentText: 'Use a different mixture.',
    });
    expect(contentEdited.steps[0]).toMatchObject({ sourceStatus: 'edited', pdfAnchors: [] });
    expect((contentEdited.raw.steps as Array<Record<string, unknown>>)[0].pdfAnchors).toEqual([]);
  });

  it('renders proteins as amino acids and validates edits without nucleotide routing assumptions', () => {
    const parsed = parseScientificDocument(
      '/ws/protein.faa',
      '>prot_1 Example protein\nMKWVTFIS\n'
    );
    expect(parsed).toMatchObject({
      kind: 'protein',
      identifier: 'prot_1',
      title: 'Example protein',
      aminoAcids: 'MKWVTFIS',
    });
    if (parsed.kind !== 'protein') throw new Error('Expected protein.');
    const edited = updateProteinSequence(parsed, 'ACDE FGHI');
    expect(serializeScientificDocument(edited)).toBe('>prot_1 Example protein\nACDEFGHI\n');
    expect(() => updateProteinSequence(parsed, 'ACGTX')).toThrow('standard amino-acid alphabet');
  });

  it('refuses extension and schema mismatches instead of displaying generic JSON', () => {
    expect(() =>
      parseScientificDocument(
        '/ws/not-a-run.dnaforge-protocol-run.json',
        JSON.stringify({ schema: 'dnaforge.protocol.v1', kind: 'protocol' })
      )
    ).toThrow('extension and scientific document schema do not match');
  });

  it('keeps retired collection artifacts readable as immutable legacy folders', () => {
    const parsed = parseScientificDocument(
      '/ws/Benchling Imports/Collections/folder-1.dnaforge-collection.json',
      JSON.stringify({
        schema: 'dnaforge.collection.v1',
        kind: 'collection',
        id: 'benchling-collection-aaaaaaaaaaaaaaaaaaaaaaaa',
        title: 'Archive folder',
        editable: true,
        parentCollectionId: null,
        childCollectionIds: ['benchling-collection-bbbbbbbbbbbbbbbbbbbbbbbb'],
        memberObjectIds: ['notebook-cccccccccccccccccccccccc'],
        excludedChildFolders: [],
        provenance: { sourceUrl: 'https://example.benchling.com/folders/archive' },
      })
    );

    expect(parsed).toMatchObject({
      kind: 'legacy_collection',
      title: 'Archive folder',
      mutable: false,
      childCollectionIds: ['benchling-collection-bbbbbbbbbbbbbbbbbbbbbbbb'],
      memberObjectIds: ['notebook-cccccccccccccccccccccccc'],
    });
  });
});

function protocolDocument(): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'benchling-protocol-1',
    title: 'PCR',
    editable: true,
    overview: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Amplify DNA' }] }],
    },
    steps: [
      {
        id: 'step-1',
        sourceStepId: 'source-step-1',
        ordinal: 1,
        title: 'Prepare',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mix reagents' }] }],
        },
      },
    ],
    inputs: [
      { key: 'template', label: 'Template', required: true, valueType: { kind: 'dna_sequence' } },
    ],
    outputs: [
      { key: 'product', label: 'Product', required: true, valueType: { kind: 'dna_sequence' } },
    ],
    links: [],
    version: {
      sourceVersionId: 'version_3',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-07-18T00:00:00.000Z',
    },
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceUrl: 'https://example.benchling.com/example/protocols/prtl_pcr',
    },
  });
}

function protocolRunDocument(status: 'completed' | 'in_progress'): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol-run.v1',
    kind: 'protocol_run',
    id: 'benchling-run-1',
    title: 'PCR run',
    status,
    immutable: status === 'completed',
    protocol: {
      sourceId: 'prtl_pcr',
      destinationId: 'benchling-protocol-1',
      name: 'PCR',
      pinnedVersionId: 'version_3',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
    },
    inputs: [{ key: 'template', label: 'Template', value: { type: 'record', label: 'pTemplate' } }],
    outputs: [],
    measurements: [],
    tables: [],
    links: [],
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: status === 'completed' ? '2026-07-18T01:00:00.000Z' : null,
    amendments: [],
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceUrl: 'https://example.benchling.com/example/etr/run_1',
    },
  });
}

function neverProtocolRun(): never {
  throw new Error('Expected ProtocolRun.');
}

type JsonDocument = {
  content: Array<{ content: Array<{ marks?: unknown[] }> }>;
};
