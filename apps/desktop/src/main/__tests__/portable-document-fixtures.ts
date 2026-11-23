import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  createSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import {
  buildNotebookPackageDocument,
  buildNotebookPackageMetadata,
  notebookPackagePaths,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { buildSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  type EntityArtifactV2,
} from '../../shared/entity-artifact';
import { LIMS_BUILTIN_SCHEMAS } from '../../shared/lims';
import { buildPrimerArtifact } from '../../shared/primers/primer-artifact';
import { sha256Hex } from '../../shared/sha256-sync';
import {
  serializeTablePackageHead,
  serializeTableSnapshot,
  tablePackagePaths,
  tablePackageRevisionPath,
  type TablePackageHead,
  type TableSnapshot,
} from '../../shared/table-package';
import { trackViewFixture } from '../../shared/track-view-fixture';
import type { PortableDocumentKind } from '../portable-document-open-check';

const timestamp = '2026-01-01T00:00:00Z';
const tableId = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';
export const genbank = `LOCUS       Synthetic                   8 bp    DNA     linear   SYN 01-JAN-2000
DEFINITION  Synthetic fixture.
FEATURES             Location/Qualifiers
ORIGIN
        1 acgttgca
//
`;
export const referenceId = 'local-1234567890abcdef12345678';
const notebook = buildNotebookPackageDocument({ id: 'note-1', title: 'Example' });
export function recordFixture(relativePath = 'Example.entity.json'): EntityArtifactV2 {
  const kind = 'strain';
  const schema = LIMS_BUILTIN_SCHEMAS.find(
    (entry) => entry.kind === 'entity' && entry.name === kind
  );
  if (!schema) throw new Error('The test record schema is missing.');
  const schemaId = 'schema-entity-strain';
  const version = schema.version ?? 1;
  const schemaRevisionId = `${schemaId}-v${version}`;
  return {
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    id: 'fixture-record-1',
    kind,
    name: 'Example record',
    schemaRevisionId,
    schemaSnapshot: {
      schemaId,
      schemaRevisionId,
      name: kind,
      baseKind: schema.baseKind ?? kind,
      displayName: schema.displayName,
      description: schema.description,
      version,
      fields: schema.fields.map((field) => ({ ...field })),
    },
    fields: {
      genotypeCanonical: 'fixture',
      artifact: { schema: ENTITY_ARTIFACT_CURRENT_SCHEMA, relativePath },
    },
    registrationStatus: 'tracked',
    domainStatus: null,
    archived: false,
    relationships: [],
    source: { type: 'manual', values: {} },
  };
}
const protocol = {
  schema: 'dnaforge.protocol.v1',
  kind: 'protocol',
  id: 'protocol-1',
  title: 'Example steps',
  overview: { type: 'doc', content: [{ type: 'paragraph' }] },
  steps: [],
  inputs: [],
  outputs: [],
  version: { sourceVersionId: 'version-1' },
};
const run = {
  schema: 'dnaforge.protocol-run.v1',
  kind: 'protocol_run',
  id: 'run-1',
  title: 'Example record',
  status: 'in_progress',
  protocol: { name: 'Example steps', pinnedVersionId: 'version-1' },
  inputs: [],
  outputs: [],
  measurements: [],
  tables: [],
  amendments: [],
};

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}

export async function primer(root: string, path: string) {
  return buildPrimerArtifact({
    id: 'primer-1',
    catalogNumber: 'PR-000001',
    name: 'Synthetic fixture',
    sequence: 'ACGTTGCATTCGACGT',
    workspaceRoot: root,
    artifactPath: path,
    source: 'manual',
  });
}

function selection() {
  return createSavedResidueSelectionDocument({
    id: 'selection-1',
    name: 'Example residues',
    color: '#123456',
    revisionId: 'selection-r1',
    createdAt: timestamp,
    actor: { kind: 'user' },
    members: [
      {
        id: 'member-1',
        selection: {
          target: {
            moleculeId: 'protein:synthetic',
            moleculeKind: 'protein',
            coordinateSystem: 'residue',
            intervals: [{ start: 0, end: 0 }],
          },
        },
        scope: { kind: 'polymer' },
        polymerRevision: {
          moleculeId: 'protein:synthetic',
          moleculeKind: 'protein',
          sequenceDigestSha256: 'a'.repeat(64),
        },
      },
    ],
  });
}

export const flatDocuments: {
  kind: PortableDocumentKind;
  path: string;
  fixture: (root: string, path: string) => object | Promise<object>;
  broken: object;
  newer: object;
}[] = [
  {
    kind: 'notebook',
    path: 'Example.wpnote.json',
    fixture: () => notebook,
    broken: { content: { type: 'unknown-node' } },
    newer: { schema: 'waypoint.notebook.v2' },
  },
  {
    kind: 'notebook',
    path: 'Legacy notebook/.forge/notebook.json',
    fixture: () => notebook,
    broken: { content: { type: 'unknown-node' } },
    newer: { schema: 'waypoint.notebook.v2' },
  },
  {
    kind: 'design',
    path: 'Sketch.wpdesign.json',
    fixture: () => ({
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id: 'design-1',
      name: 'Example',
      design: { id: 'design-1', regions: [] },
    }),
    broken: { design: { id: 'design-1', regions: 'not an array' } },
    newer: { schema: 'waypoint.design.v2' },
  },
  {
    kind: 'primer',
    path: 'Example.primer.json',
    fixture: primer,
    broken: { sequence: null },
    newer: { schemaVersion: 999 },
  },
  {
    kind: 'entity',
    path: 'Example.entity.json',
    fixture: () => recordFixture(),
    broken: { fields: null },
    newer: { schema: 'waypoint.entity.v3' },
  },
  {
    kind: 'selection',
    path: 'Example.wpselection.json',
    fixture: () => JSON.parse(serializeSavedResidueSelectionDocument(selection())),
    broken: { currentRevisionId: 'missing-revision' },
    newer: { schema: 'waypoint.residue-selection.v2' },
  },
  {
    kind: 'protocol',
    path: 'Example.dnaforge-protocol.json',
    fixture: () => protocol,
    broken: { steps: null },
    newer: { schema: 'dnaforge.protocol.v2' },
  },
  {
    kind: 'protocol',
    path: 'Protocol/.forge/protocol.json',
    fixture: () => protocol,
    broken: { steps: null },
    newer: { schema: 'dnaforge.protocol.v2' },
  },
  {
    kind: 'protocol-run',
    path: 'Example.dnaforge-protocol-run.json',
    fixture: () => run,
    broken: { status: 'queued' },
    newer: { schema: 'dnaforge.protocol-run.v2' },
  },
  {
    kind: 'protocol-run',
    path: 'Run/.forge/protocol-run.json',
    fixture: () => run,
    broken: { status: 'queued' },
    newer: { schema: 'dnaforge.protocol-run.v2' },
  },
  {
    kind: 'track-view',
    path: 'Example.dnaforge-track-view.json',
    fixture: () => trackViewFixture(),
    broken: { viewport: { start0: -1, end0: 100 } },
    newer: { schema: 'dnaforge.track-view.v4' },
  },
];

export async function writeNotebookDocumentFixture(root: string) {
  const packageRoot = join(root, 'Example notebook');
  const paths = notebookPackagePaths(packageRoot);
  const metadata = buildNotebookPackageMetadata({
    id: 'note-2',
    title: 'Example notebook',
    markdownFileName: basename(paths.markdownPath),
  });
  const serialized = serializeNotebookMarkdown({
    identity: { id: metadata.id, title: metadata.title, formatVersion: 2 },
    content: {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            refId: 'example-table',
            data: { columnLabels: ['Name'], cells: [[{ value: 'Example', type: 'text' }]] },
          },
        },
      ],
    },
  });
  await writeJson(paths.metaPath, metadata);
  await writeFile(paths.markdownPath, serialized.markdown);
  const payload = serialized.payloads[0];
  const payloadPath = join(packageRoot, payload.relativePath);
  await mkdir(dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, payload.content);
  return { paths, metadata, payloadPath, payload };
}

export async function writeSequenceDocumentFixture(root: string) {
  const packageRoot = join(root, 'Example sequence');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'Named.gb' });
  const metadata = buildSequencePackageDocument({
    id: 'sequence-1',
    name: 'Example sequence',
    product: { file: 'Named.gb' },
  });
  await writeJson(paths.metaPath, metadata);
  await writeFile(paths.productPath, genbank);
  return { packageRoot, paths, metadata };
}

export async function writeTableDocumentFixture(root: string) {
  const packageRoot = join(root, 'Example table');
  const paths = tablePackagePaths(packageRoot);
  const snapshot: TableSnapshot = {
    schema: 'dnaforge.table-snapshot.v1',
    documentId: tableId,
    title: 'Example',
    data: { rows: 1, cols: 1, cells: [[{ value: 'alpha', type: 'text' }]] },
  };
  const snapshotText = serializeTableSnapshot(snapshot);
  const snapshotSha256 = sha256Hex(snapshotText);
  const head: TablePackageHead = {
    schema: 'dnaforge.table.v1',
    id: tableId,
    snapshotSha256,
    snapshot,
    aliases: [],
    status: 'active',
  };
  const snapshotPath = tablePackageRevisionPath(packageRoot, snapshotSha256);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(paths.headPath, serializeTablePackageHead(head));
  await writeFile(snapshotPath, snapshotText);
  return { head, paths, snapshot, snapshotPath };
}

export async function writePortableDocumentFixtures(
  root: string,
  options: { trackView?: object } = {}
): Promise<{ kind: PortableDocumentKind; path: string; openPath: string }[]> {
  const flat = await Promise.all(
    flatDocuments.map(async (entry) => {
      const path = join(root, entry.path);
      const content =
        entry.kind === 'track-view' && options.trackView
          ? options.trackView
          : await entry.fixture(root, path);
      await writeJson(path, content);
      const openPath = entry.path.includes('/.forge/') ? dirname(dirname(path)) : path;
      return { kind: entry.kind, path, openPath };
    })
  );
  const [notebook, sequence, table] = await Promise.all([
    writeNotebookDocumentFixture(root),
    writeSequenceDocumentFixture(root),
    writeTableDocumentFixture(root),
  ]);
  return [
    ...flat,
    {
      kind: 'notebook',
      path: notebook.paths.metaPath,
      openPath: dirname(dirname(notebook.paths.metaPath)),
    },
    { kind: 'sequence-package', path: sequence.paths.metaPath, openPath: sequence.packageRoot },
    {
      kind: 'table-package',
      path: table.paths.headPath,
      openPath: dirname(dirname(table.paths.headPath)),
    },
  ];
}
