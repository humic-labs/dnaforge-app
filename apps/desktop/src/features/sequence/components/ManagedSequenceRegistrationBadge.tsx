import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import {
  LimsRegistrationStatusBadge,
  type LimsBadgeStatus,
} from '../../lims/public/registration-badge';
import { subscribeLimsRegistrationChanged } from '../../lims/public/events';
import { managedSequenceRepository } from '../managed-sequence-repository';

type ManagedRegistrationState = {
  status: LimsBadgeStatus;
  registryId: string | null;
  error?: string;
};

export function ManagedSequenceRegistrationBadge({
  documentRef,
}: {
  documentRef: ManagedSequenceDocumentRef;
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<ManagedRegistrationState>({
    status: 'loading',
    registryId: null,
  });

  useEffect(
    () =>
      subscribeLimsRegistrationChanged((detail) => {
        if (
          (detail.documentId === undefined && detail.entityId === undefined) ||
          detail.documentId === documentRef.packageId ||
          detail.entityId === documentRef.packageId
        ) {
          setRefreshToken((token) => token + 1);
        }
      }),
    [documentRef.packageId]
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', registryId: null });
    void managedSequenceRepository.resolve(documentRef).then(
      ({ document }) => {
        if (cancelled) return;
        setState({
          status: document.entity.registrationStatus,
          registryId: document.entity.registryId,
        });
      },
      (reason: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          registryId: null,
          error: toUserMessage(reason, 'failure.managed-registry-status-could-not-be-loaded'),
        });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [documentRef.packageId, documentRef.packageRoot, refreshToken]);

  return (
    <LimsRegistrationStatusBadge
      status={state.status}
      title={
        state.error != null
          ? toUserMessage(state.error, 'tracks.loadFailed')
          : state.registryId
            ? userMessageWithValues('notice.registry-id-value', {
                value0: userMessageValue(state.registryId),
              })
            : undefined
      }
    />
  );
}
