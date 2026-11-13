import { computeChecksum, updateGenBankGeneticCodeComment } from '@waypoint/sequence-utils';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { updateGenBankLocusMetadata } from '../shared/genbank-locus-metadata';
import type { SequenceMetadataRevisionRequest } from '../shared/sequence-package-revision';
import {
  normalizeSchemaBoundSequenceEntity,
  type SequencePackageDocument,
} from './sequence-package';

export async function prepareSequenceMetadataEdit(input: {
  current: SequencePackageDocument;
  proposed: SequenceMetadataRevisionRequest['proposed'];
  beforeProduct: string;
  productPath: string;
}) {
  const { current, proposed, beforeProduct, productPath } = input;
  const name = proposed.name?.trim();
  if (!name || /[\r\n]/.test(name)) throw new Error('Sequence name must be one non-empty line.');
  const topology = proposed.topology ?? current.product.topology;
  if (topology !== undefined && topology !== 'linear' && topology !== 'circular') {
    throw new Error('Sequence topology is invalid.');
  }
  const entity = normalizeSchemaBoundSequenceEntity(proposed.entity);
  const locus = (fields: Record<string, unknown>) => {
    const value = fields.locus;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const oldLocus = locus(current.entity.fields);
  const newLocus = locus(entity.fields);
  let afterProduct = beforeProduct;
  if (newLocus !== undefined && newLocus !== oldLocus) {
    afterProduct = updateGenBankLocusMetadata(afterProduct, { name: newLocus });
  }
  if (topology !== undefined && topology !== current.product.topology) {
    afterProduct = updateGenBankLocusMetadata(afterProduct, { topology });
  }
  if (proposed.geneticCode !== undefined) {
    afterProduct = updateGenBankGeneticCodeComment(afterProduct, proposed.geneticCode);
  }
  const beforeSequence = parseSequenceFileAsDocument(beforeProduct, productPath).sequence;
  const afterSequence = parseSequenceFileAsDocument(afterProduct, productPath).sequence;
  if (beforeSequence.sequence !== afterSequence.sequence) {
    throw new Error('A metadata edit cannot change sequence bases.');
  }
  const productChanged = afterProduct !== beforeProduct;
  const next: SequencePackageDocument = {
    ...current,
    name,
    entity,
    product: {
      ...current.product,
      ...(topology !== undefined ? { topology } : {}),
      ...(productChanged
        ? {
            sequenceChecksum: await computeChecksum(afterSequence.sequence),
            genBankChecksum: await computeChecksum(afterProduct),
          }
        : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  return {
    next,
    afterProduct,
    productChanged,
    changed:
      productChanged ||
      name !== current.name ||
      JSON.stringify(entity) !== JSON.stringify(current.entity) ||
      topology !== current.product.topology,
  };
}

export function stableSequencePackageRequestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSequencePackageRequestJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSequencePackageRequestJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
