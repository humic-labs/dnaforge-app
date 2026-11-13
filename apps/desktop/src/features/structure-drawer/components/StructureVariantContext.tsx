import { useStructureLinkRegistry } from '../state/use-structure-link-registry';
import { structureResiduesForLinkedResidueIndex } from '../utils/residue-target-mapping';
import type { StructureDrawerRequest } from '../types/structure-drawer';

export function StructureVariantContext({
  request,
  structureId,
  ownerId,
  ready,
}: {
  request: StructureDrawerRequest;
  structureId?: string;
  ownerId?: string;
  ready: boolean;
}) {
  const links = useStructureLinkRegistry((state) => state.links);
  const context = request.variantContext;
  if (!context) return null;
  const reference = request.comparisonOf ?? request.alleleOf ?? request;
  const product = context.product;
  const indices =
    request.alleleOf && product?.status === 'complete'
      ? product.alternateToReference.flatMap((ref, alternate) =>
          ref !== null && context.residueIndices.includes(ref) ? [alternate] : []
        )
      : context.residueIndices;
  const consequence = {
    synonymous: 'The allele preserves the encoded amino acid.',
    missense:
      'The allele changes the encoded amino acid. Alternate side chains have not been modeled.',
    'stop-gained':
      'The allele introduces a stop. This reference tail would be absent from the truncated product.',
    'conditional-stop':
      'This codon can also terminate translation. The sequence does not establish the proportions of full-length and truncated products.',
    frameshift:
      'The indel changes the reading frame. The downstream reference is affected; its new sequence and backbone are not represented by these coordinates.',
    'in-frame-insertion':
      'The highlighted residues flank the insertion junction. Inserted residues have no coordinates in this reference structure.',
    'in-frame-deletion':
      'The highlighted reference codons overlap the deleted DNA. The resulting backbone has not been modeled.',
  }[context.proteinEffect ?? 'missense'];
  const link = Object.values(links).find(
    (entry) =>
      entry.structureId === structureId &&
      entry.ownerId === ownerId &&
      entry.sequenceDocumentId === request.entityId
  );
  const mappedCount = link
    ? indices.filter((index) => structureResiduesForLinkedResidueIndex(link, index).length > 0)
        .length
    : 0;
  return (
    <div
      data-testid="structure-variant-context"
      className="border-b border-border bg-bg-subtle px-3 py-2 text-xs"
    >
      <div className="font-medium">
        DNA {context.position}: {context.referenceBase || '∅'} → {context.alternateBase || '∅'} ·
        reference {reference.cdsLabel} residue
        {context.residueIndices.length === 1 ? '' : 's'}{' '}
        {context.residueIndices
          .slice(0, 8)
          .map((index) => index + 1)
          .join(', ')}
        {context.residueIndices.length > 8 && `, and ${context.residueIndices.length - 8} more`}
      </div>
      {!!context.changes?.length && (
        <div data-testid="structure-encoded-changes">
          Encoded by this allele:{' '}
          {context.changes
            .map(
              (change) =>
                `${change.reference}${change.residue} → ${change.alternate === '*' ? 'stop' : change.alternate}`
            )
            .join('; ')}
        </div>
      )}
      {context.affectedTail && (
        <div data-testid="structure-affected-tail">
          Affected reference tail: {context.affectedTail.start}–{context.affectedTail.end}.
        </div>
      )}
      {context.product && (
        <div data-testid="structure-allele-product">
          {context.product.status === 'complete'
            ? `This allele encodes ${context.product.sequence.length} amino acids; the reference has ${context.product.referenceLength}.`
            : `Allele product unresolved: ${context.product.reason}`}
        </div>
      )}
      <details className="text-fg-muted">
        <summary className="cursor-pointer">
          {request.comparisonOf
            ? 'Reference / allele comparison'
            : request.alleleOf
              ? 'Allele protein context'
              : 'Reference protein context'}{' '}
          · evidence and mapping
        </summary>
        <div className="break-words">{context.trackLabel}</div>
        {context.product && (
          <div>Each allele is evaluated separately, without combining other calls.</div>
        )}
        <div>
          {request.comparisonOf
            ? 'Showing independently sourced reference and allele coordinates after a rigid alignment. Only atoms present in those models are drawn.'
            : request.alleleOf
              ? 'Showing coordinates for this single-allele protein product. Use Reference protein to compare its original structure.'
              : context.proteinEffect
                ? consequence
                : 'Showing structural context for the reference sequence. Alternate side chains have not been modeled.'}
        </div>
        {ready && (
          <div data-testid="structure-variant-mapping-status" className="text-fg-muted">
            {mappedCount === indices.length
              ? indices.length
                ? 'All selected residues have mapped structure coordinates.'
                : 'The changed reference position has no corresponding residue in this allele product.'
              : `${mappedCount} of ${indices.length} selected residues have mapped coordinates; unmapped residues remain selected in the sequence.`}
          </div>
        )}
      </details>
    </div>
  );
}
