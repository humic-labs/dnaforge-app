import { describe, expect, it } from 'vitest';
import {
  molecularConnectionQuerySchema,
  pageMolecularConnections,
} from './molecularConnectionReadback';
import type {
  MolecularConnectionCoverage,
  MolecularConnectionEndpoint,
} from './molecularConnections';

const endpoint = (chain: string, residue: number): MolecularConnectionEndpoint => ({
  labelAsymId: chain,
  authAsymId: chain,
  authSeqId: residue,
  labelCompId: 'ASN',
  labelAtomId: 'ND2',
  element: 'N',
  instanceId: 'ASM_1',
  atomIndex: residue,
  residueIndex: residue,
  moleculeType: 1,
  polymerType: 1,
  coordinateAvailable: true,
  selector: { label_asym_id: chain, auth_seq_id: residue, label_atom_id: 'ND2' },
  residueSelector: { label_asym_id: chain, auth_seq_id: residue },
});
const connection = (index: number, attachment = false): MolecularConnectionCoverage => ({
  id: `connection-${index}`,
  structureIndex: 0,
  kind: attachment ? 'covalent' : 'hydrogen-bond',
  source: 'deposited-struct_conn',
  sourceType: attachment ? 'covale' : 'hydrog',
  bondPresent: true,
  attachment,
  a: endpoint('A', index),
  b: endpoint('B', index + 1),
  status: attachment ? 'missing-attachment-geometry' : 'not-depicted',
  representationOwners: [],
});

describe('bounded molecular connection readback', () => {
  it('keeps a large graph out of the agent reply while retaining complete counts and attachment evidence', () => {
    const inventory = Array.from({ length: 1741 }, (_, index) => connection(index));
    inventory.push(connection(1741, true));
    const page = pageMolecularConnections(inventory);
    expect(page.connections).toHaveLength(32);
    expect(page.connections[0].id).toBe('connection-1741');
    expect(page.summary).toMatchObject({
      total: 1742,
      attachmentCount: 1,
      incompleteAttachmentCount: 1,
      countsByKind: { 'hydrogen-bond': 1741, covalent: 1 },
      page: { matched: 1742, returned: 32, nextOffset: 32 },
    });
    expect(JSON.stringify(page).length).toBeLessThan(50_000);
    expect(inventory).toHaveLength(1742);
  });

  it('pages every exact record without duplicates and matches a chain/residue on the same endpoint', () => {
    const inventory = Array.from({ length: 150 }, (_, index) => connection(index, index % 3 === 0));
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageMolecularConnections(inventory, { offset, limit: 64 });
      ids.push(...page.connections.map((value) => value.id));
      offset = page.summary.page.nextOffset;
    }
    expect(new Set(ids).size).toBe(inventory.length);
    expect(ids).toHaveLength(inventory.length);
    expect(
      pageMolecularConnections(inventory, { labelAsymId: 'B', authSeqId: 2 }).connections.map(
        (value) => value.id
      )
    ).toEqual(['connection-1']);
    expect(
      pageMolecularConnections(inventory, { attachmentsOnly: true }).summary.page.matched
    ).toBe(50);
    expect(
      pageMolecularConnections(inventory, { kind: 'hydrogen-bond' }).summary.page.matched
    ).toBe(100);
  });

  it('rejects oversized pages and invalid pagination through the advertised request schema', () => {
    expect(molecularConnectionQuerySchema.safeParse({ limit: 65 }).success).toBe(false);
    expect(molecularConnectionQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(molecularConnectionQuerySchema.parse({ limit: 64, attachmentsOnly: true })).toEqual({
      limit: 64,
      attachmentsOnly: true,
    });
  });
});
