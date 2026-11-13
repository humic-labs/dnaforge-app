import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceSyncMergeConflictView } from '../../shared/workspace-sync-ipc';
import { MergeConflictPanel } from './MergeConflictPanel';

function conflict(): WorkspaceSyncMergeConflictView {
  const side = (contentHash: string) => ({
    path: 'sequences/construct',
    fileCount: 3,
    sizeBytes: 200,
    contentHash,
    preview: null,
  });
  return {
    conflictId: 'conflict-1',
    workspaceUuid: 'workspace-a',
    remoteVersionId: 'remote-1',
    remoteVersionNumber: 3,
    remoteAuthor: 'Alice',
    baseVersionId: 'base-1',
    createdAt: 1,
    items: [
      {
        resourceId: 'seq:stable-id',
        kind: 'sequence-package',
        reason: 'edit-edit',
        path: 'sequences/construct',
        canKeepBoth: false,
        base: side('base'),
        local: side('local'),
        remote: side('remote'),
      },
    ],
  };
}

afterEach(cleanup);

describe('MergeConflictPanel exact review scope', () => {
  it.each(['new-content', 'new-conflict'] as const)(
    'clears old selections when it receives %s for the same package identity',
    (change) => {
      const onResolve = vi.fn();
      const first = conflict();
      const props = { commandInFlight: false, onResolve, onReconcileAgain: vi.fn() };
      const view = render(<MergeConflictPanel {...props} conflict={first} />);
      fireEvent.click(screen.getByTestId('merge-choice-theirs'));
      expect((screen.getByTestId('merge-conflict-apply') as HTMLButtonElement).disabled).toBe(
        false
      );
      const next = structuredClone(first);
      if (change === 'new-content') next.items[0]!.local!.contentHash = 'newest-local';
      else next.conflictId = 'conflict-2';
      view.rerender(<MergeConflictPanel {...props} conflict={next} />);
      expect((screen.getByTestId('merge-conflict-apply') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId('merge-conflict-apply'));
      expect(onResolve).not.toHaveBeenCalled();
    }
  );

  it('offers deletion as an explicit choice in a delete-versus-edit conflict', () => {
    const current = conflict();
    current.items[0]!.reason = 'delete-edit';
    current.items[0]!.local = null;
    const onResolve = vi.fn();
    render(
      <MergeConflictPanel
        conflict={current}
        commandInFlight={false}
        onResolve={onResolve}
        onReconcileAgain={vi.fn()}
      />
    );
    const deletion = screen.getByTestId('merge-choice-mine') as HTMLButtonElement;
    expect(deletion.disabled).toBe(false);
    expect(deletion.textContent).toMatch(/deletion/i);
    fireEvent.click(deletion);
    fireEvent.click(screen.getByTestId('merge-conflict-apply'));
    expect(onResolve).toHaveBeenCalledWith({ 'seq:stable-id': 'mine' });
  });

  it('does not claim unresolved changes have already synced or become accepted history', () => {
    render(
      <MergeConflictPanel
        conflict={conflict()}
        commandInFlight={false}
        onResolve={vi.fn()}
        onReconcileAgain={vi.fn()}
      />
    );
    expect(screen.getByTestId('merge-conflict-panel').textContent).not.toMatch(
      /everything else already synced|both versions stay in history/i
    );
    expect(screen.getByTestId('merge-conflict-panel').textContent).toMatch(
      /kept on this computer/i
    );
  });

  it('compares bases, annotations, package records, and attachments against the common version', () => {
    const current = conflict();
    const sequence = {
      productPath: 'construct.gb',
      productSha256: 'file-hash',
      metadataSha256: 'record-hash',
      attachmentSha256: 'attachments-hash',
      attachmentCount: 1,
      attachments: [
        {
          memberId: 'trace-stable-id',
          path: 'contents/trace.ab1',
          role: 'chromatogram',
          sha256: 'trace-hash',
        },
      ],
      buildRecordCount: 2,
      baseCount: 8,
      topology: 'circular' as const,
      basesSha256: 'base-bases',
      annotationsSha256: 'base-annotations',
      annotationCount: 1,
      annotationNames: ['reporter (CDS, 1–6)'],
      inspectionUnavailableReason: null,
    };
    current.items[0]!.base!.sequence = sequence;
    current.items[0]!.local!.sequence = { ...sequence, basesSha256: 'my-bases' };
    current.items[0]!.remote!.sequence = { ...sequence, annotationsSha256: 'their-annotations' };
    render(
      <MergeConflictPanel
        conflict={current}
        commandInFlight={false}
        onResolve={vi.fn()}
        onReconcileAgain={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTitle('sequences/construct'));
    const comparison = screen.getByTestId('merge-sequence-comparison');
    expect(comparison.textContent).toMatch(/8 bases.*circular/i);
    expect(comparison.textContent).toMatch(/annotations/i);
    expect(comparison.textContent).toMatch(/changed from before/i);
    expect(comparison.textContent).toMatch(/unchanged from before/i);
    expect(comparison.textContent).toMatch(/package record/i);
    expect(comparison.textContent).toMatch(/attachments/i);
    expect(screen.getByTestId('merge-conflict-detail').textContent).toContain('contents/trace.ab1');
    expect(screen.getByTestId('merge-conflict-detail').textContent).toContain(
      'reporter (CDS, 1–6)'
    );
  });
});
