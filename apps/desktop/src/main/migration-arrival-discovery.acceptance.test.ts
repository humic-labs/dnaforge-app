// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MarkdownNotebookImporter } from './markdown-notebook-import';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let importer: MarkdownNotebookImporter;
let writable: string[];
const changed = vi.fn();

beforeEach(async () => {
  fixture = createFileTestDb('migration-arrivals');
  ensureSchema(fixture.db, fixture.dbPath);
  root = await realpath(fixture.tmpDir);
  writable = [root];
  changed.mockReset();
  fixture.db.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,?,?,?,1)').run('Arrivals', root, 'arrival-project');
  const options: ConstructorParameters<typeof MarkdownNotebookImporter>[0] & {
    onMigrationCandidatesChanged(root: string): void;
  } = {
    db: () => fixture.db,
    roots: () => writable,
    captureWorkspace: () => () => {},
    withCleanPaths: async (_paths, operation) => operation(),
    onMigrationCandidatesChanged: changed,
    settleMs: 0,
  };
  importer = new MarkdownNotebookImporter(options);
});

afterEach(async () => {
  await importer.close();
  fixture.cleanup();
});

it('notifies the mounted owner when an external sequence or structure arrives, without converting it inside discovery', async () => {
  await importer.scan(root);
  expect(changed).not.toHaveBeenCalled();
  await mkdir(join(root, 'Agent outputs'));
  const sequence = join(root, 'Agent outputs', 'Arrival.gb');
  const structure = join(root, 'Agent outputs', 'Arrival.pdb');
  await writeFile(sequence, 'LOCUS       Arrival 12 bp DNA\nORIGIN\n        1 acgtacgtacgt\n//\n');
  await writeFile(structure, 'HEADER    Original external coordinate source\nEND\n');

  await importer.scan(root);

  expect(changed).toHaveBeenCalledWith(root);
  expect(await readFile(sequence, 'utf8')).toContain('acgtacgtacgt');
  expect(await readFile(structure, 'utf8')).toContain('Original external');
  const count = changed.mock.calls.length;
  await importer.scan(root);
  expect(changed).toHaveBeenCalledTimes(count);
  await writeFile(sequence, 'LOCUS       Arrival 16 bp DNA\nORIGIN\n        1 acgtacgtacgtacgt\n//\n');
  await importer.scan(root);
  expect(changed.mock.calls.length).toBeGreaterThan(count);
});

it('does not notify for retained compute inputs, existing package products, or a root that is no longer writable', async () => {
  await mkdir(join(root, 'Current', '.forge'), { recursive: true });
  await writeFile(join(root, 'Current', '.forge', 'plasmid.json'), '{"formatVersion":99}');
  await writeFile(join(root, 'Current', 'Product.gb'), 'Preserve future native package');
  await mkdir(join(root, 'compute', 'provider', 'job'), { recursive: true });
  await writeFile(join(root, 'compute', 'provider', 'job', 'Original.gb'), 'Retained result');
  await importer.scan(root);
  expect(changed).not.toHaveBeenCalled();
  writable = [];
  await writeFile(join(root, 'Readonly.gb'), 'Readonly original');
  await importer.scan(root);
  expect(changed).not.toHaveBeenCalled();
  expect(await readFile(join(root, 'Readonly.gb'), 'utf8')).toBe('Readonly original');
});
