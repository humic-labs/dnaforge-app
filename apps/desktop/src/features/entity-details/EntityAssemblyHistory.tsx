import { type UserMessage, toUserMessage, renderUserMessage } from '@waypoint/user-messages';

import { Notice } from '../../components/ui';
import { useMemo } from 'react';
import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import { parseAcceptedAssemblyPayload } from '../assembly/public/accepted-reopen';
import { useReopenAcceptedAssembly } from '../assembly/public/hooks/useReopenAcceptedAssembly';
import { SequenceAssemblyHistory } from '../sequence/public/components/SequenceAssemblyHistory';
import type { EntityDetailsRecord } from './types';
import type { AcceptedAssemblySidecarPayload } from '../assembly/public/accepted-types';

export function EntityAssemblyHistory({
  record,
  onReopen,
  status,
  onPreview,
  acceptedRecord,
  error,
}: {
  record: EntityDetailsRecord;
  acceptedRecord?: AcceptedAssemblySidecarPayload | null;
  error?: UserMessage | null;
  onReopen?: () => Promise<void>;
  status?: string;
  onPreview?: (segments: BackboneSegment[] | undefined) => void;
}) {
  const document = record.sequence?.document;
  const ref = record.sequence?.ref;
  const reopen = useReopenAcceptedAssembly(
    record.id,
    document && ref ? `${ref.packageRoot}/${document.product.file}` : null
  );
  const entries = useMemo(() => {
    if (!document?.assembly?.accepted && !document?.assembly?.history?.length)
      return acceptedRecord ? [acceptedRecord] : null;
    try {
      return [
        ...(document.assembly.accepted ? [document.assembly.accepted] : []),
        ...(document.assembly.history ?? []).slice().reverse(),
      ].map((payload) =>
        parseAcceptedAssemblyPayload(payload, { packageRoot: ref?.packageRoot ?? null })
      );
    } catch {
      return [];
    }
  }, [acceptedRecord, document, ref?.packageRoot]);
  if (!entries || !record.sequence)
    return error ? <Notice tone="error">{renderUserMessage(error)}</Notice> : null;
  return (
    <>
      <SequenceAssemblyHistory
        entries={entries}
        productSequence={record.sequence.data.sequence}
        onBackboneSegmentsChange={onPreview}
        onReopenAssembly={record.readOnlyReason ? undefined : (onReopen ?? reopen.reopen)}
        assemblyReopenError={error}
        assemblyReopenStatus={status ?? reopen.status}
      />
      {!onReopen && reopen.error ? (
        <Notice tone="error">{toUserMessage(reopen.error, 'assembly.failed')}</Notice>
      ) : null}
    </>
  );
}
