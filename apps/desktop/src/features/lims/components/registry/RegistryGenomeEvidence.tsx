import type { LimsRegistryPreview } from '../../../../shared/lims';
import { registryConfidenceLabel } from '../../../../shared/strain-genome-evidence';
import { MetadataRow, MetadataList } from '../../../../shared/components/MetadataSection';

export function RegistryGenomeEvidence({ preview }: { preview: LimsRegistryPreview }) {
  const evidence = preview.summary.evidenceSummary;
  if (preview.entity.kind !== 'strain' || !evidence) return null;
  const label = preview.strainGenomeSummary
    ? registryConfidenceLabel(preview.strainGenomeSummary)
    : evidence.confidenceLabel;
  const genomes = [
    ['Parent genome', evidence.parentGenomeName],
    ['Genome hypothesis', evidence.hypothesisGenomeName],
    ['Verified genome', evidence.verifiedGenomeName],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <section aria-label="Genome links" className="space-y-2">
      <h3 className="text-xs font-semibold text-fg-muted">Genome links</h3>
      {genomes.length > 0 ? (
        <MetadataList>
          {genomes.map(([role, name]) => (
            <MetadataRow key={role} label={role}>
              {name}
            </MetadataRow>
          ))}
        </MetadataList>
      ) : null}
      <p className="text-xs text-fg-muted">{label}</p>
      {genomes.length > 0 ? <p className="text-xs text-fg-muted">{evidence.gapMessage}</p> : null}
    </section>
  );
}
