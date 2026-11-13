// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
} from './notebook-document-owner';
import type { NotebookDocumentSnapshot } from '../shared/notebook-document';

it.each(['private', 'public'] as const)(
  'publishes a %s creation only after native publication settles',
  async (route) => {
    const snapshot = {
      documentId: 'book',
      pageId: 'book',
      path: '/project/Book',
      workspaceRoot: '/project',
      title: 'Book',
      dirty: false,
      copy: { content: { type: 'doc', content: [] } },
      tableViews: {},
    } as NotebookDocumentSnapshot;
    const publication = Promise.withResolvers<NotebookDocumentSnapshot>();
    const owner = new NativeNotebookWorkingCopyOwner({
      create: () => publication.promise,
    } as NativeNotebookOptions);
    const changed = vi.fn();
    owner.subscribe(changed);
    const pending =
      route === 'private'
        ? owner.create({ title: 'Book', workspaceRoot: '/project', requestId: 'creation' })
        : owner.executePublic({
            operation: { kind: 'create', title: 'Book', destinationProject: '/project' },
            requestId: 'creation',
          });
    expect(changed).not.toHaveBeenCalled();
    publication.resolve(snapshot);
    await pending;
    expect(changed).toHaveBeenCalledExactlyOnceWith(snapshot);
  }
);
