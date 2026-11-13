import { describe, expect, it } from 'vitest';
import { parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';

import type { SourceObject, SourceRelationship } from '../../shared/benchling-migration';
import {
  buildSyntheticNativeExportZip,
  type SyntheticZipEntry,
} from './__fixtures__/native-export-zip-fixture';
import { decodeBenchlingNativeExport } from './native-export-decoder';
import { buildProjectionPlan } from './projection';
import {
  exactRelationshipResolutionCaptureConflict,
  inferredSelectedSnapshotOrganizationBaseUrl,
  resolveOfflineRelationships,
} from './relationship-resolver';

const SOURCE_ENTRY_PATH = 'Corpus/Source Notebook (etr_SOURCE1).html';
const CANONICAL_TARGET_URL =
  'https://benchling.com/dnaforge-fixture/f/lib_CORPUS-corpus/etr_TARGET1-linked-notebook/edit';

describe('native export decoder relationship identity', () => {
  it('preserves separate exported annotations through import, reopen and save', async () => {
    const decoded = await decodeEntries([
      {
        path: 'Registry/Repeated features (seq_REPEATS1).gb',
        bytes: `LOCUS       source                    24 bp    DNA     linear   SYN 01-JAN-2000
DEFINITION  Source description.
KEYWORDS    first keyword
            second keyword
FEATURES             Location/Qualifiers
     CDS             1..6
                     /label="Repeated peptide"
                     /label="Secondary source label"
                     /note="First exported feature"
     CDS             10..15
                     /label="Repeated peptide"
                     /note="Second exported feature"
                     /note="Another source note"
     misc_feature    18..24
                     /label="GAL1 promoter"
ORIGIN
        1 acgtacgtacgtacgtacgtacgt
//
`,
      },
    ]);
    const source = decoded.sourceObjects.find((object) => object.stableId === 'seq_REPEATS1');
    if (!source) throw new Error('Decoded sequence missing.');
    const plan = buildProjectionPlan(source, {
      runId: 'source-feature-fidelity',
      capturedAt: '2026-08-31T00:00:00.000Z',
      converterVersion: 'test',
    });
    expect(plan.projection, plan.exception ?? '').toBe('native');
    const file = plan.files.find(({ relativePath }) => relativePath.endsWith('.gb'));
    if (file?.text === undefined) throw new Error('Native sequence missing.');
    const reopened = parseGenBankFull(file.text);
    const saved = parseGenBankFull(serializeGenBank(reopened));
    for (const sequence of [reopened, saved]) {
      expect(sequence.description).toBe('Source description.');
      expect(sequence.sequence).toBe('ACGTACGTACGTACGTACGTACGT');
      expect(sequence.annotations.map(({ type, start, end }) => ({ type, start, end }))).toEqual([
        { type: 'CDS', start: 1, end: 6 },
        { type: 'CDS', start: 10, end: 15 },
        { type: 'misc_feature', start: 18, end: 24 },
      ]);
      expect(sequence.annotations[0].qualifiers?.note).toEqual(['First exported feature']);
      expect(sequence.annotations[0].qualifiers?.label).toEqual([
        'Repeated peptide',
        'Secondary source label',
      ]);
      expect(sequence.annotations[1].qualifiers?.note).toEqual([
        'Second exported feature',
        'Another source note',
      ]);
    }
  });

  it('revalidates inferred immutable ZIP origin without granting live or cross-organization authority', async () => {
    const decoded = await decodeEntries([
      {
        path: SOURCE_ENTRY_PATH,
        bytes: notebookHtml(`<a href="${CANONICAL_TARGET_URL}">Linked notebook</a>`),
      },
      { path: 'Corpus/Linked notebook (etr_TARGET1).html', bytes: notebookHtml('Target') },
    ]);
    const relationships = decoded.sourceObjects.flatMap((source) => source.relationships);
    const resolution = resolveOfflineRelationships({
      sourceObjects: decoded.sourceObjects,
      relationships,
      selectedSnapshotStableIdsAreAuthoritative: true,
    }).resolutions[0];
    const relationship = relationships[0];
    if (!resolution || !relationship) throw new Error('Missing decoded relationship');
    expect(resolution.classification).toBe('exact');
    const input = {
      sourceObjects: decoded.sourceObjects,
      relationship,
      resolution,
      benchlingOrigin: inferredSelectedSnapshotOrganizationBaseUrl(relationships),
      selectedSnapshotStableIdsAreAuthoritative: true,
    };
    expect(exactRelationshipResolutionCaptureConflict(input)).toBeNull();
    expect(
      exactRelationshipResolutionCaptureConflict({
        ...input,
        selectedSnapshotStableIdsAreAuthoritative: false,
        benchlingOrigin: undefined,
      })
    ).not.toBeNull();
    expect(
      exactRelationshipResolutionCaptureConflict({
        ...input,
        benchlingOrigin: 'https://benchling.com/another-fixture',
      })
    ).not.toBeNull();
    expect(
      exactRelationshipResolutionCaptureConflict({
        ...input,
        resolution: {
          ...resolution,
          targetSourceId: 'etr_OTHER2',
          candidateSourceIds: ['etr_OTHER2'],
        },
      })
    ).not.toBeNull();
    const mixed = decoded.sourceObjects.map((source) => ({
      ...source,
      relationships: [
        ...source.relationships,
        {
          ...relationship,
          id: 'another-tenant',
          targetUrl: CANONICAL_TARGET_URL.replace('dnaforge-fixture', 'another-fixture'),
        },
      ],
    }));
    expect(
      exactRelationshipResolutionCaptureConflict({
        ...input,
        sourceObjects: mixed,
        benchlingOrigin: inferredSelectedSnapshotOrganizationBaseUrl(
          mixed.flatMap((source) => source.relationships)
        ),
      })
    ).not.toBeNull();
  });

  it('reports factual intermediate progress while selected archive entries are decoded', async () => {
    const entries = Array.from({ length: 130 }, (_, index) => ({
      path: `Corpus/Sequence ${index} (seq_PROGRESS${String(index).padStart(4, '0')}).gb`,
      bytes: `LOCUS       PROGRESS${index} 8 bp DNA linear\nORIGIN\n        1 acgtacgt\n//\n`,
    }));
    const fixture = buildSyntheticNativeExportZip(entries);
    const progress: Array<{ completed: number; total: number }> = [];

    await decodeBenchlingNativeExport(
      {
        source: {
          kind: 'bytes',
          logicalFilename: 'progress.zip',
          bytes: fixture.bytes,
          expectedSha256: fixture.sha256,
          expectedSizeBytes: fixture.sizeBytes,
          duplicateSupportEntryPolicy: 'identical_root_benchling_css',
        },
        controlMetadata: { source: 'none' },
        context: {
          snapshotId: 'native-export-decoder-progress',
          capturedAt: '2026-08-20T00:00:00.000Z',
          archivePartId: 'local-export:native-export-decoder-progress',
          sourceUrlPrefix: null,
          localBundleAuthority: {
            schema: 'dnaforge.benchling.local-native-export-authority.v1',
            logicalFilename: 'progress.zip',
            sha256: fixture.sha256,
          },
          selectedEntryPaths: entries.map((entry) => entry.path),
        },
      },
      (update) => progress.push(update)
    );

    expect(progress).toEqual([
      { completed: 0, total: 130 },
      { completed: 64, total: 130 },
      { completed: 128, total: 130 },
      { completed: 130, total: 130 },
    ]);
  });

  it('derives the same exact target identity from data-internal-link as from a canonical href', async () => {
    const viaHref = await notebookRelationships(
      `<a href="${CANONICAL_TARGET_URL}">Linked notebook</a>`
    );
    const viaInternalLink = await notebookRelationships(
      `<a data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Linked notebook</a>`
    );
    const viaEncodedInternalLink = await notebookRelationships(
      '<a data-internal-link="{&quot;type&quot;:&quot;entry&quot;,&quot;id&quot;:&quot;etr_TARGET1&quot;}">Linked notebook</a>'
    );

    expect(targetIdentities(viaHref)).toEqual(['etr_TARGET1']);
    expect(targetIdentities(viaInternalLink)).toEqual(['etr_TARGET1']);
    expect(targetIdentities(viaEncodedInternalLink)).toEqual(['etr_TARGET1']);
    expect(viaInternalLink[0]).toMatchObject({ relationType: 'references' });
    expect(stableIdEvidence(viaInternalLink[0])).toEqual(['etr_TARGET1']);
  });

  it('reads the identity from data-internal-link when the href is absent, relative, or non-canonical', async () => {
    const anchors = [
      `<a data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Linked notebook</a>`,
      `<a href="../Linked notebook (etr_TARGET1).html" data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Linked notebook</a>`,
      `<a href="https://benchling.com/dnaforge-fixture/notebook" data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Linked notebook</a>`,
    ];

    for (const anchor of anchors) {
      const relationships = await notebookRelationships(anchor);
      expect(targetIdentities(relationships)).toEqual(['etr_TARGET1']);
      expect(stableIdEvidence(relationships[0])).toEqual(['etr_TARGET1']);
    }
  });

  it('replaces an embedded card title match with the exact identity the card declares', async () => {
    const titleOnly = await notebookRelationships(embeddedEntryCard(''));
    const withIdentity = await notebookRelationships(
      embeddedEntryCard(`<a data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Open</a>`)
    );

    expect(titleOnly).toEqual([
      expect.objectContaining({
        relationType: 'embedded_entry_reference',
        evidence: [{ kind: 'name', value: 'Linked notebook' }],
      }),
    ]);
    expect(targetIdentities(withIdentity)).toEqual(['etr_TARGET1']);
    expect(
      withIdentity.some((relationship) => relationship.relationType === 'embedded_entry_reference')
    ).toBe(false);
  });

  it('emits one relationship when the href and data-internal-link agree', async () => {
    const relationships = await notebookRelationships(
      `<a href="${CANONICAL_TARGET_URL}" data-internal-link='{"type":"entry","id":"etr_TARGET1"}'>Linked notebook</a>`
    );

    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      targetSourceId: 'etr_TARGET1',
      targetUrl: CANONICAL_TARGET_URL,
      relationType: 'references',
    });
    expect(stableIdEvidence(relationships[0])).toEqual(['etr_TARGET1']);
  });

  it('never prefers one identity when the href and data-internal-link disagree', async () => {
    const relationships = await notebookRelationships(
      `<a href="${CANONICAL_TARGET_URL}" data-internal-link='{"type":"entry","id":"etr_OTHER2"}'>Linked notebook</a>`
    );

    expect(relationships).toHaveLength(1);
    expect(relationships[0]?.targetSourceId).toBeUndefined();
    expect(stableIdEvidence(relationships[0])).toEqual(['etr_OTHER2', 'etr_TARGET1']);
    expect(offlineClassification(relationships)).toBe('ambiguous');
  });

  it('ignores malformed data-internal-link metadata without throwing', async () => {
    const malformed = [
      `data-internal-link=''`,
      `data-internal-link='not json'`,
      `data-internal-link='{"type":"entry"}'`,
      `data-internal-link='{"type":"entry","id":123}'`,
      `data-internal-link='{"type":"entry","id":{"id":"etr_TARGET1"}}'`,
      `data-internal-link='["etr_TARGET1"]'`,
      `data-internal-link='"etr_TARGET1"'`,
      `data-internal-link='{"type":"entry","id":"etr_${'A'.repeat(20_000)}"}'`,
    ];

    for (const attribute of malformed) {
      const relationships = await notebookRelationships(`<a ${attribute}>Linked notebook</a>`);
      expect(relationships).toEqual([]);
    }
  });

  it('keeps an external person mention external instead of promoting it to a local target', async () => {
    const relationships = await notebookRelationships(
      `<a data-internal-link='{"type":"user","id":"ent_PERSON1"}'>@Jane Doe</a>` +
        `<a href="https://example.com/people/jane-doe" data-internal-link='{"type":"user","id":"ent_PERSON1"}'>Jane Doe</a>`
    );

    expect(relationships).toEqual([
      expect.objectContaining({
        relationType: 'external_reference',
        targetUrl: 'https://example.com/people/jane-doe',
      }),
    ]);
    expect(targetIdentities(relationships)).toEqual([]);
    expect(JSON.stringify(relationships)).not.toContain('ent_PERSON1');
  });

  it('never takes provider identity from a GenBank LOCUS line or body text', async () => {
    const decoded = await decodeEntries([
      { path: 'Corpus/Plasmid (seq_REALTARGET).gb', bytes: decoyGenBank() },
    ]);
    const sequence = decoded.sourceObjects[0];

    expect(decoded.sourceObjects).toHaveLength(1);
    expect(sequence).toMatchObject({ id: 'seq_REALTARGET', stableId: 'seq_REALTARGET' });
    expect(sequence?.relationships).toEqual([]);
    expect([sequence?.id, sequence?.stableId]).not.toContain('etr_LOCUSDECOY');
    expect([sequence?.id, sequence?.stableId]).not.toContain('seq_BODYDECOY');
  });

  it('rejects an id-shaped token below the accepted exact-ID shape', async () => {
    const decoded = await decodeEntries([
      { path: 'Corpus/Plasmid (seq_REALTARGET).gb', bytes: decoyGenBank() },
    ]);
    const sequence = decoded.sourceObjects[0];

    expect(JSON.stringify(sequence?.content)).toContain('seq_x');
    expect(sequence?.stableId).toBe('seq_REALTARGET');

    const relationships = await notebookRelationships(
      `<a data-internal-link='{"type":"sequence","id":"seq_x"}'>Short token</a>`
    );
    expect(relationships).toEqual([]);
  });
});

function targetIdentities(relationships: readonly SourceRelationship[]): string[] {
  return relationships
    .map((relationship) => relationship.targetSourceId)
    .filter((value): value is string => Boolean(value))
    .sort();
}

function stableIdEvidence(relationship: SourceRelationship | undefined): string[] {
  return (relationship?.evidence ?? [])
    .filter((evidence) => evidence.kind === 'stable_id')
    .map((evidence) => evidence.value);
}

function offlineClassification(relationships: readonly SourceRelationship[]): string | undefined {
  const targets: SourceObject[] = ['etr_TARGET1', 'etr_OTHER2'].map((stableId) => ({
    id: stableId,
    stableId,
    sourceType: 'notebook_entry',
    name: stableId,
    aliases: [],
    sourceUrl: `https://benchling.com/dnaforge-fixture/f/lib_CORPUS-corpus/${stableId}-linked-notebook`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: {},
    relationships: [],
  }));
  return resolveOfflineRelationships({
    sourceObjects: targets,
    relationships: [...relationships],
    selectedSnapshotStableIdsAreAuthoritative: true,
  }).resolutions[0]?.classification;
}

function embeddedEntryCard(anchor: string): string {
  return `<div class="note-entry" data-test-component="NoteDropTarget" data-test-element="NoteLinkedFilePreview">
      <div data-test-element="PreviewItemName">Linked notebook</div>
      ${anchor}
    </div>`;
}

function notebookHtml(body: string): string {
  return `<!doctype html>
<html>
  <body>
    <h1>Source notebook</h1>
    ${body}
  </body>
</html>
`;
}

function decoyGenBank(): string {
  return `LOCUS       etr_LOCUSDECOY            8 bp    DNA     linear       20-AUG-2026
DEFINITION  Plasmid referenced as seq_BODYDECOY in prose.
FEATURES             Location/Qualifiers
     misc_feature    1..8
                     /label="seq_x"
ORIGIN
        1 acgtacgt
//
`;
}

async function notebookRelationships(body: string): Promise<SourceRelationship[]> {
  const decoded = await decodeEntries([{ path: SOURCE_ENTRY_PATH, bytes: notebookHtml(body) }]);
  const notebook = decoded.sourceObjects.find(({ stableId }) => stableId === 'etr_SOURCE1');
  return notebook?.relationships ?? [];
}

async function decodeEntries(entries: readonly SyntheticZipEntry[]) {
  const fixture = buildSyntheticNativeExportZip(entries);
  return decodeBenchlingNativeExport({
    source: {
      kind: 'bytes',
      logicalFilename: 'native-export.zip',
      bytes: fixture.bytes,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css',
    },
    controlMetadata: { source: 'none' },
    context: {
      snapshotId: 'native-export-decoder-identity',
      capturedAt: '2026-08-20T00:00:00.000Z',
      archivePartId: 'local-export:native-export-decoder-identity',
      sourceUrlPrefix: null,
      localBundleAuthority: {
        schema: 'dnaforge.benchling.local-native-export-authority.v1',
        logicalFilename: 'native-export.zip',
        sha256: fixture.sha256,
      },
    },
  });
}
