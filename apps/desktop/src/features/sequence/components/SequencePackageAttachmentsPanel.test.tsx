/** @vitest-environment jsdom */
import { userMessage } from '@waypoint/user-messages';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
  type SequencePackageRevision,
} from '../../../db/sequence-package';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';
import { SequencePackageAttachmentsPanel } from './SequencePackageAttachmentsPanel';
import { SequencePackageHistoryPanel } from './SequencePackageHistoryPanel';
import { registerWorkspaceEditorBlocker } from '../../../services/workspace-editor-mutation-state';

const fs = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  sha256File: vi.fn(),
  readFileBounded: vi.fn(),
  publishSequenceUserAttachmentMutation: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../platform', () => ({ platform: () => ({ fs, dialog }) }));

const PRODUCT_SHA = `sha256:${'a'.repeat(64)}`;
const USER_SHA = `sha256:${'b'.repeat(64)}`;

function fixture(withAttachment = false, unattested = false) {
  const original = buildSequencePackageDocument({
    id: 'package-one',
    name: 'Package one',
    product: { file: 'package.gb' },
  });
  const userAttachments = withAttachment
    ? { note: { memberId: 'user-member', sha256: unattested ? null : USER_SHA } }
    : {};
  const revision: SequencePackageRevision = {
    id: 'current-revision',
    parentId: null,
    operationId: 'current-revision',
    kind: 'sequence-save',
    createdAt: '2026-01-01T00:00:00.000Z',
    productSnapshot: { path: 'contents/sequence-snapshot-test.gb', sha256: PRODUCT_SHA },
    state: {
      name: original.name,
      product: original.product,
      entity: original.entity,
      acceptedAssembly: null,
      userAttachments,
    },
  };
  const document = buildSequencePackageDocument({
    id: original.id,
    name: original.name,
    product: original.product,
    members: [
      {
        id: 'product-snapshot',
        role: 'sequence-snapshot',
        path: revision.productSnapshot.path,
        replaceable: false,
        createdAt: revision.createdAt,
      },
      ...(withAttachment
        ? [
            {
              id: 'user-member',
              role: 'user',
              path: 'contents/user-note.bin',
              replaceable: false,
              createdAt: revision.createdAt,
            },
          ]
        : []),
    ],
    userAttachments,
    versionHistory: {
      schema: 'waypoint.sequence-history.v1',
      headId: revision.id,
      revisions: [revision],
    },
  });
  const history: SequencePackageHistoryView = {
    index: {
      document,
      packageRoot: '/workspace/package',
      markerPath: '/workspace/package/.forge/plasmid.json',
      productPath: '/workspace/package/package.gb',
      legacyCurrentHasNoSnapshot: false,
      currentProductStatus: 'verified',
    },
    workspaceRoot: '/workspace',
    selectedRevisionId: null,
    selectedSequence: null,
    selectedParentSequence: null,
    selectedParentStatus: 'none',
    isLoading: false,
    error: null,
    selectRevision: vi.fn(),
    refresh: vi.fn(),
  };
  return { history, marker: serializeSequencePackageDocument(document) };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  fs.readTextFile.mockReset();
  fs.sha256File.mockReset();
  fs.readFileBounded.mockReset();
  fs.publishSequenceUserAttachmentMutation.mockReset();
  dialog.open.mockReset();
});

function admit(marker: string, sourceBytes = new Uint8Array([0, 255, 7])) {
  fs.readTextFile.mockResolvedValue(marker);
  fs.readFileBounded.mockResolvedValue(sourceBytes);
  const sourceDigest = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
  fs.sha256File.mockImplementation(async (path: string) =>
    path === '/workspace/package/package.gb' ? PRODUCT_SHA : sourceDigest
  );
  fs.publishSequenceUserAttachmentMutation.mockResolvedValue({
    revisionId: 'attachment-revision',
    alreadyPublished: false,
    snapshotPaths: [],
    assetPaths: [],
  });
  return sourceDigest;
}

describe('managed sequence package attachments', () => {
  it('clears an attachment preview when its package owner changes', async () => {
    const { history, marker } = fixture(true);
    admit(marker);
    dialog.open.mockResolvedValue('/external/new-note.bin');
    const restore = {
      workspaceRoot: '/workspace',
      isDirty: false,
      savePending: vi.fn(async () => true),
      discardPending: vi.fn(() => true),
      apply: vi.fn(async () => {}),
    };
    const { rerender } = render(
      <SequencePackageHistoryPanel history={history} restore={restore} />
    );
    fireEvent.click(
      within(screen.getByTestId('attachment-note')).getByRole('button', { name: 'Replace' })
    );
    await screen.findByTestId('attachment-preview');
    rerender(
      <SequencePackageHistoryPanel history={{ ...history, index: null, isLoading: true }} />
    );
    expect(screen.getByRole('button', { name: 'Confirm attachment change' })).toBeDisabled();
    const next = {
      ...history,
      index: history.index
        ? {
            ...history.index,
            document: { ...history.index.document, id: 'another-package' },
            packageRoot: '/workspace/another-package',
          }
        : null,
    };
    rerender(<SequencePackageHistoryPanel history={next} restore={restore} />);
    expect(screen.queryByTestId('attachment-preview')).toBeNull();
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
  });

  it.each(['saved', 'refused'] as const)(
    'retains a pending replace across History reload and access checking until it is %s',
    async (outcome) => {
      const { history, marker } = fixture(true);
      admit(marker);
      dialog.open.mockResolvedValue('/external/new-note.bin');
      const receipt = {
        revisionId: 'replacement-revision',
        alreadyPublished: false,
        snapshotPaths: [],
        assetPaths: [],
      };
      const publication = Promise.withResolvers<typeof receipt>();
      fs.publishSequenceUserAttachmentMutation.mockReturnValue(publication.promise);
      const restore = {
        workspaceRoot: '/workspace',
        isDirty: false,
        savePending: vi.fn(async () => true),
        discardPending: vi.fn(() => true),
        apply: vi.fn(async () => {}),
      };
      const { rerender } = render(
        <SequencePackageHistoryPanel history={history} restore={restore} />
      );
      try {
        fireEvent.click(
          within(screen.getByTestId('attachment-note')).getByRole('button', { name: 'Replace' })
        );
        await screen.findByTestId('attachment-preview');
        fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
        await waitFor(() =>
          expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledOnce()
        );
        rerender(
          <SequencePackageHistoryPanel history={{ ...history, index: null, isLoading: true }} />
        );
        expect(screen.getByTestId('attachment-preview')).toHaveTextContent('Preview replace');
        expect(screen.getByRole('button', { name: 'Retry exact change' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Attach file' })).toBeDisabled();
        await act(async () => {
          if (outcome === 'saved') publication.resolve(receipt);
          else publication.reject(new Error('Native attachment write refused'));
        });
        if (outcome === 'saved')
          expect(screen.getByRole('status')).toHaveTextContent('replacement-revision');
        else {
          expect(screen.getByRole('alert')).toHaveTextContent(
            userMessage('attachments.changeFailed')
          );
          expect(screen.getByTestId('attachment-preview')).toBeVisible();
        }
        rerender(<SequencePackageHistoryPanel history={history} restore={restore} />);
        expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledOnce();
        if (outcome === 'saved')
          expect(screen.getByRole('status')).toHaveTextContent('replacement-revision');
        else
          expect(screen.getByRole('alert')).toHaveTextContent(
            userMessage('attachments.changeFailed')
          );
      } finally {
        await act(async () => publication.resolve(receipt));
      }
    }
  );

  it('checks the live package editor owner even when a stale prop says clean', async () => {
    const { history, marker } = fixture();
    admit(marker);
    const release = registerWorkspaceEditorBlocker(() => ({
      entityId: 'package-one',
      path: '/workspace/package',
      state: 'dirty',
    }));
    try {
      render(
        <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={vi.fn()} />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/unfinished package edits/i);
      expect(dialog.open).not.toHaveBeenCalled();
      expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('previews exact binary bytes, then publishes one versioned attach and refreshes', async () => {
    const { history, marker } = fixture();
    const sourceDigest = admit(marker);
    dialog.open.mockResolvedValue('/external/note.bin');
    const onRefresh = vi.fn();
    render(
      <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={onRefresh} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByTestId('attachment-preview');
    expect(screen.getByText(`Exact file SHA-256: ${sourceDigest}`)).toBeTruthy();
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await waitFor(() => expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledOnce());
    const request = fs.publishSequenceUserAttachmentMutation.mock.calls[0][0];
    expect(request).toMatchObject({
      workspaceRoot: '/workspace',
      packageRoot: '/workspace/package',
      packageId: 'package-one',
      expectedProductSha256: PRODUCT_SHA,
      mutation: { kind: 'attach', fileName: 'note.bin', content: new Uint8Array([0, 255, 7]) },
    });
    expect(request.expectedMarkerSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('status').textContent).toContain('attachment-revision');
  });

  it('previews replace and detach for the same stable logical attachment', async () => {
    const { history, marker } = fixture(true);
    admit(marker);
    dialog.open.mockResolvedValue('/external/new-note.bin');
    render(
      <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={vi.fn()} />
    );
    const row = screen.getByTestId('attachment-note');

    fireEvent.click(within(row).getByRole('button', { name: 'Replace' }));
    await screen.findByTestId('attachment-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await waitFor(() => expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledOnce());
    expect(fs.publishSequenceUserAttachmentMutation.mock.calls[0][0].mutation).toMatchObject({
      kind: 'replace',
      attachmentId: 'note',
      fileName: 'new-note.bin',
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Detach' }));
    await screen.findByTestId('attachment-preview');
    expect(screen.getByText(`Current: ${USER_SHA}`)).toBeTruthy();
    expect(screen.getByText('After: No current attachment')).toBeTruthy();
    expect(screen.getByText(/Existing package files and older versions are retained/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await waitFor(() => expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledTimes(2));
    expect(fs.publishSequenceUserAttachmentMutation.mock.calls[1][0].mutation).toMatchObject({
      kind: 'detach',
      attachmentId: 'note',
    });
    expect(dialog.open).toHaveBeenCalledOnce();
  });

  it('blocks dirty work and unavailable legacy attachment bytes', () => {
    const current = fixture(true);
    admit(current.marker);
    const { rerender } = render(
      <SequencePackageAttachmentsPanel history={current.history} isDirty onRefresh={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Attach file' }).hasAttribute('disabled')).toBe(true);
    expect(
      within(screen.getByTestId('attachment-note'))
        .getByRole('button', { name: 'Detach' })
        .hasAttribute('disabled')
    ).toBe(true);
    const legacy = fixture(true, true);
    admit(legacy.marker);
    rerender(
      <SequencePackageAttachmentsPanel
        history={legacy.history}
        isDirty={false}
        onRefresh={vi.fn()}
      />
    );
    expect(
      within(screen.getByTestId('attachment-note'))
        .getByRole('button', { name: 'Replace' })
        .hasAttribute('disabled')
    ).toBe(true);
    expect(
      within(screen.getByTestId('attachment-note'))
        .getByRole('button', { name: 'Detach' })
        .hasAttribute('disabled')
    ).toBe(true);
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
  });

  it('refuses a changed package after preview without calling publication', async () => {
    const { history, marker } = fixture();
    admit(marker);
    dialog.open.mockResolvedValue('/external/note.bin');
    render(
      <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByTestId('attachment-preview');
    fs.readTextFile.mockResolvedValue(marker.replace('Package one', 'Other name'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/changed|refresh/i);
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
  });

  it('refuses source-file changes and newly dirty work after preview', async () => {
    const { history, marker } = fixture();
    admit(marker);
    dialog.open.mockResolvedValue('/external/note.bin');
    const onRefresh = vi.fn();
    const { rerender } = render(
      <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={onRefresh} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByTestId('attachment-preview');
    fs.sha256File.mockImplementation(async (path: string) =>
      path === '/workspace/package/package.gb' ? PRODUCT_SHA : USER_SHA
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/chosen file changed/i);
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();

    rerender(<SequencePackageAttachmentsPanel history={history} isDirty onRefresh={onRefresh} />);
    expect(screen.getByRole('button', { name: 'Confirm attachment change' })).toBeDisabled();
    expect(fs.publishSequenceUserAttachmentMutation).not.toHaveBeenCalled();
  });

  it('retries an uncertain publication with the identical operation identity and bytes', async () => {
    const { history, marker } = fixture();
    admit(marker);
    dialog.open.mockResolvedValue('/external/note.bin');
    fs.publishSequenceUserAttachmentMutation
      .mockRejectedValueOnce(new Error('Response lost after publication'))
      .mockResolvedValueOnce({
        revisionId: 'attachment-revision',
        alreadyPublished: true,
        snapshotPaths: [],
        assetPaths: [],
      });
    render(
      <SequencePackageAttachmentsPanel history={history} isDirty={false} onRefresh={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByTestId('attachment-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment change' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact change' }));
    await waitFor(() => expect(fs.publishSequenceUserAttachmentMutation).toHaveBeenCalledTimes(2));
    expect(fs.publishSequenceUserAttachmentMutation.mock.calls[1][0]).toEqual(
      fs.publishSequenceUserAttachmentMutation.mock.calls[0][0]
    );
    expect(dialog.open).toHaveBeenCalledOnce();
  });
});
