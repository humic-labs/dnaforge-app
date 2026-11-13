import { describe, expect, it } from 'vitest';
import { createProteinGetContextTool, proteinContextSchema } from './protein-context';

describe('protein context source contract', () => {
  it('rejects a PDB-based UniProt annotation lookup before contacting the provider', () => {
    expect(proteinContextSchema.safeParse({
      source: 'uniprot-mcp', operation: 'annotations', pdbId: '1LZ8', chain: 'A',
    }).success).toBe(false);
  });

  it('accepts the accession-based UniProt lookup used in the actual app', () => {
    expect(proteinContextSchema.safeParse({
      source: 'uniprot-mcp', operation: 'annotations', uniprotId: 'P00698',
    }).success).toBe(true);
  });

  it('returns an actionable input failure on the shared tool without reaching the sidecar', async () => {
    const tool = createProteinGetContextTool();
    await expect(tool.execute!({
      source: 'uniprot-mcp', operation: 'annotations', pdbId: '1LZ8', chain: 'A',
    }, { toolCallId: 'invalid-uniprot-pdb', messages: [] })).resolves.toMatchObject({
      ok: false, code: 'BAD_INPUT', retriable: false, stateChanged: false,
    });
  });

  it('rejects incomplete contacts and selectors the remote tool would ignore', () => {
    expect(proteinContextSchema.safeParse({ source: 'protein-mcp', operation: 'binding_site', pdbId: '1IEP' }).success).toBe(false);
    expect(proteinContextSchema.safeParse({ source: 'protein-mcp', operation: 'binding_site', pdbId: '1IEP', ligandId: 'STI', chain: 'A' }).success).toBe(false);
  });
});
