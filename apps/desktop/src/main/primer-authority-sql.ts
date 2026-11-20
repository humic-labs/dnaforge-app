export function canonicalPrimerProjectionSql(id: string, details: string): string {
  return `(COALESCE(CASE WHEN json_valid(${details}) THEN json_extract(${details},'$.authority') END,'')='primer_artifact'
    OR EXISTS(SELECT 1 FROM catalog_entities WHERE id=${id} AND type='primer')
    OR EXISTS(SELECT 1 FROM lims_entity WHERE id=${id} AND kind IN ('oligo','rna_oligo')))`;
}
