import type { AdmittedTrackSource, TrackSourceProvenance } from './admitted-track-source';
import type { FormatInput } from './format-handler';
import type { TextIntervalScientificKind, TextIntervalTrackFormatId } from './text-interval-track';

export interface TextIntervalTrackProvenance extends TrackSourceProvenance {
  readonly provider: 'local-file';
  readonly sourceKind: 'local-file';
  readonly label: string;
  readonly devScenarioFixture?: true;
}

export interface TextIntervalTrackSource extends Omit<
  AdmittedTrackSource,
  'formatId' | 'input' | 'provenance' | 'readerKind' | 'scientificKind'
> {
  readonly formatId: TextIntervalTrackFormatId;
  readonly input: Extract<FormatInput, { kind: 'path' }>;
  readonly readerKind: 'interval-text';
  readonly scientificKind: TextIntervalScientificKind;
  readonly provenance: TextIntervalTrackProvenance;
}

const TEXT_INTERVAL_FORMATS = new Set<string>([
  'bed',
  'gff3',
  'gtf',
  'genepred',
  'refflat',
  'narrowpeak',
  'broadpeak',
]);

export function isTextIntervalTrackSource(
  source: AdmittedTrackSource
): source is TextIntervalTrackSource {
  if (
    source.readerKind !== 'interval-text' ||
    !TEXT_INTERVAL_FORMATS.has(source.formatId) ||
    source.input?.kind !== 'path' ||
    !['transcript', 'interval', 'peak', 'repeat'].includes(source.scientificKind)
  ) {
    return false;
  }
  return (
    source.input.path.trim().length > 0 &&
    source.provenance.provider === 'local-file' &&
    source.provenance.sourceKind === 'local-file' &&
    typeof source.provenance.label === 'string' &&
    source.provenance.label.trim().length > 0 &&
    (source.provenance.devScenarioFixture === undefined ||
      source.provenance.devScenarioFixture === true)
  );
}
