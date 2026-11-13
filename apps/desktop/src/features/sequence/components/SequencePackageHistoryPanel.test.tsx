/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  type SequencePackageEvidenceRun,
  type SequencePackageRevision,
} from '../../../db/sequence-package';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';
import { SequencePackageHistoryPanel } from './SequencePackageHistoryPanel';

const fs = vi.hoisted(() => ({
  previewSequenceRestore: vi.fn(),
}));
const readEvidence = vi.hoisted(() => vi.fn());
vi.mock('../../../platform', () => ({ platform: () => ({ fs }) }));
vi.mock('../../../db/sequence-package-history-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/sequence-package-history-io')>()),
  readSequencePackageEvidenceRun: readEvidence,
}));

function historyView(): SequencePackageHistoryView {
  const snapshot = {
    path: 'contents/sequence-snapshot-test.gb',
    sha256: `sha256:${'a'.repeat(64)}`,
  };
  const original = buildSequencePackageDocument({
    id: 'package-1',
    name: 'Original',
    product: { file: 'sequence.gb', topology: 'linear' },
  });
  const earlier: SequencePackageRevision = {
    id: 'earlier',
    parentId: null,
    operationId: 'adopted:earlier',
    kind: 'adopted',
    createdAt: '2026-09-01T00:00:00.000Z',
    productSnapshot: snapshot,
    state: {
      name: 'Original',
      product: original.product,
      entity: { ...original.entity, fields: { description: 'old' } },
      acceptedAssembly: null,
    },
  };
  const latest: SequencePackageRevision = {
    ...earlier,
    id: 'latest',
    parentId: 'earlier',
    operationId: 'metadata:latest',
    kind: 'metadata-update',
    createdAt: '2026-09-02T00:00:00.000Z',
    state: {
      ...earlier.state,
      name: 'Latest',
      entity: { ...original.entity, fields: { description: 'new' } },
    },
  };
  const document = buildSequencePackageDocument({
    id: original.id,
    name: latest.state.name,
    product: latest.state.product,
    entity: latest.state.entity,
    members: [
      {
        id: 'snapshot',
        role: 'sequence-snapshot',
        path: snapshot.path,
        replaceable: false,
        createdAt: earlier.createdAt,
      },
    ],
    versionHistory: {
      schema: 'waypoint.sequence-history.v1',
      headId: 'latest',
      revisions: [earlier, latest],
    },
  });
  return {
    index: {
      document,
      packageRoot: '/workspace/package',
      markerPath: '/workspace/package/.forge/plasmid.json',
      productPath: '/workspace/package/sequence.gb',
      legacyCurrentHasNoSnapshot: false,
      currentProductStatus: 'verified',
    },
    selectedRevisionId: 'earlier',
    selectedSequence: null,
    selectedParentSequence: null,
    selectedParentStatus: 'none',
    isLoading: false,
    error: null,
    selectRevision: vi.fn(),
    refresh: vi.fn(),
  };
}

describe('sequence package History Restore', () => {
  it('selects only values actually recorded by a whole-version preset', async () => {
    const history = historyView();
    fs.previewSequenceRestore.mockReset();
    fs.previewSequenceRestore.mockResolvedValue({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: 'latest',
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {},
      changedItems: [],
      blockers: [],
      warnings: [],
    });
    render(
      <SequencePackageHistoryPanel
        history={history}
        restore={{
          workspaceRoot: '/workspace',
          isDirty: false,
          savePending: vi.fn().mockResolvedValue(true),
          discardPending: vi.fn(),
          apply: vi.fn(),
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all from this version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview Restore' }));
    await waitFor(() => expect(fs.previewSequenceRestore).toHaveBeenCalledOnce());
    const request = fs.previewSequenceRestore.mock.calls[0]?.[0];
    expect(request.selections).toContainEqual({ itemId: 'product', revisionId: 'earlier' });
    expect(request.selections).not.toContainEqual({
      itemId: 'genetic-code',
      revisionId: 'earlier',
    });
  });

  it('shows actual saved DNA changes against the selected version’s parent', async () => {
    const history = historyView();
    history.selectedRevisionId = 'latest';
    history.selectedParentSequence = {
      id: 'package-1',
      name: 'Earlier',
      sequence: 'AACC',
      length: 4,
      circular: false,
      annotations: [],
    } as AnnotatedSequence;
    history.selectedSequence = {
      ...history.selectedParentSequence,
      name: 'Latest',
      sequence: 'AATC',
    };
    history.selectedParentStatus = 'available';
    render(<SequencePackageHistoryPanel history={history} />);
    await waitFor(() =>
      expect(screen.getByTestId('history-sequence-diff').textContent).toContain('1 bp substituted')
    );
    expect(screen.getByTestId('history-diff-change-0').textContent).toContain('C → T');
  });
  it('shows an exact small edit in a product larger than the alignment window', async () => {
    const history = historyView();
    history.selectedRevisionId = 'latest';
    const oldBases = 'A'.repeat(8_000) + 'C' + 'A'.repeat(8_000);
    history.selectedParentSequence = {
      id: 'package-1',
      name: 'Earlier',
      sequence: oldBases,
      length: oldBases.length,
      circular: false,
      annotations: [],
    } as AnnotatedSequence;
    history.selectedSequence = {
      ...history.selectedParentSequence,
      sequence: `${oldBases.slice(0, 8_000)}T${oldBases.slice(8_001)}`,
    };
    history.selectedParentStatus = 'available';
    render(<SequencePackageHistoryPanel history={history} />);
    await waitFor(() =>
      expect(screen.getByTestId('history-sequence-diff').textContent).toContain('1 bp substituted')
    );
    expect(screen.getByTestId('history-diff-change-0').textContent).toContain('at 8001: C → T');
  });
  it('shows retained sequencing result and review state without calling it a current confirmation', async () => {
    const history = historyView();
    history.workspaceRoot = '/workspace';
    const artifact = {
      path: 'contents/evidence/run-one/reference.gb',
      sha256: `sha256:${'a'.repeat(64)}`,
    };
    const run: SequencePackageEvidenceRun = {
      id: 'run-one',
      sessionId: 'session-one',
      createdAt: '2026-09-03T00:00:00Z',
      status: 'completed',
      reference: {
        artifact,
        sequenceRevision: 'reference-revision',
        topology: 'linear',
        checkpointId: 'earlier',
      },
      queries: [
        {
          id: 'read-one',
          label: 'Read one',
          artifact: { ...artifact, path: 'contents/evidence/run-one/read-one.ab1' },
        },
      ],
      result: { ...artifact, path: 'contents/evidence/run-one/result.json' },
      inputRevision: 'input-revision',
      managedOperationId: 'operation-one',
    };
    history.index!.document.evidenceRuns = [run];
    readEvidence.mockResolvedValue({
      status: 'available',
      run,
      result: {},
      states: [
        {
          schema: 'waypoint.sequence-evidence-state.v1',
          runId: run.id,
          tracks: [
            {
              label: 'Read one',
              status: 'pass',
              userStatus: 'variants',
              mutations: [{ id: 'change-one' }],
            },
          ],
        },
      ],
    });
    render(<SequencePackageHistoryPanel history={history} />);
    await waitFor(() =>
      expect(screen.getByTestId('sequence-evidence-details').textContent).toContain(
        'Read one: variants · 1 difference'
      )
    );
    const timeline = screen.getByTestId('history-evidence-run-one');
    expect(
      timeline.compareDocumentPosition(screen.getByTestId('history-revision-latest')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(timeline);
    expect(history.selectRevision).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('sequence-evidence-details').textContent).toContain(
      'Tested version: earlier'
    );
    expect(screen.queryByText(/confirmed/i)).toBeNull();
  });

  it('previews a field source without mutating and requires a new preview after saving dirty edits', async () => {
    fs.previewSequenceRestore.mockReset();
    fs.previewSequenceRestore.mockResolvedValue({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: 'latest',
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {
        'field:description': { revisionId: 'earlier', valueSha256: `sha256:${'e'.repeat(64)}` },
      },
      changedItems: ['field:description'],
      blockers: [],
      warnings: [],
    });
    const history = historyView();
    const savePending = vi.fn().mockResolvedValue(true);
    const apply = vi.fn();
    render(
      <SequencePackageHistoryPanel
        history={history}
        restore={{
          workspaceRoot: '/workspace',
          isDirty: true,
          savePending,
          discardPending: vi.fn(),
          apply,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose source for Description' }));
    const sourceMenu = screen.getByTestId('restore-source-options-field:description');
    fireEvent.click(within(sourceMenu).getByRole('button', { name: /Earlier saved sequence/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview Restore' }));
    await waitFor(() => expect(screen.getByTestId('restore-preview')).toBeTruthy());
    expect(fs.previewSequenceRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'package-1',
        selections: [{ itemId: 'field:description', revisionId: 'earlier' }],
      })
    );
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new version' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved sequence changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(savePending).toHaveBeenCalledOnce());
    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByTestId('restore-preview')).toBeNull();
    expect(history.refresh).toHaveBeenCalled();
  });

  it('drops an approved preview when the current editor becomes dirty, even if it later becomes clean', async () => {
    fs.previewSequenceRestore.mockReset();
    fs.previewSequenceRestore.mockResolvedValue({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: 'latest',
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {},
      changedItems: ['field:description'],
      blockers: [],
      warnings: [],
    });
    const history = historyView();
    const apply = vi.fn();
    const restore = {
      workspaceRoot: '/workspace',
      isDirty: false,
      savePending: vi.fn().mockResolvedValue(true),
      discardPending: vi.fn(),
      apply,
    };
    const { rerender } = render(
      <SequencePackageHistoryPanel history={history} restore={restore} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose source for Description' }));
    fireEvent.click(
      within(screen.getByTestId('restore-source-options-field:description')).getByRole('button', {
        name: /Earlier saved sequence/,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview Restore' }));
    await waitFor(() => expect(screen.getByTestId('restore-preview')).toBeTruthy());

    rerender(
      <SequencePackageHistoryPanel history={history} restore={{ ...restore, isDirty: true }} />
    );
    expect(screen.queryByTestId('restore-preview')).toBeNull();
    rerender(<SequencePackageHistoryPanel history={history} restore={restore} />);
    expect(screen.queryByRole('button', { name: 'Restore as new version' })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores a preview returned after the package history changes', async () => {
    fs.previewSequenceRestore.mockReset();
    let completePreview!: (value: unknown) => void;
    fs.previewSequenceRestore.mockReturnValue(
      new Promise((resolve) => {
        completePreview = resolve;
      })
    );
    const history = historyView();
    const { rerender } = render(<SequencePackageHistoryPanel history={history} />);
    const restore = {
      workspaceRoot: '/workspace',
      isDirty: false,
      savePending: vi.fn().mockResolvedValue(true),
      discardPending: vi.fn(),
      apply: vi.fn(),
    };
    rerender(<SequencePackageHistoryPanel history={history} restore={restore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose source for Description' }));
    fireEvent.click(
      within(screen.getByTestId('restore-source-options-field:description')).getByRole('button', {
        name: /Earlier saved sequence/,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview Restore' }));
    rerender(
      <SequencePackageHistoryPanel
        history={{ ...history, index: { ...history.index! } }}
        restore={restore}
      />
    );
    completePreview({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: 'latest',
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {},
      changedItems: ['field:description'],
      blockers: [],
      warnings: [],
    });
    await waitFor(() => expect(screen.queryByText('Working…')).toBeNull());
    expect(screen.queryByTestId('restore-preview')).toBeNull();
  });

  it('keeps historical navigation disabled until an in-flight Restore finishes', async () => {
    fs.previewSequenceRestore.mockReset();
    fs.previewSequenceRestore.mockResolvedValue({
      previewFingerprint: `sha256:${'b'.repeat(64)}`,
      currentHeadId: 'latest',
      currentMarkerSha256: `sha256:${'c'.repeat(64)}`,
      currentProductSha256: `sha256:${'d'.repeat(64)}`,
      selectedSources: {},
      changedItems: ['field:description'],
      blockers: [],
      warnings: [],
    });
    let finishApply!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishApply = resolve;
        })
    );
    const history = historyView();
    render(
      <SequencePackageHistoryPanel
        history={history}
        restore={{
          workspaceRoot: '/workspace',
          isDirty: false,
          savePending: vi.fn().mockResolvedValue(true),
          discardPending: vi.fn(),
          apply,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose source for Description' }));
    fireEvent.click(
      within(screen.getByTestId('restore-source-options-field:description')).getByRole('button', {
        name: /Earlier saved sequence/,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview Restore' }));
    await waitFor(() => expect(screen.getByTestId('restore-preview')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new version' }));
    expect(apply).toHaveBeenCalledOnce();
    expect((screen.getByTestId('history-revision-earlier') as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByTestId('history-revision-earlier'));
    expect(history.selectRevision).not.toHaveBeenCalled();
    finishApply();
    await waitFor(() =>
      expect((screen.getByTestId('history-revision-earlier') as HTMLButtonElement).disabled).toBe(
        false
      )
    );
    expect(history.selectRevision).toHaveBeenCalledWith(null);
  });
});
