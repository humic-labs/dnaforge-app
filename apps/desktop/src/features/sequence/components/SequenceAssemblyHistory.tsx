import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import type { AcceptedAssemblySidecarPayload } from '../../assembly/public/accepted-types';
import { acceptedHistoryBackboneSegments } from '../../assembly/public/accepted-history-presentation';
import { openAssemblySourceRegion } from '../../assembly/public/open-assembly-source';
import { getFragmentHexForRegion } from '../../design/public/colors';
import { useAssemblyColorScheme } from '../../design/public/color-scheme-store';
import { ProductSegmentCard } from '../../assembly-panel/public/components/ProductSegmentCard';
import { Button } from '../../../components/ui';
import { MetadataList, MetadataRow } from '../../../shared/components/MetadataSection';
import { JunctionWorkbench } from '../../junction-workbench/public';
import {
  acceptedAssemblyVersionFromSidecar,
  sequenceDesignFromAcceptedAssemblyVersion,
} from '../../assembly/public/accepted-reopen';

export function SequenceAssemblyHistory({
  entries,
  productSequence,
  onBackboneSegmentsChange,
  onReopenAssembly,
  assemblyReopenStatus,
  assemblyReopenError,
  currentEntry = true,
  onPartHoverChange,
}: {
  entries: AcceptedAssemblySidecarPayload[];
  productSequence: string;
  onBackboneSegmentsChange?: (segments: BackboneSegment[] | undefined) => void;
  onReopenAssembly?: () => Promise<void>;
  assemblyReopenStatus: string;
  assemblyReopenError?: string | null;
  currentEntry?: boolean;
  onPartHoverChange?: (index: number | null) => void;
}) {
  const scheme = useAssemblyColorScheme();
  const [hoveredEntry, setHoveredEntry] = useState<number | null>(null);
  const [hoveredPart, setHoveredPart] = useState<number | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const segments = useMemo(
    () =>
      hoveredEntry === null || !entries[hoveredEntry]
        ? undefined
        : acceptedHistoryBackboneSegments(
            entries[hoveredEntry],
            productSequence,
            hoveredPart,
            scheme
          ),
    [entries, hoveredEntry, hoveredPart, productSequence, scheme]
  );
  useEffect(() => {
    onBackboneSegmentsChange?.(segments);
  }, [onBackboneSegmentsChange, segments]);
  useEffect(() => () => onBackboneSegmentsChange?.(undefined), [onBackboneSegmentsChange]);

  const preview = (entryIndex: number, partIndex: number | null = null) => {
    setHoveredEntry(entryIndex);
    setHoveredPart(partIndex);
    onPartHoverChange?.(partIndex);
  };
  const clearPreview = () => {
    setHoveredEntry(null);
    setHoveredPart(null);
    onPartHoverChange?.(null);
  };
  const openSource = async (entry: AcceptedAssemblySidecarPayload, partIndex: number) => {
    const part = entry.projectionInput.regions[partIndex];
    const provenance = entry.projectionInput.sourceProvenance.find(
      (source) => source.regionId === part.id
    );
    setSourceError(null);
    try {
      await openAssemblySourceRegion(part, { provenance });
    } catch (reason) {
      setSourceError(toUserMessage(reason, 'failure.source-sequence-could-not-be-opened'));
    }
  };

  return (
    <section
      className="mt-4 rounded border border-border"
      data-testid="sequence-assembly-history"
      onPointerEnter={() => preview(0)}
      onPointerLeave={clearPreview}
      onFocus={(event) => {
        if (!event.target.closest('[data-assembly-product-segment-card]')) preview(0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) clearPreview();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold text-fg">Assembly</h3>
        {entries.length > 0 && onReopenAssembly ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="metadata-edit-assembly"
            disabled={assemblyReopenStatus !== 'available' && assemblyReopenStatus !== 'error'}
            onClick={() => void onReopenAssembly()}
          >
            {assemblyReopenStatus === 'opening' ? 'Opening…' : 'Edit assembly'}
          </Button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          Assembly history could not be read.
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {entries.map((entry, entryIndex) => (
            <li
              key={entry.acceptedAssemblyVersionId ?? entry.acceptedVersionId ?? entryIndex}
              data-accepted-assembly-version-id={
                entry.acceptedAssemblyVersionId ?? entry.acceptedVersionId
              }
              className="px-3 py-3"
              onPointerEnter={() => preview(entryIndex)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-fg">
                  {assemblyMethodLabel(entry.construction.method)} assembly
                  {entryIndex === 0 && currentEntry ? ' · Current' : ''}
                </span>
                <time className="text-[11px] text-fg-muted" dateTime={entry.acceptedAt}>
                  {assemblyDateLabel(entry.acceptedAt)}
                </time>
              </div>
              <ol className="mt-2 space-y-1.5" aria-label="Assembly parts">
                {entry.projectionInput.regions.map((part, partIndex) => (
                  <li key={`${part.id}-${partIndex}`}>
                    <ProductSegmentCard
                      shellTestId={`assembly-history-part-shell-${entryIndex}-${partIndex}`}
                      cardTestId={`assembly-history-part-${entryIndex}-${partIndex}`}
                      role="button"
                      ariaLabel={`Open source ${part.sourceSequenceName}`}
                      draggable={false}
                      color={getFragmentHexForRegion(part, partIndex, scheme)}
                      isDragging={false}
                      isSelected={hoveredEntry === entryIndex && hoveredPart === partIndex}
                      onPointerEnter={() => preview(entryIndex, partIndex)}
                      onPointerLeave={() => preview(entryIndex)}
                      onFocus={() => preview(entryIndex, partIndex)}
                      onClick={() => void openSource(entry, partIndex)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          void openSource(entry, partIndex);
                        }
                      }}
                    >
                      <span className="shrink-0 text-[11px] font-semibold text-fg-muted">
                        {partIndex + 1}
                      </span>
                      <span className="min-w-0 break-words text-[11px] text-fg">
                        {part.sourceSequenceName}
                        <span className="ml-1 text-fg-muted">
                          {part.sourceType === 'pcr' ? 'PCR' : 'digest'}
                        </span>
                      </span>
                    </ProductSegmentCard>
                  </li>
                ))}
              </ol>
              <AssemblyHistoryJunctions entry={entry} />
            </li>
          ))}
        </ol>
      )}
      {sourceError ? (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          {toUserMessage(sourceError, 'tracks.loadFailed')}
        </p>
      ) : null}
      {assemblyReopenError ? (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          {toUserMessage(assemblyReopenError, 'tracks.loadFailed')}
        </p>
      ) : null}
    </section>
  );
}

function AssemblyHistoryJunctions({ entry }: { entry: AcceptedAssemblySidecarPayload }) {
  const design = useMemo(() => {
    const version = acceptedAssemblyVersionFromSidecar(entry);
    return sequenceDesignFromAcceptedAssemblyVersion(version, {
      designId: version.id,
      now: new Date(entry.acceptedAt),
    });
  }, [entry]);
  return (
    <section className="mt-3" aria-label="Assembly junctions">
      <JunctionWorkbench key={design.id} design={design} readOnly />
      <AssemblyRecipeDetails entry={entry} />
    </section>
  );
}

function AssemblyRecipeDetails({ entry }: { entry: AcceptedAssemblySidecarPayload }) {
  const input = entry.projectionInput;
  const joins =
    input.topology === 'circular' ? input.regions.length : Math.max(0, input.regions.length - 1);
  return (
    <div className="mt-3 space-y-4">
      {joins > 0 ? (
        <section aria-label="Assembly joins">
          <h4 className="mb-2 text-xs font-semibold text-fg">Joins and overlaps</h4>
          <ol className="space-y-3">
            {Array.from({ length: joins }, (_, index) => {
              const next = (index + 1) % input.regions.length;
              const overlap = input.homologyRegions.find(
                (region) => region.junctionIndex === index
              );
              const overhang = input.goldenGateJunctions?.find(
                (junction) => junction.junctionIndex === index
              );
              const spacers = input.spacers.filter((spacer) => spacer.junctionIndex === index);
              return (
                <li key={index} data-testid={`assembly-recipe-join-${index}`}>
                  <p className="mb-1 text-xs font-medium text-fg">
                    Part {index + 1} → Part {next + 1}
                    {next === 0 ? ' · closing join' : ''}
                  </p>
                  <MetadataList>
                    {overlap ? (
                      <>
                        <MetadataRow label="Overlap">
                          {
                            <span>
                              {overlap.encoding.onLeft + overlap.encoding.onRight} bp overlap
                            </span>
                          }
                        </MetadataRow>
                        <MetadataRow label="Bases">
                          {
                            <span className="break-all font-mono">
                              {overlap.metadata?.sequence ?? 'Sequence not recorded'}
                            </span>
                          }
                        </MetadataRow>
                        <MetadataRow label="Distribution">{`${overlap.encoding.onLeft} bp from left · ${overlap.encoding.onRight} bp from right`}</MetadataRow>
                        {overlap.templateBasis?.spacerLength ? (
                          <MetadataRow label="Spacer in overlap">
                            {overlap.templateBasis.spacerContributesToAnnealing
                              ? 'Included'
                              : 'Excluded'}
                          </MetadataRow>
                        ) : null}
                      </>
                    ) : null}
                    {overhang ? (
                      <>
                        <MetadataRow label="Overhang">
                          {<span className="break-all font-mono">{overhang.overhang}</span>}
                        </MetadataRow>
                        <MetadataRow label="Enzyme">
                          {input.goldenGateConfig?.enzyme ?? 'Not recorded'}
                        </MetadataRow>
                        <MetadataRow label="Overhang source">
                          {overhang.source.type === 'rd-fixed'
                            ? 'Fixed by restriction digest'
                            : overhang.source.type === 'pcr-matched-rd'
                              ? 'PCR matches restriction digest'
                              : 'Designed PCR overhang'}
                        </MetadataRow>
                      </>
                    ) : null}
                    {spacers.map((spacer) => (
                      <MetadataRow key={spacer.id} label="Spacer">
                        {<span className="break-all font-mono">{spacer.sequence}</span>}
                      </MetadataRow>
                    ))}
                    {!overlap && !overhang ? (
                      <MetadataRow label="Overlap">{'No overlap recorded'}</MetadataRow>
                    ) : null}
                  </MetadataList>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {input.designPrimers.length > 0 ? (
        <section aria-label="Assembly primers">
          <h4 className="mb-2 text-xs font-semibold text-fg">Primers · 5′ to 3′</h4>
          <ol className="space-y-3">
            {input.designPrimers
              .flatMap((pair) => [pair.forward, pair.reverse])
              .map((primer) => (
                <li key={primer.id} data-testid={`assembly-recipe-primer-${primer.id}`}>
                  <p className="mb-1 text-xs font-medium text-fg">
                    {primer.name} · Part {primer.fragmentIndex + 1} · {primer.direction}
                  </p>
                  <MetadataList>
                    <MetadataRow label="Full sequence">
                      {<span className="break-all font-mono">{primer.sequence}</span>}
                    </MetadataRow>
                    <MetadataRow label="Binding site">
                      {<span className="break-all font-mono">{primer.pbs.sequence}</span>}
                    </MetadataRow>
                    <MetadataRow label="5′ tail">
                      {
                        <span className="break-all font-mono">
                          {primer.overhang.sequence || 'None'}
                        </span>
                      }
                    </MetadataRow>
                  </MetadataList>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function assemblyMethodLabel(method: string): string {
  if (method === 'gibson') return 'Gibson';
  if (method === 'nebuilder') return 'NEBuilder';
  if (method === 'goldengate') return 'Golden Gate';
  return method;
}

function assemblyDateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
