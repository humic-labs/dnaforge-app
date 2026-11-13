import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type Database from 'better-sqlite3';
import {
  decodeBundleFileContent,
  validateNewBundleFilePolicy,
  validateWorkspaceSyncBundle,
  type WorkspaceSyncBundle,
} from '@waypoint/share-bundle';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), isPackaged: false, getPath: vi.fn(() => '/tmp') },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } },
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() },
}));

import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { ensureSchema } from '../schema';
import { materializeWorkspaceSyncBundleFiles } from '../workspace-sync-projects';
import { rehydrateWorkspaceSyncState } from '../workspace-sync-restore';
import {
  assertWorkspaceSyncSnapshotMatchesCommit,
  buildWorkspaceSyncSnapshot,
} from '../workspace-sync-snapshotter';
import { commitAllIfDirty, initManagedRepo, resolveHeadCommit } from '../workspace-git';
import { createTestDb } from './test-db';
import {
  defineWorkspaceRoundTripConformance,
  type MaterializedWorkspace,
  type PortablePublication,
  type PublicationCandidate,
  type RequiredRefusalName,
  type WorkspaceRoundTripAdapter,
  type WorkspaceRoundTripCapture,
  type WorkspaceRoundTripFixture,
  type WorkspaceRoundTripRefusalCase,
} from './workspace-roundtrip-conformance';

const WORKSPACE_UUID = 'sync-roundtrip-roundtrip-workspace';
const PACKAGE_ID = 'sync-roundtrip-stable-sequence-id';
const NOTEBOOK_ID = 'sync-roundtrip-notebook-id';
const DESIGN_ID = 'sync-roundtrip-design-id';
const RAW_CANARIES = [
  'SYNC_ROUNDTRIP_FASTQ_EXCLUDED_BYTES',
  'SYNC_ROUNDTRIP_BAM_EXCLUDED_BYTES',
  'SYNC_ROUNDTRIP_CRAM_EXCLUDED_BYTES',
  'SYNC_ROUNDTRIP_VCF_EXCLUDED_BYTES',
  'SYNC_ROUNDTRIP_AB1_EXCLUDED_BYTES',
] as const;

interface CurrentFixtureSource {
  db: Database.Database;
  root: string;
  head: string;
}

interface CurrentMaterialized {
  db: Database.Database;
  root: string;
}

interface ScientificProjection {
  sequences: Array<{
    id: string;
    packagePath: string;
    topology: 'circular' | 'linear' | null;
    productFile: string;
    members: Array<{ id: string; role: string; path: string }>;
  }>;
  notebooks: Array<{ id: string; title: string; content: string }>;
  notebookCatalog: Array<{ entityId: string | null; fileKind: string; status: string }>;
  designs: Array<{
    id: string;
    constructId: string;
    sourceSequenceId: string;
    assemblyMethod: string;
    circular: boolean;
  }>;
}

class CurrentWorkspaceSyncAdapter implements WorkspaceRoundTripAdapter<
  CurrentFixtureSource,
  WorkspaceSyncBundle,
  CurrentMaterialized,
  ScientificProjection
> {
  private readonly roots: string[] = [];
  private readonly databases: Database.Database[] = [];

  async createFixture(): Promise<
    WorkspaceRoundTripFixture<CurrentFixtureSource, ScientificProjection>
  > {
    const db = this.trackDatabase(createTestDb());
    ensureSchema(db, ':memory:');
    const root = await this.tempRoot('sync-roundtrip-source-');
    seedWorkspace(db, root);
    await writeGreenFixture(root);
    const originalPackage = parseSequencePackageDocument(
      await readFile(join(root, 'Original pRoundTrip', '.forge', 'plasmid.json'), 'utf8')
    );
    if (originalPackage.id !== PACKAGE_ID) {
      throw new Error(`Original package id ${originalPackage.id} did not match ${PACKAGE_ID}.`);
    }
    await initManagedRepo(root);
    await commitAllIfDirty(root, 'sync-roundtrip original package fixture');
    await rename(join(root, 'Original pRoundTrip'), join(root, 'Renamed pRoundTrip'));
    await commitAllIfDirty(root, 'sync-roundtrip rename package without changing identity');
    const renamedPackage = parseSequencePackageDocument(
      await readFile(join(root, 'Renamed pRoundTrip', '.forge', 'plasmid.json'), 'utf8')
    );
    if (renamedPackage.id !== originalPackage.id) {
      throw new Error(
        `Renamed package id ${renamedPackage.id} did not preserve ${originalPackage.id}.`
      );
    }
    const head = await resolveHeadCommit(root);
    if (!head) throw new Error('sync-roundtrip fixture did not produce a managed Git commit.');
    rehydrateWorkspaceSyncState(db, {
      workspaceId: 1,
      workspaceRoot: root,
      nowMs: 1000,
      strict: true,
    });
    const expectedProjection = await readScientificProjection(db, root);
    const expectedAdmittedFiles = await readFixtureAdmittedFiles(root);
    return {
      source: { db, root, head },
      expectedAdmittedFiles,
      expectedProjection,
      excludedCanaries: RAW_CANARIES,
      cleanup: async () => {
        for (const database of this.databases.splice(0)) database.close();
        await Promise.all(
          this.roots.splice(0).map((ownedRoot) => rm(ownedRoot, { recursive: true, force: true }))
        );
      },
    };
  }

  async capture(
    source: CurrentFixtureSource
  ): Promise<WorkspaceRoundTripCapture<WorkspaceSyncBundle>> {
    const snapshot = await buildWorkspaceSyncSnapshot(source.db, {
      workspaceUuid: WORKSPACE_UUID,
      appVersion: '0.8.2',
      capturedAt: new Date('2026-08-27T00:00:00.000Z'),
    });
    await assertWorkspaceSyncSnapshotMatchesCommit(snapshot, source.head);
    const admittedFiles = new Map(
      snapshot.bundle.files.map((file) => [file.relativePath, decodeBundleFileContent(file)])
    );
    return {
      portable: snapshot.bundle,
      admittedFiles,
      observables: [
        snapshot.bundle,
        {
          manifest: snapshot.bundle.files.map((file) => ({
            path: file.relativePath,
            sha256: file.sha256,
            sizeBytes: file.sizeBytes,
          })),
          diagnostic: { excludedSummary: snapshot.bundle.excludedSummary },
        },
      ],
    };
  }

  async encode(portable: WorkspaceSyncBundle): Promise<unknown> {
    return JSON.stringify(portable);
  }

  async decode(encoded: unknown): Promise<WorkspaceSyncBundle> {
    if (typeof encoded !== 'string') throw new Error('Encoded workspace version is not text.');
    const parsed: unknown = JSON.parse(encoded);
    return validatePortableOrThrow(parsed);
  }

  async materialize(
    portable: WorkspaceSyncBundle
  ): Promise<MaterializedWorkspace<CurrentMaterialized>> {
    const root = await this.tempRoot('sync-roundtrip-restored-');
    const db = this.trackDatabase(createTestDb());
    ensureSchema(db, ':memory:');
    seedWorkspace(db, root);
    await materializeWorkspaceSyncBundleFiles(root, portable);
    rehydrateWorkspaceSyncState(db, {
      workspaceId: 1,
      workspaceRoot: root,
      nowMs: 1000,
      strict: true,
    });
    return {
      value: { db, root },
      files: await readExpectedMaterializedFiles(root, portable),
    };
  }

  async project(materialized: CurrentMaterialized): Promise<ScientificProjection> {
    return readScientificProjection(materialized.db, materialized.root);
  }

  async invalidCases(
    source: CurrentFixtureSource,
    portable: WorkspaceSyncBundle
  ): Promise<ReadonlyMap<RequiredRefusalName, WorkspaceRoundTripRefusalCase>> {
    return new Map([
      [
        'traversal',
        {
          attempt: async () => {
            const changed = structuredClone(portable);
            changed.files[0]!.relativePath = '../escape.gb';
            return validatePortableOrThrow(changed);
          },
          expectedError: /files\[0\]\.relativePath is unsafe/,
        },
      ],
      [
        'case-fold-collision',
        {
          attempt: async () => {
            const changed = structuredClone(portable);
            const first = changed.files[0]!;
            changed.files.push({
              ...first,
              id: 'case-fold-duplicate',
              relativePath: first.relativePath.toUpperCase(),
            });
            return validatePortableOrThrow(changed);
          },
          expectedError: /relativePath collides case-insensitively/,
        },
      ],
      [
        'reserved-name',
        {
          attempt: async () => {
            const changed = structuredClone(portable);
            changed.files[0]!.relativePath = 'Renamed pRoundTrip/CON.gb';
            return validatePortableOrThrow(changed);
          },
          expectedError: /relativePath uses a reserved Windows name/,
        },
      ],
      [
        'symlink',
        {
          attempt: async () => this.captureSymlinkPackage(source.db),
          expectedError: /required member is a symbolic link/,
        },
      ],
      [
        'incomplete-package',
        {
          attempt: async () => {
            const changed = structuredClone(portable);
            changed.files = changed.files.filter(
              (file) => file.relativePath !== 'Renamed pRoundTrip/contents/calibration.bin'
            );
            return validatePortableOrThrow(changed);
          },
          expectedError:
            /sequence package Renamed pRoundTrip is incomplete: missing Renamed pRoundTrip\/contents\/calibration\.bin/,
        },
      ],
      [
        'unsupported-authority',
        {
          attempt: async () => {
            const changed = structuredClone(portable);
            const marker = changed.files.find((file) =>
              file.relativePath.endsWith('/.forge/plasmid.json')
            );
            if (!marker) throw new Error('Fixture marker is missing.');
            const document: unknown = JSON.parse(marker.content);
            if (!isUnknownRecord(document)) throw new Error('Fixture marker is invalid.');
            const unsupported = { ...document, formatVersion: 999 };
            marker.content = `${JSON.stringify(unsupported)}\n`;
            marker.sizeBytes = Buffer.byteLength(marker.content);
            marker.sha256 = createHash('sha256').update(marker.content, 'utf8').digest('hex');
            return validatePortableOrThrow(changed);
          },
          expectedError: /sequence package Renamed pRoundTrip has unsupported authoritative state/,
        },
      ],
    ]);
  }

  createPublication(): PortablePublication<WorkspaceSyncBundle> {
    return new InMemoryPortablePublication();
  }

  private async captureSymlinkPackage(db: Database.Database): Promise<unknown> {
    const root = await this.tempRoot('sync-roundtrip-symlink-');
    const packageRoot = join(root, 'Symlink package');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await writeFile(join(root, 'outside.gb'), genbank('outside'), 'utf8');
    await symlink('../outside.gb', join(packageRoot, 'Symlink package.gb'));
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'symlink-package-id',
          name: 'Symlink package',
          product: { file: 'Symlink package.gb' },
        })
      ),
      'utf8'
    );
    seedWorkspace(db, root, 2, 'sync-roundtrip-symlink-workspace');
    return buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'sync-roundtrip-symlink-workspace',
      appVersion: '0.8.2',
    });
  }

  private trackDatabase(db: Database.Database): Database.Database {
    this.databases.push(db);
    return db;
  }

  private async tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    this.roots.push(root);
    return root;
  }
}

class InMemoryPortablePublication implements PortablePublication<WorkspaceSyncBundle> {
  private nextVersion = 1;
  private readonly candidates = new Map<
    string,
    {
      candidate: PublicationCandidate<WorkspaceSyncBundle>;
      phase: 'reserved' | 'persisted' | 'ready';
    }
  >();
  private latestVersionId: string | null = null;
  private readonly eventLog: Array<Record<string, unknown>> = [];

  async reserve(
    baseVersionId: string | null,
    portable: WorkspaceSyncBundle
  ): Promise<PublicationCandidate<WorkspaceSyncBundle>> {
    const candidate = {
      id: `version-${this.nextVersion++}`,
      baseVersionId,
      portable,
    };
    this.candidates.set(candidate.id, { candidate, phase: 'reserved' });
    this.eventLog.push({ event: 'reserved', versionId: candidate.id, baseVersionId });
    return candidate;
  }

  async persist(candidate: PublicationCandidate<WorkspaceSyncBundle>): Promise<void> {
    const state = this.candidates.get(candidate.id);
    if (!state || state.phase !== 'reserved') throw new Error('Candidate cannot be persisted.');
    state.phase = 'persisted';
    this.eventLog.push({
      event: 'persisted',
      versionId: candidate.id,
      portable: candidate.portable,
    });
  }

  async finalize(
    candidate: PublicationCandidate<WorkspaceSyncBundle>
  ): Promise<{ status: 'ready'; versionId: string } | { status: 'stale' }> {
    const state = this.candidates.get(candidate.id);
    if (!state || state.phase !== 'persisted') throw new Error('Candidate cannot be finalized.');
    if (this.latestVersionId !== candidate.baseVersionId) {
      this.eventLog.push({ event: 'stale', versionId: candidate.id });
      return { status: 'stale' };
    }
    state.phase = 'ready';
    this.latestVersionId = candidate.id;
    this.eventLog.push({ event: 'ready', versionId: candidate.id });
    return { status: 'ready', versionId: candidate.id };
  }

  async latest(): Promise<{ versionId: string; portable: WorkspaceSyncBundle } | null> {
    if (!this.latestVersionId) return null;
    const state = this.candidates.get(this.latestVersionId);
    if (!state || state.phase !== 'ready') throw new Error('Latest pointer is not ready.');
    return { versionId: state.candidate.id, portable: state.candidate.portable };
  }

  observables(): readonly unknown[] {
    return [this.eventLog];
  }
}

const REAL_WORKSPACE_ROUNDTRIP_TIMEOUT_MS = 30_000;

defineWorkspaceRoundTripConformance(
  'current workspace-sync bundle',
  () => new CurrentWorkspaceSyncAdapter(),
  { timeout: REAL_WORKSPACE_ROUNDTRIP_TIMEOUT_MS }
);

it(
  'projects the assembly method and topology as scientific meaning',
  async () => {
    const adapter = new CurrentWorkspaceSyncAdapter();
    const fixture = await adapter.createFixture();
    try {
      expect(fixture.expectedProjection.designs).toEqual([
        {
          id: DESIGN_ID,
          constructId: PACKAGE_ID,
          sourceSequenceId: PACKAGE_ID,
          assemblyMethod: 'golden-gate',
          circular: true,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  },
  REAL_WORKSPACE_ROUNDTRIP_TIMEOUT_MS
);

async function writeGreenFixture(root: string): Promise<void> {
  const packageRoot = join(root, 'Original pRoundTrip');
  await mkdir(join(packageRoot, '.forge'), { recursive: true });
  await mkdir(join(packageRoot, 'contents'), { recursive: true });
  await writeFile(join(packageRoot, 'pRoundTrip.gb'), genbank('pRoundTrip', 'circular'), 'utf8');
  await writeFile(
    join(packageRoot, 'contents', 'calibration.bin'),
    Buffer.from([0xff, 0x00, 0x80, 0x44])
  );
  await writeFile(join(packageRoot, 'contents', 'assembly.txt'), 'assembly member\n', 'utf8');
  await writeFile(
    join(packageRoot, '.forge', 'plasmid.json'),
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: PACKAGE_ID,
        name: 'pRoundTrip',
        product: { file: 'pRoundTrip.gb', topology: 'circular' },
        members: [
          {
            id: 'member-calibration',
            role: 'user',
            path: 'contents/calibration.bin',
            replaceable: false,
            createdAt: '2026-08-27T00:00:00.000Z',
            mediaType: 'application/octet-stream',
          },
          {
            id: 'member-assembly',
            role: 'alignment',
            path: 'contents/assembly.txt',
            replaceable: true,
            createdAt: '2026-08-27T00:00:00.000Z',
            mediaType: 'text/plain',
          },
        ],
        assembly: {
          accepted: {
            designId: DESIGN_ID,
            sourceSequenceId: PACKAGE_ID,
            status: 'accepted',
          },
        },
        updatedAt: '2026-08-27T00:00:00.000Z',
      })
    ),
    'utf8'
  );

  await mkdir(join(root, 'references'), { recursive: true });
  await writeFile(join(root, 'references', 'linear.gbff'), genbank('linear', 'linear'), 'utf8');
  await writeFile(
    join(root, 'assembly.wpdesign.json'),
    `${JSON.stringify({
      schema: 'waypoint.design.v1',
      id: DESIGN_ID,
      constructId: PACKAGE_ID,
      sourceSequenceId: PACKAGE_ID,
      assembly: { method: 'golden-gate', circular: true },
    })}\n`,
    'utf8'
  );
  await writeNotebookFixture(root);

  await mkdir(join(root, 'many'), { recursive: true });
  for (let index = 0; index < 64; index += 1) {
    await writeFile(
      join(root, 'many', `part-${index.toString().padStart(3, '0')}.fasta`),
      `>part-${index}\nATGCGTAC\n`,
      'utf8'
    );
  }

  await mkdir(join(root, 'private-raw'), { recursive: true });
  for (const [index, extension] of ['fastq', 'bam', 'cram', 'vcf', 'ab1'].entries()) {
    await writeFile(join(root, 'private-raw', `excluded.${extension}`), RAW_CANARIES[index]!);
  }
}

async function writeNotebookFixture(root: string): Promise<void> {
  const title = 'Round trip notebook';
  const packageRoot = join(root, title);
  const canonical = serializeNotebookMarkdown({
    identity: { id: NOTEBOOK_ID, title, formatVersion: 2 },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'portable notebook' }] }],
    },
  });
  await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
  await writeFile(join(packageRoot, `${title}.md`), canonical.markdown, 'utf8');
  for (const payload of canonical.payloads) {
    await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
  }
  await writeFile(
    join(packageRoot, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id: NOTEBOOK_ID,
        title,
        markdownFileName: `${title}.md`,
        updatedAt: '2026-08-27T00:00:00.000Z',
      })
    ),
    'utf8'
  );
}

async function readScientificProjection(
  db: Database.Database,
  root: string
): Promise<ScientificProjection> {
  const allFiles = await walkRegularFiles(root);
  const sequences = [] as ScientificProjection['sequences'];
  const designs = [] as ScientificProjection['designs'];
  for (const path of allFiles) {
    if (path.endsWith('/.forge/plasmid.json')) {
      const document = parseSequencePackageDocument(await readFile(join(root, path), 'utf8'));
      sequences.push({
        id: document.id,
        packagePath: path.slice(0, -'/.forge/plasmid.json'.length),
        topology: document.product.topology ?? null,
        productFile: document.product.file,
        members: document.members
          .map((member) => ({ id: member.id, role: member.role, path: member.path }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      });
    }
    if (path.endsWith('.wpdesign.json')) {
      const parsed: unknown = JSON.parse(await readFile(join(root, path), 'utf8'));
      if (!isUnknownRecord(parsed)) throw new Error(`Design fixture is malformed: ${path}`);
      const assembly = parsed.assembly;
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.constructId !== 'string' ||
        typeof parsed.sourceSequenceId !== 'string'
      ) {
        throw new Error(`Design fixture identity is malformed: ${path}`);
      }
      if (
        !isUnknownRecord(assembly) ||
        typeof assembly.method !== 'string' ||
        typeof assembly.circular !== 'boolean'
      ) {
        throw new Error(`Design fixture assembly is malformed: ${path}`);
      }
      designs.push({
        id: parsed.id,
        constructId: parsed.constructId,
        sourceSequenceId: parsed.sourceSequenceId,
        assemblyMethod: assembly.method,
        circular: assembly.circular,
      });
    }
  }
  const notebooks = db
    .prepare(`SELECT id, title, content FROM pages ORDER BY id`)
    .all() as ScientificProjection['notebooks'];
  const notebookCatalog = db
    .prepare(
      `SELECT entity_id AS entityId, file_kind AS fileKind, status
       FROM catalog_entity_files
       WHERE file_kind = 'waypoint-notebook'
       ORDER BY entity_id, id`
    )
    .all() as ScientificProjection['notebookCatalog'];
  return {
    sequences: sequences.sort((left, right) => left.id.localeCompare(right.id)),
    notebooks,
    notebookCatalog,
    designs: designs.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function walkRegularFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walkRegularFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      result.push(relative(root, absolutePath).replaceAll('\\', '/'));
    }
  }
  return result.sort();
}

async function readExpectedMaterializedFiles(
  root: string,
  portable: WorkspaceSyncBundle
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const file of portable.files) {
    files.set(file.relativePath, await readFile(join(root, file.relativePath)));
  }
  return files;
}

async function readFixtureAdmittedFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const relativePath of await walkRegularFiles(root)) {
    if (relativePath.startsWith('private-raw/')) continue;
    files.set(relativePath, await readFile(join(root, relativePath)));
  }
  return files;
}

function validatePortableOrThrow(value: unknown): WorkspaceSyncBundle {
  const structural = validateWorkspaceSyncBundle(value);
  if (!structural.ok) throw new Error(structural.errors.join('; '));
  const policy = validateNewBundleFilePolicy(structural.bundle);
  if (!policy.ok) throw new Error(policy.errors.join('; '));
  return structural.bundle;
}

function seedWorkspace(
  db: Database.Database,
  root: string,
  id = 1,
  workspaceUuid = WORKSPACE_UUID
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, 'sync-roundtrip round trip', root, workspaceUuid);
}

function genbank(name: string, topology: 'circular' | 'linear' = 'linear'): string {
  return `LOCUS       ${name}  8 bp    DNA     ${topology}\nORIGIN\n        1 atgcgtac\n//\n`;
}
