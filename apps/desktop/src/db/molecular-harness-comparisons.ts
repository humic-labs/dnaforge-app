import { createEntityReference, type DBEntityReference } from './entity-references';
import { getConnection } from './index';
import {
  MOLECULAR_HARNESS_COMPARISON_CHANGE_EVENT,
  parseMolecularHarnessComparison,
  type MolecularHarnessComparison,
} from '../features/ai/molecular-harness-comparison';

const ENTITY_TYPE = 'protein_visual_benchmark_run';
const SOURCE = 'dnaforge-dev-protein-visualization';

export interface MolecularHarnessComparisonRecord {
  id: string;
  title: string;
  createdAt: number;
  comparison: MolecularHarnessComparison;
}

function fromRow(row: DBEntityReference): MolecularHarnessComparisonRecord | null {
  try {
    const data = JSON.parse(row.data ?? 'null') as Record<string, unknown> | null;
    if (data?.kind !== ENTITY_TYPE || data.version !== 1) return null;
    const comparison = parseMolecularHarnessComparison(data.comparison);
    if (!comparison) return null;
    return {
      id: row.id,
      title: row.display_label,
      createdAt: row.created_at,
      comparison,
    };
  } catch {
    return null;
  }
}

export async function listMolecularHarnessComparisonRecords(): Promise<
  MolecularHarnessComparisonRecord[]
> {
  const sqlite = getConnection();
  const rows = await sqlite.select<DBEntityReference[]>(
    `SELECT * FROM entity_references
     WHERE entity_type = ? AND source = ?
     ORDER BY created_at DESC, id DESC`,
    [ENTITY_TYPE, SOURCE]
  );
  return rows.flatMap((row) => {
    const record = fromRow(row);
    return record ? [record] : [];
  });
}

export async function saveMolecularHarnessComparisonRecord(
  title: string,
  comparison: MolecularHarnessComparison
): Promise<MolecularHarnessComparisonRecord> {
  const validated = parseMolecularHarnessComparison(comparison);
  if (!validated) throw new Error('Invalid molecular harness comparison.');
  const trimmedTitle = title.trim();
  if (!trimmedTitle || trimmedTitle.length > 120) throw new Error('Invalid comparison title.');
  const row = await createEntityReference({
    entityType: ENTITY_TYPE,
    displayLabel: trimmedTitle,
    locator: `dnaforge-dev://protein-visual-benchmark/${crypto.randomUUID()}`,
    deepLinkParams: null,
    data: { kind: ENTITY_TYPE, version: 1, comparison: validated },
    source: SOURCE,
    workspaceScope: null,
    workspaceRootPath: null,
  });
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_HARNESS_COMPARISON_CHANGE_EVENT));
  return { id: row.id, title: row.display_label, createdAt: row.created_at, comparison: validated };
}
