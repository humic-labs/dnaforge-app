import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import { Button, Notice } from '../../../components/ui';
import {
  acceptedAssemblyUsesOfOligo,
  type AcceptedAssemblyOligoPrimerUse,
  type AcceptedAssemblyOligoUse,
} from '../../assembly/public/accepted-oligo-uses';
import {
  assemblyUsesOfOligo,
  formatSourceSite,
  type OligoAssemblyUse,
  type SavedOligoSnapshot,
} from '../../design/public/saved-primer-links';
import { useDesignStore } from '../../design/public/store';
import { openDocument } from '../../document-opening/public/open-document';
import { describeAssemblyTmContext } from '../../junction-workbench/public/settings';
import type { PrimerArtifactV1 } from '../primer-artifact';
import { savedOligoSnapshot } from '../saved-oligo-snapshot';

const METHOD_LABELS: Record<OligoAssemblyUse['use']['assemblyMethod'], string> = {
  gibson: 'Gibson',
  nebuilder: 'NEBuilder',
  goldengate: 'Golden Gate',
};

const STATE_WARNINGS: Record<OligoAssemblyUse['state'], string | null> = {
  current: null,
  'draft-primer-changed': 'The draft primer no longer matches this oligo.',
  'oligo-bases-changed': "This oligo's bases changed after it was linked.",
};

function sourceAttachmentNote(attachment: OligoAssemblyUse['sourceAttachment']): string | null {
  switch (attachment.kind) {
    case 'agrees':
      return `Same site as this oligo's saved attachment (${attachment.binding.placement} placement${
        attachment.binding.confirmed ? ', matcher-confirmed' : ''
      })`;
    case 'differs':
      return "This oligo's saved attachment on that source is at a different site";
    case 'none':
      return null;
    default:
      return attachment satisfies never;
  }
}

function savedTmLine(oligo: SavedOligoSnapshot, evaluatesBindingPart: boolean): string | null {
  if (oligo.tmC === null) return null;
  return [
    `Saved oligo Tm ${oligo.tmC.toFixed(1)} °C`,
    oligo.tmModelLabel,
    oligo.tmConcentrationNm === null ? null : `${oligo.tmConcentrationNm} nM`,
    evaluatesBindingPart ? 'binding part' : 'evaluated bases not recorded',
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function formatAcceptedAt(value: string): string {
  const accepted = new Date(value);
  return Number.isNaN(accepted.getTime())
    ? value
    : accepted.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function acceptedPrimerIdentity(primer: AcceptedAssemblyOligoPrimerUse): string {
  const part = primer.partNumber === null ? 'Part unavailable' : `Part ${primer.partNumber}`;
  return [part, primer.direction, primer.primerName]
    .filter((item): item is string => Boolean(item))
    .join(' · ');
}

function useAcceptedAssemblyUses(oligoId: string): readonly AcceptedAssemblyOligoUse[] {
  const [uses, setUses] = useState<readonly AcceptedAssemblyOligoUse[]>([]);
  useEffect(() => {
    let cancelled = false;
    const apply = (next: readonly AcceptedAssemblyOligoUse[]) => {
      if (cancelled) return;
      setUses((previous) => (previous.length === 0 && next.length === 0 ? previous : next));
    };
    apply([]);
    acceptedAssemblyUsesOfOligo({ oligoId })
      .then((report) => apply(report.uses))
      .catch(() => apply([]));
    return () => {
      cancelled = true;
    };
  }, [oligoId]);
  return uses;
}

export function PrimerAssemblyUses({ artifact }: { artifact: PrimerArtifactV1 }) {
  const designs = useDesignStore((state) => state.designs);
  const linkingDesigns = useMemo(
    () =>
      Object.values(designs).filter((design) =>
        design.savedPrimerLinks?.some((link) => link.oligoId === artifact.id)
      ),
    [artifact.id, designs]
  );
  const linked = useMemo(() => {
    if (linkingDesigns.length === 0) return null;
    const oligo = savedOligoSnapshot(artifact);
    return { oligo, uses: assemblyUsesOfOligo(oligo, linkingDesigns) };
  }, [artifact, linkingDesigns]);
  const acceptedUses = useAcceptedAssemblyUses(artifact.id);
  const [openError, setOpenError] = useState<UserMessage | null>(null);

  const draftUses = linked?.uses ?? [];
  if (draftUses.length === 0 && acceptedUses.length === 0) return null;

  const reportOpenResult = (result: Awaited<ReturnType<typeof openDocument>>) => {
    if (result.status === 'presented' || result.status === 'cancelled') return;
    setOpenError(toUserMessage(result.message, 'operation.failed'));
  };

  const openDesign = (item: OligoAssemblyUse) => {
    setOpenError(null);
    void openDocument({
      target: { kind: 'record', tabType: 'design', entityId: item.use.designId },
      label: item.use.designName,
    }).then(reportOpenResult);
  };

  const openAcceptedPackage = (item: AcceptedAssemblyOligoUse) => {
    setOpenError(null);
    void openDocument({
      target: { kind: 'sequence-package', path: item.packageRoot },
      label: item.designName,
    }).then(reportOpenResult);
  };

  return (
    <section
      data-testid="primer-assembly-uses"
      aria-label="Assemblies using this oligo"
      className="max-h-72 shrink-0 overflow-y-auto border-t border-border bg-bg px-8 py-3"
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
        Used in assemblies
      </h2>
      {openError ? <Notice tone="error">{openError}</Notice> : null}
      {acceptedUses.length > 0 ? (
        <div data-testid="primer-accepted-assembly-uses">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            Accepted (finalized) assemblies
          </h3>
          <ul className="divide-y divide-border">
            {acceptedUses.map((item) => (
              <PrimerAcceptedAssemblyUse
                key={`${item.packageRoot}:${item.acceptedAssemblyVersionId}`}
                item={item}
                oligoRevision={artifact.artifactRevision}
                onOpenPackage={openAcceptedPackage}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {draftUses.length > 0 && linked ? (
        <div data-testid="primer-draft-assembly-uses">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
            Draft designs
          </h3>
          <ul className="divide-y divide-border">
            {draftUses.map((item) => (
              <PrimerAssemblyUse
                key={`${item.use.designId}:${item.use.primerId}`}
                item={item}
                oligo={linked.oligo}
                evaluatesBindingPart={Boolean(artifact.annealing)}
                onOpenDesign={openDesign}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PrimerAcceptedAssemblyUse({
  item,
  oligoRevision,
  onOpenPackage,
}: {
  item: AcceptedAssemblyOligoUse;
  oligoRevision: number;
  onOpenPackage: (item: AcceptedAssemblyOligoUse) => void;
}) {
  return (
    <li
      data-testid="primer-accepted-assembly-use"
      data-construct-id={item.constructId}
      data-accepted-assembly-version-id={item.acceptedAssemblyVersionId}
      data-accepted-record={item.isCurrentAccepted ? 'current' : 'superseded'}
      className="space-y-1.5 py-3 text-xs text-fg"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          data-testid="primer-accepted-assembly-use-open"
          title="Open this finalized assembly package"
          onClick={() => onOpenPackage(item)}
        >
          {item.designName}
        </Button>
        <span className="text-fg-muted">
          {`${item.isCurrentAccepted ? 'Accepted' : 'Superseded accepted version'} · ${
            METHOD_LABELS[item.assemblyMethod]
          } · ${formatAcceptedAt(item.acceptedAt)}`}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {item.primers.map((primer) => (
          <li
            key={primer.primerId}
            data-testid="primer-accepted-assembly-use-primer"
            data-primer-id={primer.primerId}
            className="space-y-1 py-1.5"
          >
            <p className="text-fg-muted">{acceptedPrimerIdentity(primer)}</p>
            <p data-testid="primer-accepted-assembly-use-revision" className="text-fg-muted">
              {`Accepted with oligo revision ${primer.artifactRevision}${
                oligoRevision > primer.artifactRevision
                  ? `; this oligo is now revision ${oligoRevision}`
                  : ''
              }`}
            </p>
            {primer.sequence === null ? (
              <p data-testid="primer-accepted-assembly-use-bases" className="text-fg-muted">
                Ordered bases were not recorded with this accepted assembly
              </p>
            ) : (
              <dl className="space-y-1">
                <div data-testid="primer-accepted-assembly-use-tail" className="flex gap-3">
                  <dt className="w-32 shrink-0 text-fg-muted">
                    {`5′ tail (${(primer.tailSequence ?? '').length} nt)`}
                  </dt>
                  <dd className="min-w-0 break-all text-fg-muted">
                    {primer.tailSequence ? (
                      <span className="font-mono">{primer.tailSequence}</span>
                    ) : (
                      'None'
                    )}
                  </dd>
                </div>
                <div data-testid="primer-accepted-assembly-use-binding" className="flex gap-3">
                  <dt className="w-32 shrink-0 text-fg-muted">
                    {`Binding part (${(primer.bindingSequence ?? '').length} nt)`}
                  </dt>
                  <dd className="min-w-0 break-all font-mono text-fg">
                    {primer.bindingSequence || primer.sequence}
                  </dd>
                </div>
              </dl>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

function PrimerAssemblyUse({
  item,
  oligo,
  evaluatesBindingPart,
  onOpenDesign,
}: {
  item: OligoAssemblyUse;
  oligo: SavedOligoSnapshot;
  evaluatesBindingPart: boolean;
  onOpenDesign: (item: OligoAssemblyUse) => void;
}) {
  const { use, link } = item;
  const tm = describeAssemblyTmContext(item.polymerase);
  const warning = STATE_WARNINGS[item.state];
  const attachmentNote = sourceAttachmentNote(item.sourceAttachment);
  const savedTm = savedTmLine(oligo, evaluatesBindingPart);
  const concentrationsDiffer =
    use.tmC !== null &&
    savedTm !== null &&
    oligo.tmConcentrationNm !== null &&
    oligo.tmConcentrationNm !== tm.primerConcNm;

  return (
    <li
      data-testid="primer-assembly-use"
      data-design-id={use.designId}
      data-primer-id={use.primerId}
      data-link-state={item.state}
      className="space-y-1.5 py-3 text-xs text-fg"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          data-testid="primer-assembly-use-open-design"
          title="Open this assembly design"
          onClick={() => onOpenDesign(item)}
        >
          {use.designName}
        </Button>
        <span className="text-fg-muted">
          {`Part ${use.partNumber} · ${use.direction} · ${METHOD_LABELS[use.assemblyMethod]} · design version ${use.designVersion}`}
        </span>
      </div>
      <p data-testid="primer-assembly-use-revision" className="text-fg-muted">
        {`Linked at design version ${link.linkedAtDesignVersion}, oligo revision ${link.artifactRevision}${
          item.oligoRevisedSinceLink ? `; this oligo is now revision ${oligo.artifactRevision}` : ''
        }`}
      </p>
      {warning ? <p className="text-warning">{warning}</p> : null}
      <dl className="space-y-1">
        <div data-testid="primer-assembly-use-tail" className="flex gap-3">
          <dt className="w-32 shrink-0 text-fg-muted">{`5′ tail (${use.tailSequence.length} nt)`}</dt>
          <dd className="min-w-0 break-all text-fg-muted">
            {use.tailSequence ? <span className="font-mono">{use.tailSequence}</span> : 'None'}
          </dd>
        </div>
        <div data-testid="primer-assembly-use-binding" className="flex gap-3">
          <dt className="w-32 shrink-0 text-fg-muted">
            {`Binding part (${use.bindingSequence.length} nt)`}
          </dt>
          <dd className="min-w-0 break-all font-mono text-fg">{use.bindingSequence}</dd>
        </div>
      </dl>
      <div data-testid="primer-assembly-use-source">
        <p>
          {use.sourceSite
            ? `Binds ${use.sourceSite.name} ${formatSourceSite(use.sourceSite)}`
            : 'Source binding site unavailable for this primer'}
        </p>
        {attachmentNote ? <p className="text-fg-muted">{attachmentNote}</p> : null}
      </div>
      <div data-testid="primer-assembly-use-tm">
        <p>
          {use.tmC === null
            ? 'Assembly Tm unavailable'
            : `Assembly Tm ${use.tmC.toFixed(1)} °C · binding part · ${tm.modelLabel} · ${tm.primerConcNm} nM`}
        </p>
        {savedTm ? <p>{savedTm}</p> : null}
        {concentrationsDiffer ? (
          <p className="text-fg-muted">The two values use different primer concentrations.</p>
        ) : null}
      </div>
    </li>
  );
}
