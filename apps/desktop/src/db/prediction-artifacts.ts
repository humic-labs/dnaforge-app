import { getConnection } from './index';

export async function listPredictionArtifactRows(sequenceSha256: string) {
  const sqlite = await getConnection();
  return sqlite.select<Array<{ id: string; summary: string; chain: string }>>(
    `SELECT er.id,
      json_remove(er.data, '$.coordinates', '$.chains', '$.run.settings') AS summary,
      chain.value AS chain
    FROM entity_references er, json_each(CASE WHEN json_valid(er.data) THEN er.data ELSE '{}' END, '$.chains') chain
    WHERE er.entity_type = 'protein-prediction'
      AND json_extract(er.data, '$.kind') = 'protein-prediction-result'
      AND json_extract(chain.value, '$.sequenceSha256') = ?
    ORDER BY json_extract(er.data, '$.run.createdAt') DESC, er.id, json_extract(chain.value, '$.chainId')`,
    [sequenceSha256]
  );
}
