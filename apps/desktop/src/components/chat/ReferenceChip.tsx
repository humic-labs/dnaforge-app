import { useEffect, useId, useMemo, useState } from 'react';
import type { DBEntityReference } from '../../db/entity-references';
import { inlineWorkspaceDeclarationFromReference } from '../../features/ai/references/inline/activate';
import { ChatEntityReferenceChip } from './ChatEntityReferenceChip';
import { PaperclipIcon, XIcon, TargetIcon } from '../icons';
import { iconForEntityKind } from '../icons/entity-icon-registry';
import { MolecularViewPreview } from '../../features/page/public/embeds/structure3d/components/MolecularViewPreview';
import { molViewSpecStorySteps } from '../../features/page/embeds/structure3d/utils/molViewSpecStory';
import { resolveMolecularReference } from '../../shared/molecular-reference';
import type { MolecularView } from '../../shared/molecular-view';
import { molecularDocumentReferenceLocator } from '../../shared/molecular-document-reference';

interface ReferenceChipProps {
  reference: DBEntityReference;
  onClick?: (reference: DBEntityReference, options?: { snapshotIndex: number }) => void;
  onReveal?: (reference: DBEntityReference) => void;
  onTarget?: (reference: DBEntityReference) => void;
  inline?: boolean;
  busy?: boolean;
  completedToolInput?: unknown;
  phase?: 'draft' | 'sent';
  onRemove?: () => void;
}

interface DisplayResidue {
  chain: string;
  authSeqId: number;
  labelCompId: string | null;
  oneLetterCode: string | null;
  identityStatus: 'known' | 'unknown';
}

interface StructureSelectionDetails {
  residues: DisplayResidue[];
  omittedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResidue(value: unknown): DisplayResidue | null {
  if (!isRecord(value) || typeof value.chain !== 'string') return null;
  if (!Number.isInteger(value.authSeqId) || (value.authSeqId as number) < 1) return null;
  const labelCompId =
    typeof value.labelCompId === 'string' && value.labelCompId.length > 0
      ? value.labelCompId
      : null;
  const oneLetterCode =
    typeof value.oneLetterCode === 'string' && value.oneLetterCode.length > 0
      ? value.oneLetterCode
      : null;
  return {
    chain: value.chain,
    authSeqId: value.authSeqId as number,
    labelCompId,
    oneLetterCode,
    identityStatus: value.identityStatus === 'unknown' || !labelCompId ? 'unknown' : 'known',
  };
}

function structureSelectionDetails(reference: DBEntityReference): StructureSelectionDetails | null {
  if (!['structure', 'molecular-document'].includes(reference.entity_type) || !reference.data)
    return null;
  try {
    const stored = JSON.parse(reference.data);
    const descriptor =
      reference.entity_type === 'molecular-document' && stored.kind !== 'structure'
        ? reference.deep_link_params && JSON.parse(reference.deep_link_params).selectionDescriptor
        : stored;
    if (
      !isRecord(descriptor) ||
      descriptor.kind !== 'structure' ||
      !isRecord(descriptor.measured)
    ) {
      return null;
    }
    const measured = descriptor.measured;
    if (Array.isArray(measured.residues)) {
      const residues = measured.residues
        .map(parseResidue)
        .filter((residue): residue is DisplayResidue => residue !== null);
      if (residues.length === 0) return null;
      return {
        residues,
        omittedCount:
          typeof measured.residueOmittedCount === 'number'
            ? Math.max(0, measured.residueOmittedCount)
            : 0,
      };
    }

    if (!Array.isArray(measured.residueIdentities)) return null;
    const residues = measured.residueIdentities
      .map(parseResidue)
      .filter((residue): residue is DisplayResidue => residue !== null);
    if (residues.length === 0) return null;
    const knownOmitted =
      typeof measured.residueIdentityOmittedCount === 'number'
        ? measured.residueIdentityOmittedCount
        : 0;
    const unknown =
      typeof measured.residueIdentityUnknownCount === 'number'
        ? measured.residueIdentityUnknownCount
        : 0;
    return { residues, omittedCount: Math.max(0, knownOmitted + unknown) };
  } catch {
    return null;
  }
}

export function ReferenceChip({
  reference,
  onClick,
  onReveal,
  onTarget,
  inline = false,
  busy = false,
  completedToolInput,
  phase,
  onRemove,
}: ReferenceChipProps) {
  const molecular = useMemo(() => {
    try {
      return { subject: resolveMolecularReference(reference), invalid: false };
    } catch {
      return { subject: null, invalid: true };
    }
  }, [reference]);
  const document = molecular.subject?.kind === 'document' ? molecular.subject.document : null;
  const [documentPreview, setDocumentPreview] = useState<{
    key: string;
    view: MolecularView | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (!document || inline || phase === 'draft' || document.viewId) return;
    void import('../../features/molecular-documents/public/references')
      .then((module) => module.resolveMolecularDocumentReference(document))
      .then(
        (resolved) => {
          if (current)
            setDocumentPreview({ key: reference.locator, view: resolved.snapshot, error: false });
        },
        () => {
          if (current) setDocumentPreview({ key: reference.locator, view: null, error: true });
        }
      );
    return () => {
      current = false;
    };
  }, [reference.locator, document, inline, phase]);
  const isUnresolved =
    reference.status === 'unresolved' ||
    molecular.invalid ||
    Boolean(documentPreview?.key === reference.locator && documentPreview.error);
  const [expanded, setExpanded] = useState(false);
  const generatedDetailsId = useId();
  const detailsId = `ref-details-${reference.id}-${generatedDetailsId.replace(/:/g, '')}`;
  const selectionDetails = useMemo(() => structureSelectionDetails(reference), [reference]);
  const savedView = useMemo(
    () =>
      molecular.subject?.kind === 'visualization'
        ? molecular.subject.view
        : documentPreview?.key === reference.locator
          ? documentPreview.view
          : null,
    [molecular, documentPreview, reference.locator]
  );
  const destination = useMemo(
    () => (molecular.subject?.kind === 'view' ? molecular.subject.target : null),
    [molecular]
  );
  const molecularKind = molecular.invalid
    ? 'Unavailable'
    : !molecular.subject
      ? null
      : molecular.subject.kind === 'selection' || destination?.groupId
        ? 'Selection'
        : 'View';
  const molecularIcon =
    molecularKind === 'View'
      ? iconForEntityKind('molecular-document', 'h-3.5 w-3.5')
      : molecularKind === 'Selection'
        ? iconForEntityKind('annotation', 'h-3.5 w-3.5')
        : undefined;
  const [selectedSnapshotIndex, setSelectedSnapshotIndex] = useState(
    savedView?.initialSnapshotIndex ?? 0
  );
  useEffect(() => {
    setSelectedSnapshotIndex(savedView?.initialSnapshotIndex ?? 0);
  }, [savedView?.scene, savedView?.initialSnapshotIndex]);
  const navigationLabel =
    reference.entity_type === 'structure'
      ? `Open ${reference.display_label} in 3D`
      : `Open ${reference.display_label}`;
  const canReveal = inlineWorkspaceDeclarationFromReference(reference) !== null;
  const selectedViewLabel = savedView
    ? (molViewSpecStorySteps(savedView.scene)[selectedSnapshotIndex]?.title ?? savedView.title)
    : undefined;

  return (
    <span
      data-testid={`ref-object-${reference.id}`}
      data-reference-kind={molecularKind?.toLowerCase()}
      data-molecular-document-reference={document ? JSON.stringify(document) : undefined}
      data-molecular-document-locator={
        document ? molecularDocumentReferenceLocator(document) : undefined
      }
      className="inline-flex min-w-0 max-w-full flex-col align-middle"
    >
      {completedToolInput !== undefined && (
        <span
          className="sr-only"
          data-testid="tool-result"
          data-tool-name={savedView ? 'mol_save_view' : 'create_reference'}
          data-tool-status="completed"
          data-tool-input={JSON.stringify(completedToolInput)}
        >
          <span data-testid="tool-result-summary">Created {reference.entity_type} reference</span>
        </span>
      )}
      {savedView && phase !== 'draft' && !inline && (
        <span
          data-testid={`molecular-view-${reference.id}`}
          className="my-2 flex w-[40rem] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle"
        >
          <span className="px-3 pb-2 pt-3">
            <span className="block text-[10px] font-medium text-fg-muted">
              {document ? 'Molecular document' : 'Visualization'}
            </span>
            <span className="block text-sm font-semibold text-fg">{savedView.title}</span>
          </span>
          <MolecularViewPreview
            view={savedView}
            referenceId={reference.id}
            activeSnapshotIndex={selectedSnapshotIndex}
            enabled={!isUnresolved && Boolean(onClick)}
            onSnapshotIndexChange={setSelectedSnapshotIndex}
          />
          {onClick && !isUnresolved && (
            <span className="px-3 py-1 text-[11px] text-fg-muted">
              Drag to rotate · Alt/Option + scroll to zoom
            </span>
          )}
          <button
            type="button"
            aria-label={`Open saved view: ${savedView.title}`}
            disabled={busy || isUnresolved || !onClick}
            onClick={() => {
              if (savedView.initialSnapshotIndex !== undefined || selectedSnapshotIndex !== 0)
                onClick?.(reference, { snapshotIndex: selectedSnapshotIndex });
              else onClick?.(reference);
            }}
            className="group flex flex-col text-left hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50"
          >
            <span className="flex w-full items-center justify-between gap-3 px-3 pt-2">
              <span className="text-xs font-medium text-fg">View · {selectedViewLabel}</span>
              <span className="shrink-0 text-xs font-medium text-accent group-hover:underline">
                Open in 3D <span aria-hidden="true">↗</span>
              </span>
            </span>
            <span className="px-3 pb-2 pt-1 text-xs text-fg-muted" title={savedView.caption}>
              <span className="line-clamp-3">{savedView.caption}</span>
            </span>
          </button>
          {savedView.evidence.length > 0 && (
            <span className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-fg-muted">
              {savedView.evidence.map((source) => (
                <a
                  key={source.url}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {source.title}
                </a>
              ))}
            </span>
          )}
        </span>
      )}
      {(!savedView || phase === 'draft' || inline) && (
        <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
          <ChatEntityReferenceChip
            entityType={reference.entity_type}
            kindLabel={molecularKind ?? undefined}
            iconOverride={molecularIcon}
            label={reference.display_label}
            detail={reference.locator}
            onOpen={onClick ? () => onClick(reference) : undefined}
            onReveal={canReveal && onReveal ? () => onReveal(reference) : undefined}
            unavailable={isUnresolved}
            busy={busy}
            testId={`ref-chip-${reference.id}`}
            labelTestId={`ref-label-${reference.id}`}
            detailTestId={`ref-tooltip-${reference.id}`}
            attachmentPhase={phase}
            endSlot={
              phase === 'draft' && onRemove ? (
                <button
                  type="button"
                  className="entity-reference-chip__end entity-reference-chip__remove"
                  aria-label={`Remove ${reference.display_label}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRemove();
                  }}
                >
                  <XIcon size={10} />
                </button>
              ) : phase === 'sent' ? (
                <span className="entity-reference-chip__end" aria-hidden="true">
                  <PaperclipIcon size={11} />
                </span>
              ) : null
            }
          />
          {inline && molecularKind === 'Selection' && onTarget && (
            <button
              type="button"
              aria-label={`Target ${reference.display_label}`}
              title={`Focus on ${reference.display_label}`}
              disabled={busy || isUnresolved}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTarget(reference);
              }}
            >
              <TargetIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {selectionDetails && (
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px] text-fg-muted hover:bg-bg-subtle hover:text-fg"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={expanded ? 'Hide selected residues' : 'Show selected residues'}
              onClick={() => setExpanded((current) => !current)}
            >
              <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            </button>
          )}
        </span>
      )}
      {selectionDetails && expanded && (
        <span
          id={detailsId}
          data-testid={`ref-details-${reference.id}`}
          className="mt-1 flex w-[min(28rem,calc(100vw-3rem))] max-w-full flex-col gap-1.5 rounded-md border border-border bg-bg px-2.5 py-2 text-xs text-fg shadow-sm"
        >
          <span className="flex items-center justify-between gap-3">
            <span className="font-medium">
              {selectionDetails.residues.length} selected residue
              {selectionDetails.residues.length === 1 ? '' : 's'}
            </span>
            {onClick && (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
                aria-label={navigationLabel}
                onClick={() => onClick(reference)}
              >
                Open in 3D
              </button>
            )}
          </span>
          <span className="flex max-h-48 flex-col gap-1 overflow-y-auto" role="list">
            {selectionDetails.residues.map((residue, index) => (
              <span
                key={`${residue.chain}:${residue.authSeqId}:${index}`}
                data-testid={`ref-residue-${reference.id}-${index}`}
                className="grid grid-cols-[1.25rem_minmax(5rem,1fr)_auto] items-center gap-2 rounded bg-bg-muted px-1.5 py-1"
                role="listitem"
              >
                <span className="font-mono font-semibold text-accent">
                  {residue.oneLetterCode ?? '?'}
                </span>
                <span>
                  {residue.identityStatus === 'known' && residue.labelCompId
                    ? residue.labelCompId
                    : 'Identity unknown'}
                </span>
                <span className="font-mono text-fg-muted">
                  Chain {residue.chain} · {residue.authSeqId}
                </span>
              </span>
            ))}
          </span>
          {selectionDetails.omittedCount > 0 && (
            <span className="text-fg-muted">
              {selectionDetails.omittedCount} additional residue
              {selectionDetails.omittedCount === 1 ? '' : 's'} not enumerated
            </span>
          )}
        </span>
      )}
    </span>
  );
}
