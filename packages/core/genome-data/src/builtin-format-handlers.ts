import {
  FormatHandlerRegistry,
  type FormatHandler,
  type FormatInput,
  type TrackSource,
} from './format-handler';
import { formatInputUri } from './format-handler';

const ANNOTATION_RECOMMENDED_TYPES: ReadonlyArray<string> = ['annotation'];

const REFERENCE_SEQUENCE_TYPE = 'reference-sequence';

function makeToTrackSource(
  formatId: string,
  recommendedTypes: ReadonlyArray<string>
): (input: FormatInput) => TrackSource {
  return (input) => ({ uri: formatInputUri(input), formatId, input, recommendedTypes });
}

export const GFF3_FORMAT_HANDLER: FormatHandler = {
  id: 'gff3',
  extensions: ['.gff3', '.gff', '.gff3.gz', '.gff3.bgz', '.gff.gz', '.gff.bgz'],
  mimeTypes: ['application/x-gff3', 'text/x-gff3'],
  recommendedTypes: ['imported-transcript', 'generic-interval'],
  toTrackSource: makeToTrackSource('gff3', ['imported-transcript', 'generic-interval']),
};

export const GENBANK_FORMAT_HANDLER: FormatHandler = {
  id: 'genbank',
  extensions: ['.gb', '.gbk', '.gbff'],
  mimeTypes: ['chemical/seq-na-genbank', 'application/x-genbank'],
  recommendedTypes: [...ANNOTATION_RECOMMENDED_TYPES, REFERENCE_SEQUENCE_TYPE],
  toTrackSource: makeToTrackSource('genbank', [
    ...ANNOTATION_RECOMMENDED_TYPES,
    REFERENCE_SEQUENCE_TYPE,
  ]),
};

export const FASTA_FORMAT_HANDLER: FormatHandler = {
  id: 'fasta',
  extensions: ['.fa', '.fasta', '.fna', '.fa.gz', '.fasta.gz', '.fna.gz'],
  mimeTypes: ['chemical/seq-na-fasta', 'application/x-fasta', 'text/x-fasta'],
  recommendedTypes: [REFERENCE_SEQUENCE_TYPE],
  toTrackSource: makeToTrackSource('fasta', [REFERENCE_SEQUENCE_TYPE]),
};

export const BED_FORMAT_HANDLER: FormatHandler = {
  id: 'bed',
  extensions: ['.bed', '.bed.gz', '.bed.bgz'],
  mimeTypes: ['text/x-bed', 'application/x-bed'],
  recommendedTypes: ['generic-interval', 'imported-transcript'],
  toTrackSource: makeToTrackSource('bed', ['generic-interval', 'imported-transcript']),
};

export const GTF_FORMAT_HANDLER: FormatHandler = {
  id: 'gtf',
  extensions: ['.gtf', '.gtf.gz', '.gtf.bgz'],
  mimeTypes: ['text/x-gtf', 'application/x-gtf'],
  recommendedTypes: ['imported-transcript', 'generic-interval'],
  toTrackSource: makeToTrackSource('gtf', ['imported-transcript', 'generic-interval']),
};

export const GENEPRED_FORMAT_HANDLER: FormatHandler = {
  id: 'genepred',
  extensions: ['.genepred', '.genepred.gz', '.genepred.bgz'],
  mimeTypes: ['text/x-genepred'],
  recommendedTypes: ['imported-transcript'],
  toTrackSource: makeToTrackSource('genepred', ['imported-transcript']),
};

export const REFFLAT_FORMAT_HANDLER: FormatHandler = {
  id: 'refflat',
  extensions: ['.refflat', '.refflat.gz', '.refflat.bgz'],
  mimeTypes: ['text/x-refflat'],
  recommendedTypes: ['imported-transcript'],
  toTrackSource: makeToTrackSource('refflat', ['imported-transcript']),
};

export const NARROWPEAK_FORMAT_HANDLER: FormatHandler = {
  id: 'narrowpeak',
  extensions: ['.narrowpeak', '.narrowpeak.gz', '.narrowpeak.bgz'],
  mimeTypes: ['text/x-narrowpeak'],
  recommendedTypes: ['peak'],
  toTrackSource: makeToTrackSource('narrowpeak', ['peak']),
};

export const BROADPEAK_FORMAT_HANDLER: FormatHandler = {
  id: 'broadpeak',
  extensions: ['.broadpeak', '.broadpeak.gz', '.broadpeak.bgz'],
  mimeTypes: ['text/x-broadpeak'],
  recommendedTypes: ['peak'],
  toTrackSource: makeToTrackSource('broadpeak', ['peak']),
};

export const BIGWIG_FORMAT_HANDLER: FormatHandler = {
  id: 'bigwig',
  extensions: ['.bw', '.bigwig'],
  mimeTypes: ['application/x-bigwig'],
  recommendedTypes: ['quantitative'],
  toTrackSource: makeToTrackSource('bigwig', ['quantitative']),
};

export const BIGBED_FORMAT_HANDLER: FormatHandler = {
  id: 'bigbed',
  extensions: ['.bb', '.bigbed'],
  mimeTypes: ['application/x-bigbed'],
  recommendedTypes: ['generic-interval', 'imported-transcript', 'peak', 'repeat'],
  toTrackSource: makeToTrackSource('bigbed', [
    'generic-interval',
    'imported-transcript',
    'peak',
    'repeat',
  ]),
};

export const BAM_FORMAT_HANDLER: FormatHandler = {
  id: 'bam',
  extensions: ['.bam'],
  mimeTypes: ['application/x-bam'],
  recommendedTypes: ['pileup'],
  toTrackSource: makeToTrackSource('bam', ['pileup']),
};

export const CRAM_FORMAT_HANDLER: FormatHandler = {
  id: 'cram',
  extensions: ['.cram'],
  magic: new Uint8Array([0x43, 0x52, 0x41, 0x4d]),
  mimeTypes: ['application/x-cram'],
  recommendedTypes: ['pileup'],
  toTrackSource: makeToTrackSource('cram', ['pileup']),
};

export const VCF_FORMAT_HANDLER: FormatHandler = {
  id: 'vcf',
  extensions: ['.vcf', '.vcf.gz', '.vcf.bgz'],
  mimeTypes: ['text/x-vcf', 'application/x-vcf'],
  recommendedTypes: ['variant'],
  toTrackSource: makeToTrackSource('vcf', ['variant']),
};

export const BCF_FORMAT_HANDLER: FormatHandler = {
  id: 'bcf',
  extensions: ['.bcf'],
  magic: new Uint8Array([0x42, 0x43, 0x46, 0x02]),
  mimeTypes: ['application/x-bcf'],
  recommendedTypes: ['variant'],
  toTrackSource: makeToTrackSource('bcf', ['variant']),
};

export const BUILTIN_FORMAT_HANDLERS: ReadonlyArray<FormatHandler> = [
  GFF3_FORMAT_HANDLER,
  GENBANK_FORMAT_HANDLER,
  FASTA_FORMAT_HANDLER,
  BED_FORMAT_HANDLER,
  GTF_FORMAT_HANDLER,
  GENEPRED_FORMAT_HANDLER,
  REFFLAT_FORMAT_HANDLER,
  NARROWPEAK_FORMAT_HANDLER,
  BROADPEAK_FORMAT_HANDLER,
  BIGWIG_FORMAT_HANDLER,
  BIGBED_FORMAT_HANDLER,
  BAM_FORMAT_HANDLER,
  CRAM_FORMAT_HANDLER,
  VCF_FORMAT_HANDLER,
  BCF_FORMAT_HANDLER,
];

export function createDefaultFormatRegistry(): FormatHandlerRegistry {
  const registry = new FormatHandlerRegistry();
  for (const handler of BUILTIN_FORMAT_HANDLERS) {
    registry.register(handler);
  }
  return registry;
}
