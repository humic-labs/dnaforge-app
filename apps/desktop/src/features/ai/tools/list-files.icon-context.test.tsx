import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../main/__tests__/test-db';
import { ensureSchema } from '../../../main/schema';
import { ToolResultDisplay } from '../../../components/chat/ToolResultDisplay';
import { createListFilesTool } from './list-files';
import { execTool } from './test-helpers';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  readDir: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { readDir: state.readDir },
    db: {
      select: async (sql: string, params: unknown[] = []) => state.db!.prepare(sql).all(...params),
    },
  }),
}));
vi.mock('../../sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    openPackage: vi.fn().mockResolvedValue(null),
    findByMemberPath: vi.fn().mockResolvedValue(null),
  },
}));

const artifacts = [
  { id: 'rna-oligo', kind: 'rna_oligo', type: 'primer', name: 'RNA_oligo.primer.json', family: 'rna' },
  { id: 'native-protein', kind: 'protein', type: 'record', name: 'Native_protein.entity.json', family: 'protein' },
] as const;

beforeEach(() => {
  state.db = createTestDb();
  ensureSchema(state.db, ':memory:');
  state.db.prepare(
    `INSERT INTO workspaces (id,name,path,created_at,last_opened_at) VALUES (1,'Lab','/lab',0,0)`
  ).run();
  state.db.prepare(
    `INSERT INTO lims_schema (id,kind,name,display_name,fields,created_at,updated_at)
     VALUES ('schema','entity','icon-test','Icon test','[]',0,0)`
  ).run();
  state.db.prepare(
    `INSERT INTO lims_schema_revision (id,schema_id,version,fields,created_at)
     VALUES ('revision','schema',1,'[]',0)`
  ).run();
  for (const artifact of artifacts) {
    state.db.prepare(
      `INSERT INTO catalog_entities
         (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
       VALUES (?,?,?,?,'file','active',1,NULL,0,0)`
    ).run(artifact.id, artifact.type, artifact.name, `entity://test/${artifact.id}`);
    state.db.prepare(
      `INSERT INTO catalog_entity_files
         (id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
       VALUES (?,?,1,?,'native-artifact','current',0,0)`
    ).run(artifact.id, artifact.id, `/lab/${artifact.name}`);
    state.db.prepare(
      `INSERT INTO lims_entity
         (id,kind,schema_revision_id,name,fields,registration_status,created_at,updated_at)
       VALUES (?,?,'revision',?,'{}','tracked',0,0)`
    ).run(artifact.id, artifact.kind, artifact.name);
  }
  state.readDir.mockReset().mockResolvedValue(
    artifacts.map((artifact) => ({ name: artifact.name, isDirectory: false, isFile: true }))
  );
});

afterEach(() => state.db?.close());

describe('native artifact list_files icon transport', () => {
  it.each(artifacts)('retains $kind from its current binding with null catalog metadata', async (artifact) => {
    const output = await execTool<{ entries: Array<{ name: string; iconContext?: { kind?: string } }> }>(
      createListFilesTool([{ name: 'Lab', path: '/lab', addedAt: 1 }]),
      {}
    );
    render(createElement(ToolResultDisplay, {
      toolName: 'list_files',
      content: JSON.stringify({ input: {}, output }),
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(artifact.name).parentElement?.querySelector('svg')).toHaveAttribute(
      'data-entity-color-family', artifact.family
    );
    expect(output.entries.find((entry) => entry.name === artifact.name)?.iconContext?.kind).toBe(artifact.kind);
  });
});
