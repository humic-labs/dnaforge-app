import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ToolExecutionOptions } from 'ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db';
import { rememberOriginalDefaultProject } from '../original-default-project';
import { ensureSchema } from '../schema';
import {
  getLimsRegistryPreviewInDb,
  linkLimsEntitiesInDb,
  queryLimsEntitiesInDb,
  queryLimsRegistrySummariesInDb,
  registerLimsEntityInDb,
} from '../lims';
import { assertMcpOutput } from '../../test-utils/mcp-output-test-helper';

async function execTool<Args>(
  tool: { execute?: (args: Args, options: ToolExecutionOptions) => unknown },
  args: Args
): Promise<unknown> {
  if (!tool.execute) throw new Error('Tool has no executor.');
  return tool.execute(args, { toolCallId: 'registry-output-contract', messages: [] });
}

const operations = vi.hoisted(() => ({
  queryLimsEntities: vi.fn(),
  queryLimsRegistrySummaries: vi.fn(),
  getLimsRegistryPreview: vi.fn(),
}));
vi.mock('../../features/lims/operations', () => operations);
vi.mock('../../features/lims/open-entity', () => ({ openLimsEntity: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));
import {
  limsQueryEntitiesTool,
  limsQueryEntitiesOutputSchema,
  limsQueryRegistrySummariesTool,
  limsQueryRegistrySummariesOutputSchema,
  limsGetRegistryPreviewTool,
  limsGetRegistryPreviewOutputSchema,
  limsGetEntityTool,
  limsGetEntityOutputSchema,
  limsResolveOpenTargetTool,
  limsResolveOpenTargetOutputSchema,
} from '../../features/ai/tools/lims';

let db: Database.Database;
let projectRoot: string;
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  projectRoot = mkdtempSync(join(tmpdir(), 'lims-agent-contracts-'));
  db.prepare(
    "INSERT INTO workspaces (id, name, path, repo_uuid, created_at, access_mode) VALUES (1, 'My Project', ?, 'original-project', 1, 'writable')"
  ).run(projectRoot);
  rememberOriginalDefaultProject(db, 1);
  operations.queryLimsEntities.mockImplementation(async (input) =>
    queryLimsEntitiesInDb(db, input)
  );
  operations.queryLimsRegistrySummaries.mockImplementation(async (input) =>
    queryLimsRegistrySummariesInDb(db, input)
  );
  operations.getLimsRegistryPreview.mockImplementation(async (input) =>
    getLimsRegistryPreviewInDb(db, input)
  );
});
afterEach(() => {
  db.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('real registry read models satisfy external MCP output contracts', () => {
  it('projects linked SQLite records through canonical read factories and the MCP client validator', async () => {
    const oligo = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'Synthetic primer',
      fields: {
        sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
        use: 'primer',
      },
    });
    const strain = registerLimsEntityInDb(db, {
      kind: 'strain',
      name: 'Synthetic strain',
      fields: { genotype: 'test' },
    });
    linkLimsEntitiesInDb(db, {
      fromEntityId: oligo.id,
      toEntityId: strain.id,
      type: 'associated_with',
      payload: { note: 'fixture' },
    });
    const query = await execTool(limsQueryEntitiesTool, {});
    assertMcpOutput(limsQueryEntitiesOutputSchema, query);
    const summaries = await execTool(limsQueryRegistrySummariesTool, {});
    assertMcpOutput(limsQueryRegistrySummariesOutputSchema, summaries);
    const preview = await execTool(limsGetRegistryPreviewTool, { entityId: strain.id });
    assertMcpOutput(limsGetRegistryPreviewOutputSchema, preview);
    expect(preview).toMatchObject({
      ok: true,
      incomingLinks: [{ entity: { id: oligo.id } }],
      strainGenomeSummary: { strain: { id: strain.id } },
    });
    const entity = await execTool(limsGetEntityTool, { entityId: oligo.id });
    assertMcpOutput(limsGetEntityOutputSchema, entity);
    const target = await execTool(limsResolveOpenTargetTool, { entityId: oligo.id });
    assertMcpOutput(limsResolveOpenTargetOutputSchema, target);
    expect(target).toMatchObject({
      ok: true,
      target: { kind: 'record_detail', reason: 'inline_sequence' },
    });
  });
});
