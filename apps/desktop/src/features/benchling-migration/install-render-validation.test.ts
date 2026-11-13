import { serializeGenBank, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
  type MigrationRenderValidationItem,
  type MigrationRenderValidationRequest,
} from '../../shared/benchling-migration-render-validation';
import { validateMigrationRenderRequest } from './install-render-validation';
import { buildNotebookPackageMetadata } from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('migration destination renderer probe', () => {
  it.each([false, true])(
    'validates canonical Markdown instead of an empty metadata projection (damaged=%s)',
    async (damaged) => {
      const files = fixtureFiles();
      const request = requestFor(files);
      const identity = { id: 'notebook-1', title: 'Notebook', formatVersion: 2 };
      files.set(
        '/ws/Notebook/.forge/notebook.json',
        JSON.stringify(
          buildNotebookPackageMetadata({ ...identity, markdownFileName: 'Notebook.md' })
        )
      );
      const serialized = serializeNotebookMarkdown({
        identity,
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Actual notebook body' }] },
          ],
        },
        roots: { workspaceRoot: '/ws', packageRoot: '/ws/Notebook' },
      });
      for (const payload of serialized.payloads)
        files.set(`/ws/Notebook/${payload.relativePath}`, payload.content);
      const mismatchedIdentity = serialized.markdown.replace(
        '"id":"notebook-1"',
        '"id":"different-notebook"'
      );
      if (mismatchedIdentity === serialized.markdown)
        throw new Error('Canonical notebook fixture identity was not found.');
      files.set('/ws/Notebook/Notebook.md', damaged ? mismatchedIdentity : serialized.markdown);
      request.items = request.items.filter((item) => item.sourceObjectId === 'source-notebook');
      const response = await validateMigrationRenderRequest(request, { fs: fixtureFs(files) });
      expect(response.checks[0].passed, JSON.stringify(response.checks[0])).toBe(!damaged);
    }
  );

  it('opens a catalog-only record through the native resolver without reading a file', async () => {
    const fs = { readFile: vi.fn(), readTextFile: vi.fn() };
    const request = {
      ...requestFor(fixtureFiles()),
      items: [
        {
          sourceObjectId: 'strain-source',
          destinationObjectId: 'strain-destination',
          projection: 'native',
          converterId: 'benchling-native-v1',
          surface: 'lims_registry',
          catalogRecord: {
            kind: 'strain',
            name: 'Native strain',
            fields: {},
          },
        },
      ],
    } satisfies MigrationRenderValidationRequest;
    const response = await validateMigrationRenderRequest(request, { fs });
    expect(response.checks).toEqual([
      { sourceObjectId: 'strain-source', surface: 'lims_registry', passed: true },
    ]);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it('rejects a catalog sequence that resolves to a file surface', async () => {
    const fs = { readFile: vi.fn(), readTextFile: vi.fn() };
    const request: MigrationRenderValidationRequest = {
      ...requestFor(fixtureFiles()),
      items: [
        {
          sourceObjectId: 'catalog-sequence',
          destinationObjectId: 'catalog-id',
          projection: 'native',
          converterId: 'native-v2',
          surface: 'lims_registry',
          catalogRecord: {
            kind: 'dna_sequence',
            name: 'Not a catalog record',
            fields: {
              sequence: {
                mode: 'file',
                documentId: 'file-id',
                relPath: 'sequence.gb',
                topology: 'linear',
                length: 4,
              },
            },
          },
        },
      ],
    };
    const response = await validateMigrationRenderRequest(request, { fs });
    expect(response.checks[0].passed).toBe(false);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.readTextFile).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'validates custom record fields against their portable schema (malformed=%s)',
    async (malformed) => {
      const fs = { readFile: vi.fn(), readTextFile: vi.fn() };
      const request: MigrationRenderValidationRequest = {
        ...requestFor(fixtureFiles()),
        items: [
          {
            sourceObjectId: 'custom-source',
            destinationObjectId: 'custom-destination',
            projection: 'native',
            converterId: 'benchling-native-registry-v1',
            surface: 'lims_registry',
            catalogRecord: {
              kind: 'custom_reagent',
              name: 'Reagent',
              fields: { amount: malformed ? 'invalid number' : 0 },
              schemaSnapshot: {
                schemaId: 'custom-reagent-schema',
                schemaRevisionId: 'custom-reagent-v1',
                name: 'custom_reagent',
                displayName: 'Reagent',
                baseKind: 'record',
                version: 1,
                fields: [
                  { key: 'amount', label: 'Amount', type: 'number' },
                  { key: 'missing', label: 'Missing source value', type: 'text', required: true },
                ],
              },
            },
          },
        ],
      };
      const response = await validateMigrationRenderRequest(request, { fs });
      expect(response.checks[0]?.passed, JSON.stringify(response.checks)).toBe(!malformed);
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(fs.readTextFile).not.toHaveBeenCalled();
    }
  );

  it('uses product parsers for every supported migration surface exactly once', async () => {
    const files = fixtureFiles();
    const renderSandboxedHtml = vi.fn(async () => undefined);
    const response = await validateMigrationRenderRequest(requestFor(files), {
      fs: fixtureFs(files),
      renderSandboxedHtml,
    });

    expect(response.checks).toHaveLength(7);
    expect(new Set(response.checks.map((check) => check.sourceObjectId)).size).toBe(7);
    expect(response.checks.every((check) => check.passed)).toBe(true);
    expect(renderSandboxedHtml).toHaveBeenCalledOnce();
  });

  it('returns an isolated blocking check when a product parser rejects content', async () => {
    const files = fixtureFiles();
    files.set('/ws/Notebook/.forge/notebook.json', '{"schema":"wrong"}');
    const response = await validateMigrationRenderRequest(requestFor(files), {
      fs: fixtureFs(files),
      renderSandboxedHtml: async () => undefined,
    });
    expect(response.checks.find((check) => check.sourceObjectId === 'source-notebook')).toEqual(
      expect.objectContaining({ passed: false })
    );
    expect(response.checks.filter((check) => check.passed)).toHaveLength(6);
  });

  it('accepts the current fallback projection when its exception badge is present', async () => {
    const files = fixtureFiles();
    const request = requestFor(files);
    const artifact = request.items.find((item) => item.sourceObjectId === 'source-artifact');
    if (!artifact) throw new Error('Missing artifact fixture.');
    artifact.projection = 'fallback';

    const response = await validateMigrationRenderRequest(request, {
      fs: fixtureFs(files),
      renderSandboxedHtml: async () => undefined,
    });

    expect(response.checks.find((check) => check.sourceObjectId === 'source-artifact')).toEqual({
      sourceObjectId: 'source-artifact',
      surface: 'artifact',
      passed: true,
    });
  });

  it('validates in bounded parallel while preserving deterministic check order', async () => {
    const files = new Map(
      Array.from({ length: 40 }, (_, index) => [`/ws/text-${index}.txt`, `Text ${index}`] as const)
    );
    const fs = fixtureFs(files);
    let activeReads = 0;
    let maximumConcurrentReads = 0;
    const response = await validateMigrationRenderRequest(textRequest(files.size), {
      fs: {
        ...fs,
        async readTextFile(path) {
          activeReads += 1;
          maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
          try {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            return await fs.readTextFile(path);
          } finally {
            activeReads -= 1;
          }
        },
      },
      renderSandboxedHtml: async () => undefined,
    });

    expect(maximumConcurrentReads).toBe(16);
    expect(activeReads).toBe(0);
    expect(response.checks.map((check) => check.sourceObjectId)).toEqual(
      Array.from({ length: files.size }, (_, index) => `source-text-${index}`)
    );
  });
});

function fixtureFiles(): Map<string, string> {
  const sequence: AnnotatedSequence = {
    id: 'sequence-1',
    name: 'sequence-1',
    sequence: 'ATGCGT',
    length: 6,
    circular: false,
    annotations: [],
  };
  const registry = {
    version: 2,
    kind: 'waypoint.benchling-registry-projection',
    converterId: 'benchling-registry-v1',
    converterVersion: '1',
    organizationId: 'org-yale',
    capturedAt: '2026-07-18T00:00:00.000Z',
    destinationWorkspaceId: 'workspace-1',
    schemas: [
      {
        sourceRevisionId: 'source-revision-1',
        destinationSchemaId: 'destination-schema-1',
        destinationSchemaRevisionId: 'destination-revision-1',
        materialization: {
          defineSchema: {
            id: 'destination-schema-1',
            fields: [
              {
                key: 'benchling_source_object_id',
                label: 'Benchling source object ID',
                type: 'text',
                required: true,
              },
            ],
          },
        },
      },
    ],
    relationshipTypes: [],
    records: [
      {
        sourceObjectId: 'source-registry',
        destinationEntityId: 'destination-registry',
        sourceSchemaRevisionId: 'source-revision-1',
        desiredRegistryId: 'REG-1',
        materialization: {
          registerEntity: {
            id: 'destination-registry',
            kind: 'plasmid',
            name: 'Migrated registry record',
            schemaRevisionId: 'destination-revision-1',
            registrationStatus: 'registered',
            fields: { benchling_source_object_id: 'source-registry' },
          },
        },
      },
    ],
    excludedSources: [],
  };
  return new Map([
    ['/ws/sequence.gb', serializeGenBank(sequence)],
    [
      '/ws/Notebook/.forge/notebook.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'notebook-1',
        title: 'Notebook',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'content' }] }],
        },
      }),
    ],
    ['/ws/Benchling Imports/Proteins/protein.faa', '>protein-1 Protein\nMKT\n'],
    [
      '/ws/artifact.md',
      '# Unsupported object\n\n> **Native conversion exception**\n\nPreserved content.\n',
    ],
    ['/ws/report.html', '<!doctype html><html><body>Report</body></html>'],
    ['/ws/readme.txt', 'Plain text content.'],
    ['/ws/registry.json', JSON.stringify(registry)],
  ]);
}

function requestFor(files: Map<string, string>): MigrationRenderValidationRequest {
  const items: MigrationRenderValidationItem[] = [
    item('source-sequence', 'destination-sequence', 'sequence.gb', 'sequence'),
    item('source-notebook', 'destination-notebook', 'Notebook/.forge/notebook.json', 'notebook'),
    item(
      'source-protein',
      'destination-protein',
      'Benchling Imports/Proteins/protein.faa',
      'protein'
    ),
    {
      ...item('source-artifact', 'destination-artifact', 'artifact.md', 'artifact'),
      projection: 'artifact',
      converterId: 'benchling-artifact-card',
    },
    item('source-html', 'destination-html', 'report.html', 'html'),
    item('source-text', 'destination-text', 'readme.txt', 'text'),
    {
      ...item('source-registry', 'destination-registry', 'registry.json', 'lims_registry'),
      converterId: 'benchling-registry-v1',
    },
  ];
  expect(files.size).toBe(items.length);
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId: REQUEST_ID,
    runId: 'migration-run-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/ws',
    items,
  };
}

function textRequest(count: number): MigrationRenderValidationRequest {
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId: REQUEST_ID,
    runId: 'migration-run-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/ws',
    items: Array.from({ length: count }, (_, index) =>
      item(`source-text-${index}`, `destination-text-${index}`, `text-${index}.txt`, 'text')
    ),
  };
}

function item(
  sourceObjectId: string,
  destinationObjectId: string,
  destinationPath: string,
  surface: MigrationRenderValidationItem['surface']
): MigrationRenderValidationItem {
  return {
    sourceObjectId,
    destinationObjectId,
    destinationPath,
    projection: 'native',
    converterId: `converter-${surface}`,
    surface,
  };
}

function fixtureFs(files: Map<string, string>) {
  return {
    async readTextFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing fixture ${path}`);
      return content;
    },
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing fixture ${path}`);
      return new TextEncoder().encode(content);
    },
    async stat(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing fixture ${path}`);
      return { size: new TextEncoder().encode(content).byteLength, isFile: true } as never;
    },
  };
}
