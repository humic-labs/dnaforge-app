import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { WorkspaceTextFileAtomicWriteInput } from '../../shared/workspace-file-atomic';
import type { SourceObject } from '../../shared/benchling-migration';
import { buildProjectionPlan } from './projection';
import {
  publishNotebookPackageV2,
  readCanonicalNotebookPackage,
  type NotebookPackageFileOps,
} from '../../db/notebook-package-migration';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { NotebookDocumentModel } from '../../shared/notebook-model/document';
class MemoryFileOps implements NotebookPackageFileOps {
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return (
      this.files.has(path) ||
      [...this.files].some(([candidate]) => candidate.startsWith(`${path}/`))
    );
  }

  async mkdir(): Promise<void> {}

  async readTextFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = await this.readTextFile(oldPath);
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }

  async readDir(path: string) {
    const prefix = `${path}/`;
    const names = new Map<string, boolean>();
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      const [name, ...rest] = remainder.split('/');
      if (name) names.set(name, rest.length === 0);
    }
    return [...names.entries()].map(([name, isFile]) => ({
      name,
      isFile,
      isDirectory: !isFile,
      isSymbolicLink: false,
    }));
  }

  async removeFile(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  async writeWorkspaceTextFileAtomic(input: WorkspaceTextFileAtomicWriteInput) {
    const current = this.files.get(input.path);
    if (input.mode === 'create') {
      if (current !== undefined) throw new Error('already exists');
    } else {
      const currentHash = createHash('sha256')
        .update(current ?? '', 'utf8')
        .digest('hex');
      if (current === undefined || currentHash !== input.expectedContentHash) {
        throw new Error('changed since it was opened');
      }
    }
    this.files.set(input.path, input.content);
    return {
      path: input.path,
      contentHash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    };
  }
}

const marker = ' PUBLIC_FIRST_SAVE_MARKER';
const syntheticText = 'Synthetic first-save marker paragraph';
const html =
  '<html><body>' +
  Array.from({ length: 155 }, (_, index) =>
    index === 1
      ? `<p>${syntheticText}</p>`
      : index === 2
        ? '<table><tbody><tr><td>Scientific value 42</td></tr></tbody></table>'
        : index % 3 === 0
          ? `<ul><li>Item ${index}</li></ul>`
          : `<p>Public body ${index}</p>`
  ).join('') +
  '</body></html>';
const synthetic: SourceObject = {
  id: 'etr_PublicFirstSave',
  stableId: 'etr_PublicFirstSave',
  sourceType: 'notebook_entry',
  name: 'Public first-save notebook',
  aliases: [],
  sourceUrl: 'https://benchling.com/example/etr_PublicFirstSave',
  attachmentHashes: [],
  memberships: [],
  metadata: {},
  content: { html, attachments: [] },
  relationships: [],
};
async function importThenFirstSave(source: SourceObject, text: string) {
  const plan = buildProjectionPlan(source, {
    runId: 'raw-first-save',
    capturedAt: '2026-11-06T00:00:00.000Z',
    converterVersion: 'independent-raw-fidelity',
    destination: {
      kind: 'package',
      rootRelativePath: 'Notebook',
      primaryRelativePath: 'Notebook/.forge/notebook.json',
    },
    destinationEntityId: 'raw-first-save-notebook',
  });
  expect(plan.projection).toBe('native');
  const fs = new MemoryFileOps();
  for (const file of plan.files)
    fs.files.set(
      '/workspace/' + file.relativePath,
      file.bytes === undefined ? file.text : Buffer.from(file.bytes).toString('utf8')
    );
  const root = '/workspace/Notebook';
  const before = await readCanonicalNotebookPackage(fs, root);
  expect(before.parsed.content.content?.length).toBe(155);
  const expected = structuredClone(before.parsed.content);
  const index = expected.content?.findIndex(
    (block) =>
      block.type === 'paragraph' && block.content?.map((node) => node.text ?? '').join('') === text
  );
  assert(index !== undefined && index >= 0);
  const block = expected.content?.[index];
  assert(block?.content?.length);
  const last = block.content.at(-1);
  assert(last && typeof last.text === 'string');
  last.text += marker;
  const model = new NotebookDocumentModel(before.parsed.content, before.parsed.title);
  model.execute({ kind: 'splice-blocks', index, deleteCount: 1, blocks: [block] });
  model.applySteps([]);
  await publishNotebookPackageV2(fs, {
    packageRoot: root,
    workspaceRoot: '/workspace',
    id: before.metadata.id,
    title: before.parsed.title,
    content: model.content,
    sourceShape: 'v2-package',
    existingMetadataRaw: fs.files.get(root + '/.forge/notebook.json'),
    expectedCanonicalFingerprint: contentFingerprint(before.markdown),
  });
  const after = await readCanonicalNotebookPackage(fs, root);
  console.info(
    JSON.stringify({
      event: 'first-save-raw-canonical-comparison',
      beforeBlocks: before.parsed.content.content?.length,
      afterBlocks: after.parsed.content.content?.length,
      expectedSha256: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
      actualSha256: createHash('sha256').update(JSON.stringify(after.parsed.content)).digest('hex'),
    })
  );
  expect(after.parsed.content).toEqual(expected);
}
it('preserves the entire raw canonical document except the intended marker on first Save after a generated public155-block import', async () => {
  await importThenFirstSave(synthetic, syntheticText);
});
