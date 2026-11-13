import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';
import {
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from '../../../db/notebook-markdown-codec';
import { getBaseExtensions, MentionExtension } from './extensions';
import {
  molecularDocumentReferenceHref,
  molecularDocumentReferenceRecord,
  type MolecularDocumentReference,
} from '../../../shared/molecular-document-reference';

const mocks = vi.hoisted(() => ({
  getEntityReference: vi.fn(),
  navigateToReference: vi.fn(),
}));

vi.mock('../../../db/entity-references', () => ({
  getEntityReference: mocks.getEntityReference,
}));
vi.mock('../../ai/public/navigate-to-reference', () => ({
  navigateToReference: mocks.navigateToReference,
}));

import {
  openSavedMolecularViewLink,
  openNotebookReferenceLink,
  savedMolecularViewReferenceIdFromHref,
} from './saved-molecular-view-link';

const id = 'e18c3ba4-9448-4589-8309-710c13a0261b';
const href = `dnaforge-chat://reference/${id}`;

describe('saved molecular views in notebooks', () => {
  it.each(['sequence', 'sequence_region', 'primer', 'assembly', 'notebook'])(
    'opens a typed %s reference with its recorded owner and interval',
    async (entity_type) => {
      const reference = {
        id,
        entity_type,
        workspace_root_path: '/mounted/source-project',
        locator: 'entity://sequence/stable-document-id',
        deep_link_params: JSON.stringify({ start: 349347, end: 351697 }),
      };
      mocks.getEntityReference.mockResolvedValue(reference);
      await openNotebookReferenceLink(href, 'target-notebook');
      expect(mocks.navigateToReference).toHaveBeenCalledWith(reference, {
        sourceNotebookPageId: 'target-notebook',
      });
    }
  );
  beforeEach(() => {
    mocks.getEntityReference.mockReset();
    mocks.navigateToReference.mockReset();
  });

  it('round-trips a saved-view link as a native reference through Markdown and the page editor schema', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Open view', marks: [{ type: 'link', attrs: { href } }] },
          ],
        },
      ],
    };
    const markdown = serializeNotebookMarkdown({
      identity: { id: 'benchmark', title: 'Benchmarks', formatVersion: 2 },
      content,
    });
    const restored = parseNotebookMarkdown({
      markdown: markdown.markdown,
      payloads: new Map(
        markdown.payloads.map((payload) => [payload.relativePath, payload.content])
      ),
    }).content;
    const schema = getSchema([...getBaseExtensions(), MentionExtension] as never);
    const node = schema.nodeFromJSON(restored);
    const reference = node.firstChild?.firstChild;
    expect(reference?.type.name).toBe('mention');
    expect(reference?.attrs).toMatchObject({ referenceUri: href, label: 'Open view' });
    expect(reference?.marks.some((mark) => mark.type.name === 'link')).toBe(false);
    expect(savedMolecularViewReferenceIdFromHref(reference?.attrs.referenceUri)).toBe(id);
  });

  it('opens only a valid molecular-view snapshot beside its source notebook', async () => {
    const ref = {
      id,
      entity_type: 'structure',
      locator: `entity://structure/saved-view:${id}`,
      data: JSON.stringify({
        kind: 'molecular-view',
        version: 1,
        title: 'Saved view',
        caption: '',
        scene: '{}',
        coordinates: { format: 'pdb', text: 'HEADER\n', sha256: '0'.repeat(64) },
        source: {},
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      }),
    };
    mocks.getEntityReference.mockResolvedValue(ref);
    mocks.navigateToReference.mockResolvedValue({ panelId: 'right', tabType: 'structure' });

    await expect(openSavedMolecularViewLink(href, 'page-1')).resolves.toEqual({
      panelId: 'right',
      tabType: 'structure',
    });
    expect(mocks.navigateToReference).toHaveBeenCalledWith(ref, {
      sourceNotebookPageId: 'page-1',
    });
  });

  it('rejects absent, unrelated, and malformed references', async () => {
    expect(savedMolecularViewReferenceIdFromHref('https://example.org')).toBeNull();
    expect(
      savedMolecularViewReferenceIdFromHref('dnaforge-chat://reference/not-a-uuid')
    ).toBeNull();
    mocks.getEntityReference.mockResolvedValue(null);
    await expect(openSavedMolecularViewLink(href, 'page-1')).rejects.toThrow('no longer exists');
    mocks.getEntityReference.mockResolvedValue({
      id,
      entity_type: 'sequence',
      locator: 'entity://sequence/unrelated',
      data: null,
    });
    await expect(openSavedMolecularViewLink(href, 'page-1')).rejects.toThrow('molecular view');
    expect(mocks.navigateToReference).not.toHaveBeenCalled();
  });

  it.each([undefined, 'peptide'])(
    'opens an exact view or selection link from its notebook',
    async (groupId) => {
      const ref = {
        id,
        entity_type: 'structure',
        locator: `entity://molecular-view-target/10000000-0000-4000-8000-000000000001/1/${groupId ?? 'view'}`,
        data: JSON.stringify({
          kind: 'molecular-view-target',
          version: 1,
          viewReferenceId: '10000000-0000-4000-8000-000000000001',
          snapshotIndex: 1,
          ...(groupId ? { groupId } : {}),
        }),
      };
      mocks.getEntityReference.mockResolvedValue(ref);
      await openSavedMolecularViewLink(href, 'page-1');
      expect(mocks.navigateToReference).toHaveBeenCalledWith(ref, {
        sourceNotebookPageId: 'page-1',
      });
    }
  );

  it('opens a canonical document link without requiring a cached reference row', async () => {
    const document: MolecularDocumentReference = {
      kind: 'molecular-document',
      version: 1,
      projectId: 'project',
      documentId: '10000000-0000-4000-8000-000000000001',
      revisionId: id,
      revisionSha256: 'a'.repeat(64),
      viewId: 'overview',
    };
    await openSavedMolecularViewLink(molecularDocumentReferenceHref(document), 'page-1');
    expect(mocks.getEntityReference).not.toHaveBeenCalled();
    expect(mocks.navigateToReference).toHaveBeenCalledWith(
      molecularDocumentReferenceRecord(document, 'Molecular document'),
      { sourceNotebookPageId: 'page-1' }
    );
  });
});
