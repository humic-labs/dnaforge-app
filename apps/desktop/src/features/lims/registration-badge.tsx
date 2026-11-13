import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { computeChecksum } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { getLimsRegistrationBadgeCandidates, logLimsTelemetry } from './operations';
import type { LimsEntity } from '../../shared/lims';
import { subscribeLimsRegistrationChanged } from './events';

export type LimsBadgeStatus =
  | 'loading'
  | 'not_registered'
  | 'tracked'
  | 'registered'
  | 'drifted'
  | 'unresolved'
  | 'error';

export interface LimsRegistrationBadgeState {
  status: LimsBadgeStatus;
  entity: LimsEntity | null;
  error?: string;
}

export function LimsRegistrationStatusBadge({
  status,
  title,
}: {
  status: LimsBadgeStatus;
  title?: string;
}) {
  if (status === 'tracked') return null;
  const label = labelForStatus(status);
  return (
    <span
      data-testid="lims-registration-badge"
      title={title ?? tooltipForStatus(status, label)}
      className={`inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-medium uppercase leading-none ${classForStatus(
        status
      )}`}
    >
      {label}
    </span>
  );
}

export function useLimsRegistrationBadge(
  documentId: string | null,
  sourcePath: string | null
): LimsRegistrationBadgeState {
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<LimsRegistrationBadgeState>({
    status: documentId ? 'loading' : 'not_registered',
    entity: null,
  });
  const loggedRef = useRef<string | null>(null);
  const lookupIdentity = useRef({ documentId, sourcePath });

  useEffect(
    () =>
      subscribeLimsRegistrationChanged((detail) => {
        if (
          !documentId ||
          (detail.documentId === undefined && detail.filePath === undefined) ||
          detail.documentId === documentId ||
          detail.filePath === sourcePath
        ) {
          setRefreshToken((token) => token + 1);
        }
      }),
    [documentId, sourcePath]
  );

  useEffect(() => {
    let cancelled = false;
    if (!documentId || !sourcePath) {
      setState({ status: 'not_registered', entity: null });
      return;
    }

    if (
      lookupIdentity.current.documentId !== documentId ||
      lookupIdentity.current.sourcePath !== sourcePath
    ) {
      setState({ status: 'loading', entity: null });
    }
    lookupIdentity.current = { documentId, sourcePath };
    void (async () => {
      try {
        const candidates = await getLimsRegistrationBadgeCandidates({ documentId });
        if (cancelled) return;
        if (candidates.length === 0) {
          const next = { status: 'not_registered' as const, entity: null };
          setState(next);
          await logBadgeConsult(documentId, next.status, null, loggedRef);
          return;
        }

        const candidate = candidates[0];
        if (candidate.entity.registrationStatus === 'unresolved') {
          const next = { status: 'unresolved' as const, entity: candidate.entity };
          setState(next);
          await logBadgeConsult(documentId, next.status, candidate.entity.id, loggedRef);
          return;
        }
        if (candidate.entity.registrationStatus === 'drifted') {
          const next = { status: 'drifted' as const, entity: candidate.entity };
          setState(next);
          await logBadgeConsult(documentId, next.status, candidate.entity.id, loggedRef);
          return;
        }

        const exists = await platform().fs.exists(sourcePath);
        if (cancelled) return;
        if (!exists) {
          const next = { status: 'unresolved' as const, entity: candidate.entity };
          setState(next);
          await logBadgeConsult(documentId, next.status, candidate.entity.id, loggedRef);
          return;
        }

        const stat = await platform().fs.stat(sourcePath);
        if (cancelled) return;
        if (
          candidate.sequence.sizeBytes === stat.size &&
          candidate.sequence.modifiedAt === stat.mtime
        ) {
          const next = { status: 'registered' as const, entity: candidate.entity };
          setState(next);
          await logBadgeConsult(documentId, next.status, candidate.entity.id, loggedRef);
          return;
        }

        const content = await platform().fs.readTextFile(sourcePath);
        const contentHash = await computeChecksum(content);
        if (cancelled) return;
        const next = {
          status:
            contentHash === candidate.sequence.contentHash
              ? ('registered' as const)
              : ('drifted' as const),
          entity: candidate.entity,
        };
        setState(next);
        await logBadgeConsult(documentId, next.status, candidate.entity.id, loggedRef);
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          entity: null,
          error: toUserMessage(err, 'operation.failed'),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId, refreshToken, sourcePath]);

  return state;
}

interface LimsRegistrationBadgeProps {
  documentId: string | null;
  sourcePath: string | null;
}

export function LimsRegistrationBadge({ documentId, sourcePath }: LimsRegistrationBadgeProps) {
  const state = useLimsRegistrationBadge(documentId, sourcePath);
  const label = labelForStatus(state.status);

  return (
    <span
      data-testid="lims-registration-badge"
      title={
        state.error != null
          ? toUserMessage(state.error, 'operation.failed')
          : toUserMessage(tooltipForStatus(state.status, label), 'operation.failed')
      }
      className={`inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-medium uppercase leading-none ${classForStatus(state.status)}`}
    >
      {label}
    </span>
  );
}

function labelForStatus(status: LimsBadgeStatus): string {
  switch (status) {
    case 'loading':
      return 'checking';
    case 'not_registered':
      return 'not registered';
    case 'tracked':
      return 'tracked';
    case 'registered':
      return 'registered';
    case 'drifted':
      return 'edited';
    case 'unresolved':
      return 'unresolved';
    case 'error':
      return 'error';
  }
}

function classForStatus(status: LimsBadgeStatus): string {
  if (status === 'registered') return 'border-transparent bg-transparent text-success';
  if (status === 'drifted') return 'border-border-hover bg-bg-muted text-fg-muted';
  if (status === 'error') return 'border-error/25 bg-error/10 text-error';
  return 'border-border bg-bg-muted/70 text-fg-subtle';
}

function tooltipForStatus(status: LimsBadgeStatus, label: string): string {
  if (status === 'drifted') {
    return 'You’ve edited this file since registering it in LIMS. The registered version no longer matches the file on disk.';
  }
  return label;
}

async function logBadgeConsult(
  documentId: string,
  status: LimsBadgeStatus,
  entityId: string | null,
  loggedRef: MutableRefObject<string | null>
): Promise<void> {
  const key = `${documentId}:${status}:${entityId ?? 'none'}`;
  if (loggedRef.current === key) return;
  loggedRef.current = key;
  await logLimsTelemetry({
    eventType: 'badge_consulted',
    subjectTable: entityId ? 'lims_entity' : null,
    subjectId: entityId,
    payload: { documentId, status },
    actor: 'local-user',
  }).catch(() => undefined);
}
