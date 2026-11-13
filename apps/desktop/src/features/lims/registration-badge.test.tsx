import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeChecksum } from '@waypoint/sequence-utils';
import { LimsRegistrationBadge } from './registration-badge';
import { SequenceRegistrationSection } from './SequenceRegistrationSection';
import type { FileDnaSequenceRef, LimsEntity } from '../../shared/lims';
import { emitLimsRegistrationChanged } from './events';

const mocks = vi.hoisted(() => ({
  getCandidates: vi.fn(),
  logTelemetry: vi.fn(),
  fs: {
    exists: vi.fn(),
    stat: vi.fn(),
    readTextFile: vi.fn(),
  },
}));

vi.mock('./operations', () => ({
  getLimsRegistrationBadgeCandidates: mocks.getCandidates,
  logLimsTelemetry: mocks.logTelemetry,
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: mocks.fs }),
}));

describe('LIMS registration badge', () => {
  const documentId = 'sequence-document-p1';
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logTelemetry.mockResolvedValue({});
  });

  it('shows not registered and logs a badge consult when no candidate exists', async () => {
    mocks.getCandidates.mockResolvedValue([]);

    render(
      <LimsRegistrationBadge
        documentId="sequence-document-unregistered"
        sourcePath="/workspace/unregistered.gb"
      />
    );

    expect(await screen.findByText('not registered')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.logTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'badge_consulted',
          subjectId: null,
          payload: { documentId: 'sequence-document-unregistered', status: 'not_registered' },
        })
      )
    );
    expect(mocks.fs.exists).not.toHaveBeenCalled();
  });

  it('keeps the kind picker open while refreshing the same unregistered sequence', async () => {
    let finishLookup!: (value: []) => void;
    mocks.getCandidates.mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          finishLookup = resolve;
        })
    );
    render(
      <SequenceRegistrationSection
        documentId={documentId}
        sourcePath="/workspace/p1.gb"
        topology="linear"
        length={30}
      />
    );
    await screen.findByText('Not registered');
    fireEvent.click(screen.getByTestId('sequence-metadata-register'));
    expect(screen.getByTestId('lims-registration-kind-picker')).toBeVisible();
    act(() => {
      emitLimsRegistrationChanged({ documentId });
    });
    expect(screen.getByTestId('lims-registration-kind-picker')).toBeVisible();
    await act(async () => {
      finishLookup([]);
    });
    expect(screen.getByTestId('lims-registration-kind-sequence')).toBeVisible();
  });

  it('checks a different sequence before offering its registration action', async () => {
    mocks.getCandidates
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(
      <LimsRegistrationBadge documentId={documentId} sourcePath="/workspace/p1.gb" />
    );
    await screen.findByText('not registered');
    rerender(
      <LimsRegistrationBadge documentId="different-document" sourcePath="/workspace/other.gb" />
    );
    await screen.findByText('checking');
  });

  it('shows registered from cached mtime and size without rehashing the file', async () => {
    const sequence = fileSequence({
      relPath: '/workspace/p1.gb',
      sizeBytes: 100,
      modifiedAt: 200,
    });
    mocks.getCandidates.mockResolvedValue([{ entity: entity(sequence), sequence }]);
    mocks.fs.exists.mockResolvedValue(true);
    mocks.fs.stat.mockResolvedValue({ size: 100, mtime: 200 });

    render(<LimsRegistrationBadge documentId={documentId} sourcePath="/workspace/p1.gb" />);

    expect(await screen.findByText('registered')).toBeInTheDocument();
    expect(mocks.fs.readTextFile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.logTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'badge_consulted',
          subjectId: 'entity-1',
          payload: { documentId, status: 'registered' },
        })
      )
    );
  });

  it('rehashes changed files and shows drifted when the content hash differs', async () => {
    const original = '>p1\nATGC\n';
    const changed = '>p1\nATGCG\n';
    const sequence = fileSequence({
      relPath: '/workspace/p1.gb',
      contentHash: await computeChecksum(original),
      sizeBytes: original.length,
      modifiedAt: 100,
    });
    mocks.getCandidates.mockResolvedValue([{ entity: entity(sequence), sequence }]);
    mocks.fs.exists.mockResolvedValue(true);
    mocks.fs.stat.mockResolvedValue({ size: changed.length, mtime: 101 });
    mocks.fs.readTextFile.mockResolvedValue(changed);

    render(<LimsRegistrationBadge documentId={documentId} sourcePath="/workspace/p1.gb" />);

    const badge = await screen.findByText('edited');
    expect(badge).toBeInTheDocument();
    expect(badge.className).not.toContain('text-warning');
    expect(badge.className).not.toContain('bg-warning');
    expect(badge.className).toContain('text-fg-muted');
    expect(mocks.fs.readTextFile).toHaveBeenCalledWith('/workspace/p1.gb');
    await waitFor(() =>
      expect(mocks.logTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'badge_consulted',
          subjectId: 'entity-1',
          payload: { documentId, status: 'drifted' },
        })
      )
    );
  });

  it('refreshes when a LIMS registration change is emitted for the same document', async () => {
    const sequence = fileSequence({
      relPath: '/workspace/p1.gb',
      sizeBytes: 100,
      modifiedAt: 200,
    });
    mocks.getCandidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ entity: entity(sequence), sequence }]);
    mocks.fs.exists.mockResolvedValue(true);
    mocks.fs.stat.mockResolvedValue({ size: 100, mtime: 200 });

    render(<LimsRegistrationBadge documentId={documentId} sourcePath="/workspace/p1.gb" />);

    expect(await screen.findByText('not registered')).toBeInTheDocument();
    act(() => {
      emitLimsRegistrationChanged({ documentId, entityId: 'entity-1' });
    });

    expect(await screen.findByText('registered')).toBeInTheDocument();
    expect(mocks.getCandidates).toHaveBeenCalledTimes(2);
  });

  it('shows registration status without an action or picker in the top bar', async () => {
    mocks.getCandidates.mockResolvedValue([]);
    render(<LimsRegistrationBadge documentId={documentId} sourcePath="/workspace/p1.gb" />);
    const status = await screen.findByTestId('lims-registration-badge');
    expect(status).toHaveTextContent('not registered');
    expect(status.tagName).toBe('SPAN');
    expect(status).not.toHaveAttribute('aria-haspopup');
    expect(screen.queryByText('Register')).not.toBeInTheDocument();
  });
});

function fileSequence(overrides: Partial<FileDnaSequenceRef> = {}): FileDnaSequenceRef {
  return {
    mode: 'file',
    documentId: 'sequence-document-p1',
    relPath: '/workspace/p1.gb',
    topology: 'circular',
    length: 4,
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceFormat: 'gb',
    sizeBytes: 100,
    modifiedAt: 200,
    ...overrides,
  };
}

function entity(
  sequence: FileDnaSequenceRef,
  overrides: Partial<Pick<LimsEntity, 'kind' | 'schemaId' | 'schemaRevisionId'>> = {}
): LimsEntity {
  const kind = overrides.kind ?? 'plasmid';
  return {
    id: 'entity-1',
    kind,
    schemaId: overrides.schemaId ?? `schema-entity-${kind}`,
    schemaRevisionId: overrides.schemaRevisionId ?? `schema-entity-${kind}-v1`,
    name: 'p1',
    fields: { sequence },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: 'local-user',
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}
