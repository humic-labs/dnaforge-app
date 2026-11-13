import { useCallback, useState } from 'react';

import {
  directTrackAdmissionRequest,
  trackAdmissionRequestLabel,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from '../alignment-header-client';
import { attachTrackAdmissionRequest } from '../attach-track-source';

export interface IndexedTrackImportNotice {
  readonly kind: 'success' | 'warn' | 'error';
  readonly text: string;
}

export interface IndexedTrackImportController {
  readonly busy: string | null;
  readonly notice: IndexedTrackImportNotice | null;
  readonly clearNotice: () => void;
  readonly addRequests: (
    requests: ReadonlyArray<TrackAdmissionRequestV1>
  ) => Promise<ReadonlyArray<TrackImportOutcome>>;
  readonly addBigWigFiles: (paths: ReadonlyArray<string>) => Promise<void>;
}

export type TrackImportOutcome =
  | Readonly<{
      request: TrackAdmissionRequestV1;
      status: 'added' | 'duplicate';
      label: string;
    }>
  | Readonly<{
      request: TrackAdmissionRequestV1;
      status: 'error';
      label: string;
      message: string;
    }>;

export function useIndexedTrackImport(input: {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
}): IndexedTrackImportController {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<IndexedTrackImportNotice | null>(null);

  const clearNotice = useCallback(() => setNotice(null), []);

  const attach = useCallback(
    async (request: TrackAdmissionRequestV1): Promise<'added' | 'duplicate'> => {
      const label = trackAdmissionRequestLabel(request);
      setBusy(`Checking ${label}…`);
      try {
        const attached = await attachTrackAdmissionRequest({
          laneOwnerId: input.laneOwnerId,
          assemblyId: input.assemblyId,
          assemblyReferences: input.assemblyReferences,
          request,
        });
        setBusy(null);
        return attached.status;
      } catch (error) {
        setBusy(null);
        throw error;
      }
    },
    [input]
  );

  const addRequests = useCallback(
    async (
      requests: ReadonlyArray<TrackAdmissionRequestV1>
    ): Promise<ReadonlyArray<TrackImportOutcome>> => {
      clearNotice();
      if (requests.length === 0) return [];
      const outcomes: TrackImportOutcome[] = [];
      for (const request of requests) {
        const label = trackAdmissionRequestLabel(request);
        try {
          outcomes.push({ request, status: await attach(request), label });
        } catch (error) {
          outcomes.push({
            request,
            status: 'error',
            label,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      setBusy(null);
      const added = outcomes.filter((outcome) => outcome.status === 'added').length;
      const duplicates = outcomes.filter((outcome) => outcome.status === 'duplicate');
      const errors = outcomes.filter(
        (outcome): outcome is Extract<TrackImportOutcome, { status: 'error' }> =>
          outcome.status === 'error'
      );
      const messages: string[] = [];
      if (added > 0) messages.push(`Added ${added} data track${added === 1 ? '' : 's'}.`);
      if (duplicates.length > 0) {
        messages.push(`Already added: ${duplicates.map((outcome) => outcome.label).join(', ')}.`);
      }
      if (errors.length > 0) {
        messages.push(errors.map((outcome) => `${outcome.label}: ${outcome.message}`).join(' '));
      }
      if (messages.length > 0) {
        setNotice({
          kind: errors.length > 0 ? 'error' : duplicates.length > 0 ? 'warn' : 'success',
          text: messages.join(' '),
        });
      }
      return outcomes;
    },
    [attach, clearNotice]
  );

  const addBigWigFiles = useCallback(
    async (paths: ReadonlyArray<string>) => {
      await addRequests(
        paths.map((path) =>
          directTrackAdmissionRequest({
            assemblyId: input.assemblyId,
            input: { kind: 'path', path },
            formatId: 'bigwig',
            ingress: 'file-picker',
          })
        )
      );
    },
    [addRequests, input.assemblyId]
  );

  return {
    busy,
    notice,
    clearNotice,
    addRequests,
    addBigWigFiles,
  };
}
