import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { encodedMoleculeIdentityPayload } from '../../shared/encoded-molecule';
import {
  molecularDataDigest,
  molecularDatasetSchema,
  molecularDataMappingSchema,
  stableMolecularDataJson,
  validateMolecularDataMapping,
} from '../../shared/molecular-data';
import {
  molecularDataLoadSchema,
  molecularDataRetainSchema,
  type MolecularDataAPI,
  type MolecularDataLoaded,
  type MolecularDataLoadInput,
  type MolecularDataRetained,
  type MolecularDataRetainInput,
} from '../../shared/molecular-data-ipc';

export class MolecularDataService implements MolecularDataAPI {
  constructor(private readonly db: () => Database.Database) {}

  async retain(raw: MolecularDataRetainInput): Promise<MolecularDataRetained> {
    const input = molecularDataRetainSchema.parse(raw);
    await validateRevisions(input);
    const references = {
      datasetReferenceId: referenceId('dataset', input.workspaceScope, input.dataset.revision),
      mappingReferenceId: referenceId('mapping', input.workspaceScope, input.mapping.revision),
    };
    this.db().transaction(() => {
      this.put(
        references.datasetReferenceId,
        input.workspaceScope,
        'molecular-dataset',
        input.dataset,
        input.dataset.name
      );
      this.put(
        references.mappingReferenceId,
        input.workspaceScope,
        'molecular-mapping',
        input.mapping,
        'Molecular correspondence'
      );
    })();
    return references;
  }

  async load(raw: MolecularDataLoadInput): Promise<MolecularDataLoaded> {
    const input = molecularDataLoadSchema.parse(raw);
    const dataset = molecularDatasetSchema.parse(
      this.read(input.datasetReferenceId, input.workspaceScope, 'molecular-dataset')
    );
    const mapping = molecularDataMappingSchema.parse(
      this.read(input.mappingReferenceId, input.workspaceScope, 'molecular-mapping')
    );
    await validateRevisions({ dataset, mapping });
    if (
      input.datasetReferenceId !== referenceId('dataset', input.workspaceScope, dataset.revision) ||
      input.mappingReferenceId !== referenceId('mapping', input.workspaceScope, mapping.revision)
    )
      throw new Error('Retained molecular data does not match its reference identity.');
    return { dataset, mapping };
  }

  private read(id: string, workspaceScope: string, kind: string): unknown {
    const row = this.db()
      .prepare(
        `SELECT data FROM entity_references
      WHERE id = ? AND workspace_scope = ? AND entity_type = 'analysis' AND locator = ?`
      )
      .get(id, workspaceScope, kind) as { data: string } | undefined;
    if (!row) throw new Error('The retained molecular analysis is unavailable in this workspace.');
    const snapshot = JSON.parse(row.data);
    if (snapshot.kind !== kind || snapshot.version !== 1)
      throw new Error('Unsupported retained molecular analysis.');
    return snapshot.contents;
  }

  private put(id: string, workspaceScope: string, kind: string, contents: unknown, label: string) {
    const snapshot = stableMolecularDataJson({ kind, version: 1, contents });
    const existing = this.db()
      .prepare(
        'SELECT data, workspace_scope, locator, entity_type FROM entity_references WHERE id = ?'
      )
      .get(id) as
      | { data: string; workspace_scope: string; locator: string; entity_type: string }
      | undefined;
    if (existing) {
      if (
        existing.data !== snapshot ||
        existing.workspace_scope !== workspaceScope ||
        existing.locator !== kind ||
        existing.entity_type !== 'analysis'
      )
        throw new Error('An immutable molecular analysis reference changed.');
      return;
    }
    const now = Date.now();
    this.db()
      .prepare(
        `INSERT INTO entity_references
      (id, entity_type, display_label, locator, data, source, status, workspace_scope, created_at, updated_at)
      VALUES (?, 'analysis', ?, ?, ?, 'user', 'created', ?, ?, ?)`
      )
      .run(id, label, kind, snapshot, workspaceScope, now, now);
  }
}

function referenceId(kind: 'dataset' | 'mapping', scope: string, revision: string): string {
  return `molecular-${kind}:${createHash('sha256')
    .update(JSON.stringify(['molecular-data-v1', scope, revision]))
    .digest('hex')}`;
}

async function validateRevisions({ dataset, mapping }: MolecularDataLoaded): Promise<void> {
  const correspondence = dataset.source.correspondence;
  if (correspondence) {
    const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    if (
      hash(correspondence.context.json) !== correspondence.context.sha256 ||
      hash(encodedMoleculeIdentityPayload(correspondence.molecule)) !==
        correspondence.molecule.identitySha256
    )
      throw new Error('The retained molecular correspondence does not match its input digests.');
    const context = JSON.parse(correspondence.context.json);
    if (
      context.annotation?.type !== 'CDS' ||
      context.proteinIdentity?.feature?.entityId !== correspondence.reference.documentId ||
      context.proteinIdentity?.sequence?.canonicalLookupSequence !==
        correspondence.molecule.sequence ||
      context.proteinIdentity?.sequence?.digests?.sha256 !==
        hash(correspondence.molecule.sequence) ||
      correspondence.featureKey !==
        `req:${context.proteinIdentity?.feature?.featureKey}:${context.proteinIdentity?.sequence?.identityKey}`
    )
      throw new Error('The retained annotation and encoded molecule have different identities.');
  }
  if (
    dataset.source.program &&
    createHash('sha256').update(dataset.source.program.text, 'utf8').digest('hex') !==
      dataset.source.program.sha256
  )
    throw new Error('The retained analysis program does not match its digest.');
  const { revision: dataRevision, ...dataContents } = dataset;
  const { revision: mappingRevision, ...mappingContents } = mapping;
  if (
    (await molecularDataDigest(dataContents)) !== dataRevision ||
    (await molecularDataDigest(mappingContents)) !== mappingRevision
  )
    throw new Error('Molecular data or mapping bytes do not match their pinned revision.');
  validateMolecularDataMapping(dataset, mapping);
  if (JSON.stringify({ dataset, mapping }).length > 2_000_000)
    throw new Error('The retained molecular analysis exceeds the 2 MB limit.');
}
