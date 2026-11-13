import type { Annotation } from '@waypoint/sequence-utils';
import { featureAliases } from '@waypoint/sequence-utils';
import type { ResolveHints } from '../types/structure-drawer';

export function extractHintsFromAnnotation(annotation: Annotation): ResolveHints {
  const aliases = featureAliases(annotation);
  const taxonXref = aliases.xrefs.find((xref) => xref.db.toLowerCase() === 'taxon');
  const taxonId = taxonXref ? Number.parseInt(taxonXref.id, 10) : NaN;

  return {
    dbXrefs: annotation.qualifiers?.db_xref,
    proteinId: annotation.qualifiers?.protein_id?.[0],
    locusTag: aliases.locusTag,
    geneName: aliases.geneSymbol,
    taxonId: Number.isNaN(taxonId) ? undefined : taxonId,
  };
}
