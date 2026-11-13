import type { GeneModel, SequenceReader, Strand } from '@waypoint/genome-data/annotation-catalog';
import type { AnnotationCatalogGeneSpan } from '@waypoint/genome-renderer';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';

import {
  findAnnotationCatalogForDocument,
  type AnnotationCatalogForAssembly,
} from './annotation-catalog-registry';

export type CatalogSequenceDocument = Pick<
  AnnotatedSequence,
  'name' | 'length' | 'sequence' | 'annotations' | 'metadata'
>;

export function catalogDocumentIdentifiers(document: CatalogSequenceDocument): string[] {
  const identifiers = [document.name];
  for (const key of ['version', 'accession'] as const) {
    const value = document.metadata?.[key];
    if (typeof value === 'string' && value.length > 0) identifiers.push(value);
  }
  return identifiers;
}

export function catalogForSequenceDocument(
  document: CatalogSequenceDocument
): AnnotationCatalogForAssembly | null {
  return findAnnotationCatalogForDocument({
    identifiers: catalogDocumentIdentifiers(document),
    lengthBp: document.length,
  });
}

export function geneModelFromAnnotation(
  annotation: Annotation,
  sequenceLengthBp: number
): GeneModel | null {
  if (annotation.type !== 'gene') return null;
  const strand: Strand | null =
    annotation.direction === 1 ? '+' : annotation.direction === -1 ? '-' : null;
  if (strand === null) return null;
  const start = annotation.start - 1;
  const end = annotation.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > sequenceLengthBp) return null;
  const qualifiers = annotation.qualifiers ?? {};
  const locusTag = qualifiers.locus_tag?.[0] ?? null;
  const name = qualifiers.gene?.[0] ?? locusTag ?? annotation.name;
  return { name, locusTag, start, end, strand };
}

export function geneModelsFromAnnotations(
  annotations: readonly Annotation[],
  sequenceLengthBp: number
): GeneModel[] {
  const genes: GeneModel[] = [];
  for (const annotation of annotations) {
    const gene = geneModelFromAnnotation(annotation, sequenceLengthBp);
    if (gene) genes.push(gene);
  }
  return genes;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mixNumber(hash: number, value: number): number {
  return Math.imul(hash ^ value, FNV_PRIME);
}

function mixString(hash: number, value: string | null): number {
  if (value === null) return mixNumber(hash, 0x7fffffff);
  let next = mixNumber(hash, value.length);
  for (let i = 0; i < value.length; i += 1) next = mixNumber(next, value.charCodeAt(i));
  return next;
}

export function geneModelsContentKey(genes: readonly GeneModel[]): string {
  let hash = FNV_OFFSET;
  for (const gene of genes) {
    hash = mixNumber(hash, gene.start);
    hash = mixNumber(hash, gene.end);
    hash = mixNumber(hash, gene.strand === '+' ? 1 : 2);
    hash = mixString(hash, gene.name);
    hash = mixString(hash, gene.locusTag);
  }
  const first = genes[0];
  const last = genes[genes.length - 1];
  const tag = (gene: GeneModel | undefined) => gene?.locusTag ?? gene?.name ?? '';
  return `${genes.length}|${tag(first)}|${tag(last)}|${(hash >>> 0).toString(36)}`;
}

export function geneSpansByNameAndLocusTag(
  genes: readonly GeneModel[]
): ReadonlyMap<string, AnnotationCatalogGeneSpan> {
  const spans = new Map<string, AnnotationCatalogGeneSpan>();
  for (const gene of genes) {
    if (gene.locusTag !== null && !spans.has(gene.locusTag)) spans.set(gene.locusTag, gene);
  }
  for (const gene of genes) {
    if (!spans.has(gene.name)) spans.set(gene.name, gene);
  }
  return spans;
}

export function sequenceReaderFor(sequence: string): SequenceReader {
  return {
    lengthBp: sequence.length,
    slice: (start, end) => sequence.slice(start, end).toUpperCase(),
  };
}
