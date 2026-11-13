// @vitest-environment node

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { translateSequence } from '@waypoint/sequence-utils';
import type { ChainSequence, Structure3dAttrs } from '../types';
import { residueTargetsFromExtractedQueryChains } from './structureLinkTargets';

const chain = (overrides: Partial<ChainSequence>): ChainSequence => ({
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: 'MST',
  residues: [],
  ...overrides,
});

const THREE_TO_ONE: Record<string, string> = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLN: 'Q',
  GLU: 'E',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
};

function loadTranslationFromGenbank(relativePath: string): string {
  const text = readFileSync(
    join(__dirname, '../../../../../../../../test-fixtures', relativePath),
    'utf8'
  );
  const match = text.match(/\/translation="([\s\S]*?)"/);
  if (!match) throw new Error(`No translation found in ${relativePath}`);
  return match[1].replace(/\s+/g, '');
}

function loadForwardOriginTranslationFromGenbank(relativePath: string): string {
  const text = readFileSync(
    join(__dirname, '../../../../../../../../test-fixtures', relativePath),
    'utf8'
  );
  const origin =
    text
      .split(/ORIGIN/i)[1]
      ?.split('//')[0]
      ?.replace(/[^A-Za-z]/g, '') ?? '';
  if (!origin) throw new Error(`No ORIGIN sequence found in ${relativePath}`);
  const translated = translateSequence(origin.toUpperCase(), 1)
    .map(({ aminoAcid }) => aminoAcid)
    .join('')
    .replace(/\*+$/, '');
  if (!translated) throw new Error(`No translated ORIGIN sequence found in ${relativePath}`);
  return translated;
}

function load6OqrAtpDChain(authAsymId: 'D' | 'E' | 'F'): ChainSequence {
  const text = readFileSync(
    join(__dirname, '../../../../../../../../test-fixtures/structure-complexes/rcsb/6OQR.cif'),
    'utf8'
  );
  const residues = new Map<
    string,
    { labelAsymId: string; labelSeqId: number; authSeqId: number; compId: string }
  >();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('ATOM ')) continue;
    const columns = line.trim().split(/\s+/);
    const compId = columns[5];
    const labelAsymId = columns[6];
    const labelSeqId = Number(columns[8]);
    const authSeqId = Number(columns[16]);
    const atomAuthAsymId = columns[18];
    if (atomAuthAsymId !== authAsymId) continue;
    const key = `${labelAsymId}:${labelSeqId}:${authSeqId}:${compId}`;
    if (residues.has(key)) continue;
    residues.set(key, { labelAsymId, labelSeqId, authSeqId, compId });
  }
  const ordered = [...residues.values()].sort(
    (left, right) => left.labelSeqId - right.labelSeqId || left.authSeqId - right.authSeqId
  );
  const labelAsymId = ordered[0]?.labelAsymId;
  if (!labelAsymId) throw new Error(`No 6OQR ATPD chain ${authAsymId} residues found`);
  return {
    chainId: labelAsymId,
    chainLabel: `Chain ${authAsymId}`,
    sequence: ordered.map((residue) => THREE_TO_ONE[residue.compId] ?? 'X').join(''),
    baseChain: labelAsymId,
    labelAsymId,
    authAsymId,
    entityId: '6',
    residues: ordered.map((residue) => ({
      position: residue.authSeqId,
      labelSeqId: residue.labelSeqId,
      sequenceIndex: residue.labelSeqId - 1,
      name: THREE_TO_ONE[residue.compId] ?? 'X',
      name3: residue.compId,
    })),
  };
}

function load1Fs0AtpGChain(): ChainSequence {
  const text = readFileSync(
    join(__dirname, '../../../../../../../../test-fixtures/structure-complexes/rcsb/1FS0.cif'),
    'utf8'
  );
  const residues = new Map<
    string,
    { labelAsymId: string; labelSeqId: number; authSeqId: number; compId: string }
  >();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('ATOM ')) continue;
    const columns = line.trim().split(/\s+/);
    const compId = columns[5];
    const labelAsymId = columns[6];
    const labelSeqId = Number(columns[8]);
    const authSeqId = Number(columns[16]);
    const authAsymId = columns[18];
    if (authAsymId !== 'G') continue;
    const key = `${labelAsymId}:${labelSeqId}:${authSeqId}:${compId}`;
    if (residues.has(key)) continue;
    residues.set(key, { labelAsymId, labelSeqId, authSeqId, compId });
  }
  const ordered = [...residues.values()].sort(
    (left, right) => left.labelSeqId - right.labelSeqId || left.authSeqId - right.authSeqId
  );
  const labelAsymId = ordered[0]?.labelAsymId;
  if (!labelAsymId) throw new Error('No 1FS0 ATPG chain G residues found');
  return {
    chainId: labelAsymId,
    chainLabel: 'Chain G',
    sequence: ordered.map((residue) => THREE_TO_ONE[residue.compId] ?? 'X').join(''),
    baseChain: labelAsymId,
    labelAsymId,
    authAsymId: 'G',
    entityId: '2',
    residues: ordered.map((residue) => ({
      position: residue.authSeqId,
      labelSeqId: residue.labelSeqId,
      sequenceIndex: residue.labelSeqId - 1,
      name: THREE_TO_ONE[residue.compId] ?? 'X',
      name3: residue.compId,
    })),
  };
}

function load8Qx8Vps8ChainF(): ChainSequence {
  const text = readFileSync(
    join(__dirname, '../../../../../../../../test-fixtures/structure-complexes/rcsb/8QX8.cif'),
    'utf8'
  );
  const residues = new Map<
    string,
    {
      labelAsymId: string;
      entityId: string;
      labelSeqId: number;
      authSeqId: number;
      authAsymId: string;
      compId: string;
    }
  >();
  let atomSiteColumns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === 'loop_') {
      atomSiteColumns = [];
      continue;
    }
    if (line.startsWith('_atom_site.')) {
      atomSiteColumns.push(line.trim());
      continue;
    }
    if (!line.startsWith('ATOM ')) continue;
    const columns = line.trim().split(/\s+/);
    const columnIndex = (name: string) => {
      const index = atomSiteColumns.indexOf(`_atom_site.${name}`);
      if (index < 0) throw new Error(`Missing _atom_site.${name} in 8QX8 fixture`);
      return index;
    };
    const compId = columns[columnIndex('label_comp_id')];
    const labelAsymId = columns[columnIndex('label_asym_id')];
    const entityId = columns[columnIndex('label_entity_id')];
    const labelSeqId = Number(columns[columnIndex('label_seq_id')]);
    const authSeqId = Number(columns[columnIndex('auth_seq_id')]);
    const authAsymId = columns[columnIndex('auth_asym_id')];
    if (authAsymId !== 'F') continue;
    const key = `${labelAsymId}:${labelSeqId}:${authSeqId}:${compId}`;
    if (residues.has(key)) continue;
    residues.set(key, { labelAsymId, entityId, labelSeqId, authSeqId, authAsymId, compId });
  }
  const ordered = [...residues.values()].sort(
    (left, right) => left.labelSeqId - right.labelSeqId || left.authSeqId - right.authSeqId
  );
  const labelAsymId = ordered[0]?.labelAsymId;
  const authAsymId = ordered[0]?.authAsymId;
  const entityId = ordered[0]?.entityId;
  if (!labelAsymId || !authAsymId || !entityId) {
    throw new Error('No 8QX8 VPS8 chain F residues found');
  }
  return {
    chainId: labelAsymId,
    chainLabel: `Chain ${authAsymId}`,
    sequence: ordered.map((residue) => THREE_TO_ONE[residue.compId] ?? 'X').join(''),
    baseChain: labelAsymId,
    labelAsymId,
    authAsymId,
    entityId,
    residues: ordered.map((residue) => ({
      position: residue.authSeqId,
      labelSeqId: residue.labelSeqId,
      sequenceIndex: residue.labelSeqId - 1,
      name: THREE_TO_ONE[residue.compId] ?? 'X',
      name3: residue.compId,
    })),
  };
}

function loadAlphaFoldP0ad86Chain(): ChainSequence {
  const text = readFileSync(
    join(
      __dirname,
      '../../../../../../../../test-fixtures/structure-complexes/alphafold/AF-P0AD86-F1-model_v6.cif'
    ),
    'utf8'
  );
  const residues = new Map<
    string,
    {
      labelAsymId: string;
      entityId: string;
      labelSeqId: number;
      authSeqId: number;
      authAsymId: string;
      compId: string;
    }
  >();
  let atomSiteColumns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === 'loop_') {
      atomSiteColumns = [];
      continue;
    }
    if (line.startsWith('_atom_site.')) {
      atomSiteColumns.push(line.trim());
      continue;
    }
    if (!line.startsWith('ATOM ')) continue;
    const columns = line.trim().split(/\s+/);
    const columnIndex = (name: string) => {
      const index = atomSiteColumns.indexOf(`_atom_site.${name}`);
      if (index < 0) throw new Error(`Missing _atom_site.${name} in AlphaFold P0AD86 fixture`);
      return index;
    };
    const compId = columns[columnIndex('label_comp_id')];
    const labelAsymId = columns[columnIndex('label_asym_id')];
    const entityId = columns[columnIndex('label_entity_id')];
    const labelSeqId = Number(columns[columnIndex('label_seq_id')]);
    const authSeqId = Number(columns[columnIndex('auth_seq_id')]);
    const authAsymId = columns[columnIndex('auth_asym_id')];
    const key = `${labelAsymId}:${labelSeqId}:${authSeqId}:${compId}`;
    if (residues.has(key)) continue;
    residues.set(key, { labelAsymId, entityId, labelSeqId, authSeqId, authAsymId, compId });
  }
  const ordered = [...residues.values()].sort(
    (left, right) => left.labelSeqId - right.labelSeqId || left.authSeqId - right.authSeqId
  );
  const labelAsymId = ordered[0]?.labelAsymId;
  const authAsymId = ordered[0]?.authAsymId;
  const entityId = ordered[0]?.entityId;
  if (!labelAsymId || !authAsymId || !entityId) {
    throw new Error('No AlphaFold P0AD86 residues found');
  }
  return {
    chainId: labelAsymId,
    chainLabel: `Chain ${authAsymId}`,
    sequence: ordered.map((residue) => THREE_TO_ONE[residue.compId] ?? 'X').join(''),
    baseChain: labelAsymId,
    labelAsymId,
    authAsymId,
    entityId,
    residues: ordered.map((residue) => ({
      position: residue.authSeqId,
      labelSeqId: residue.labelSeqId,
      sequenceIndex: residue.labelSeqId - 1,
      name: THREE_TO_ONE[residue.compId] ?? 'X',
      name3: residue.compId,
    })),
  };
}

describe('residueTargetsFromExtractedQueryChains', () => {
  it('retargets an auth-chain resolver hit to the live mmCIF label-chain row', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1FS0',
      providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
      pdbId: '1FS0',
      authAsymIds: ['G'],
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:1FS0',
        sceneKind: 'single_query',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '1FS0', authAsymIds: ['G'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };

    expect(
      residueTargetsFromExtractedQueryChains(attrs, [
        chain({
          chainId: 'A',
          chainLabel: 'Chain E',
          labelAsymId: 'A',
          authAsymId: 'E',
          entityId: '1',
        }),
        chain({
          chainId: 'B',
          chainLabel: 'Chain G',
          labelAsymId: 'B',
          authAsymId: 'G',
          entityId: '2',
          operator: 'ASM_1',
        }),
      ])
    ).toEqual([
      {
        chain: 'B',
        baseChain: 'B',
        labelAsymId: 'B',
        authAsymId: 'G',
        entityId: '2',
        operator: 'ASM_1',
      },
    ]);
  });

  it('keeps every loaded chain matching a multimer query selection', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '3OAA',
      providerIdentityKey: 'RCSB:3OAA:ENTRY:AUTH_ASYM:G',
      pdbId: '3OAA',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:3OAA',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:3OAA:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '3OAA', authAsymIds: ['G', 'O', 'W', 'e'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };

    expect(
      residueTargetsFromExtractedQueryChains(attrs, [
        chain({ chainId: 'G', chainLabel: 'Chain G', authAsymId: 'G', labelAsymId: 'G' }),
        chain({ chainId: 'O', chainLabel: 'Chain O', authAsymId: 'O', labelAsymId: 'O' }),
        chain({ chainId: 'W', chainLabel: 'Chain W', authAsymId: 'W', labelAsymId: 'W' }),
        chain({ chainId: 'e', chainLabel: 'Chain e', authAsymId: 'e', labelAsymId: 'e' }),
        chain({ chainId: 'A', chainLabel: 'Chain A', authAsymId: 'A', labelAsymId: 'A' }),
      ])
    ).toEqual([
      { chain: 'G', baseChain: 'G', labelAsymId: 'G', authAsymId: 'G' },
      { chain: 'O', baseChain: 'O', labelAsymId: 'O', authAsymId: 'O' },
      { chain: 'W', baseChain: 'W', labelAsymId: 'W', authAsymId: 'W' },
      { chain: 'e', baseChain: 'e', labelAsymId: 'e', authAsymId: 'e' },
    ]);
  });

  it('does not treat label/effective chain ids as auth-chain matches when auth_asym_id exists', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '6OQR',
      providerIdentityKey: 'RCSB:6OQR:ENTRY:AUTH_ASYM:I,J',
      pdbId: '6OQR',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:6OQR',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6OQR:ENTRY',
        queryAnchor: {
          memberId: 'member:atpE',
          targetSelection: { pdbId: '6OQR', authAsymIds: ['I', 'J'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };

    expect(
      residueTargetsFromExtractedQueryChains(attrs, [
        chain({
          chainId: 'I',
          chainLabel: 'Chain I',
          labelAsymId: 'I',
          authAsymId: 'E',
          entityId: '6',
        }),
        chain({
          chainId: 'U',
          chainLabel: 'Chain I',
          labelAsymId: 'U',
          authAsymId: 'I',
          entityId: '7',
        }),
        chain({
          chainId: 'K',
          chainLabel: 'Chain J',
          labelAsymId: 'K',
          authAsymId: 'J',
          entityId: '7',
        }),
      ])
    ).toEqual([
      { chain: 'U', baseChain: 'U', labelAsymId: 'U', authAsymId: 'I', entityId: '7' },
      { chain: 'K', baseChain: 'K', labelAsymId: 'K', authAsymId: 'J', entityId: '7' },
    ]);
  });

  it('does not broaden a complex query to all chains when no query chain matches', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '3OAA',
      providerIdentityKey: 'RCSB:3OAA:ENTRY:AUTH_ASYM:G',
      pdbId: '3OAA',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:3OAA',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:3OAA:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '3OAA', authAsymIds: ['missing'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };

    expect(
      residueTargetsFromExtractedQueryChains(attrs, [
        chain({ chainId: 'G', chainLabel: 'Chain G', authAsymId: 'G', labelAsymId: 'G' }),
      ])
    ).toEqual([]);
  });

  it('keeps an AlphaFold single-query chain when the resolver selection has provider identity but no PDB chain scope', () => {
    const attrs: Structure3dAttrs = {
      source: 'alphafold',
      sourceId: 'AF:P0AD86:F1:LATEST',
      providerIdentityKey: 'AF:P0AD86:F1:LATEST',
      uniprotId: 'P0AD86',
      accession: 'P0AD86',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:AF:P0AD86:F1:LATEST',
        sceneKind: 'single_query',
        primaryResourceId: 'AF:P0AD86:F1:LATEST',
        queryAnchor: {
          memberId: 'member:thrL',
          targetSelection: {
            providerIdentityKey: 'AF:P0AD86:F1:LATEST',
            accession: 'P0AD86',
          },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'alphafold' },
      },
    };

    const targets = residueTargetsFromExtractedQueryChains(
      attrs,
      [loadAlphaFoldP0ad86Chain()],
      'MKRISTTITTTITITTGNGAG'
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
    });
    expect(targets[0].residues).toHaveLength(21);
    expect(targets[0].residues?.slice(0, 3)).toEqual([
      { residueIndex: 0, position: 1, labelSeqId: 1 },
      { residueIndex: 1, position: 2, labelSeqId: 2 },
      { residueIndex: 2, position: 3, labelSeqId: 3 },
    ]);
    expect(targets[0].residues?.at(-1)).toEqual({
      residueIndex: 20,
      position: 21,
      labelSeqId: 21,
    });
  });

  it('keeps an unscoped non-PDB single-query chain instead of treating an empty target selection as no match', () => {
    const attrs: Structure3dAttrs = {
      source: 'url',
      sourceId: 'https://example.test/model.cif',
      url: 'https://example.test/model.cif',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:url:model',
        sceneKind: 'single_query',
        primaryResourceId: 'https://example.test/model.cif',
        queryAnchor: {
          memberId: 'member:url-query',
          targetSelection: {},
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer', provider: 'url' },
      },
    };

    const targets = residueTargetsFromExtractedQueryChains(
      attrs,
      [loadAlphaFoldP0ad86Chain()],
      'MKRISTTITTTITITTGNGAG'
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
    });
    expect(targets[0].residues?.slice(0, 3)).toEqual([
      { residueIndex: 0, position: 1, labelSeqId: 1 },
      { residueIndex: 1, position: 2, labelSeqId: 2 },
      { residueIndex: 2, position: 3, labelSeqId: 3 },
    ]);
    expect(targets[0].residues?.at(-1)).toEqual({
      residueIndex: 20,
      position: 21,
      labelSeqId: 21,
    });
  });

  it('fails closed when an explicit single-query anchor matches no loaded chain', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '6OQR',
      providerIdentityKey: 'RCSB:6OQR:ENTRY:AUTH_ASYM:Z',
      pdbId: '6OQR',
      authAsymIds: ['D', 'E', 'F'],
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:6OQR',
        sceneKind: 'single_query',
        primaryResourceId: 'RCSB:6OQR:ENTRY',
        queryAnchor: {
          memberId: 'member:atpD',
          targetSelection: { pdbId: '6OQR', authAsymIds: ['Z'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };

    expect(
      residueTargetsFromExtractedQueryChains(attrs, [
        chain({ chainId: 'D', chainLabel: 'Chain D', authAsymId: 'D', labelAsymId: 'H' }),
        chain({ chainId: 'E', chainLabel: 'Chain E', authAsymId: 'E', labelAsymId: 'I' }),
        chain({ chainId: 'F', chainLabel: 'Chain F', authAsymId: 'F', labelAsymId: 'J' }),
      ])
    ).toEqual([]);
  });

  it('stores protein-order to structure-position residue maps on link targets', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['A'],
    };

    expect(
      residueTargetsFromExtractedQueryChains(
        attrs,
        [
          chain({
            chainId: 'A',
            authAsymId: 'A',
            labelAsymId: 'A',
            sequence: 'MST',
            residues: [
              { sequenceIndex: 0, position: 101, name: 'M', name3: 'MET' },
              { sequenceIndex: 1, position: 102, name: 'S', name3: 'SER' },
              { sequenceIndex: 2, position: 103, name: 'T', name3: 'THR' },
            ],
          }),
        ],
        'AAAMST'
      )
    ).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [
          { residueIndex: 3, position: 101 },
          { residueIndex: 4, position: 102 },
          { residueIndex: 5, position: 103 },
        ],
      },
    ]);
  });

  it('does not double-count shifted label_seq_id when observed residues start after an unmodeled N-terminus', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['A'],
    };

    expect(
      residueTargetsFromExtractedQueryChains(
        attrs,
        [
          chain({
            chainId: 'A',
            authAsymId: 'A',
            labelAsymId: 'A',
            sequence: 'MST',
            residues: [
              { sequenceIndex: 3, position: 101, name: 'M', name3: 'MET' },
              { sequenceIndex: 4, position: 102, name: 'S', name3: 'SER' },
              { sequenceIndex: 5, position: 103, name: 'T', name3: 'THR' },
            ],
          }),
        ],
        'AAAMST'
      )
    ).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [
          { residueIndex: 3, position: 101 },
          { residueIndex: 4, position: 102 },
          { residueIndex: 5, position: 103 },
        ],
      },
    ]);
  });

  it('fails closed instead of falling back to chain-local numbering when source and structure sequences do not align', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['A'],
    };

    expect(
      residueTargetsFromExtractedQueryChains(
        attrs,
        [
          chain({
            chainId: 'A',
            authAsymId: 'A',
            labelAsymId: 'A',
            sequence: 'QQQ',
            residues: [
              { sequenceIndex: 0, position: 101, name: 'Q', name3: 'GLN' },
              { sequenceIndex: 1, position: 102, name: 'Q', name3: 'GLN' },
              { sequenceIndex: 2, position: 103, name: 'Q', name3: 'GLN' },
            ],
          }),
        ],
        'MST'
      )
    ).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [],
      },
    ]);
  });

  it('fails closed when repeated residues create multiple equally valid source alignments', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['A'],
    };

    expect(
      residueTargetsFromExtractedQueryChains(
        attrs,
        [
          chain({
            chainId: 'A',
            authAsymId: 'A',
            labelAsymId: 'A',
            sequence: 'MAK',
            residues: [
              { sequenceIndex: 0, position: 101, name: 'M', name3: 'MET' },
              { sequenceIndex: 1, position: 102, name: 'A', name3: 'ALA' },
              { sequenceIndex: 2, position: 103, name: 'K', name3: 'LYS' },
            ],
          }),
        ],
        'MAAAK'
      )
    ).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [],
      },
    ]);
  });

  it('maps observed chains through internal unresolved structure gaps instead of using a scalar offset', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['A'],
    };

    expect(
      residueTargetsFromExtractedQueryChains(
        attrs,
        [
          chain({
            chainId: 'A',
            authAsymId: 'A',
            labelAsymId: 'A',
            sequence: 'MSLV',
            residues: [
              { sequenceIndex: 0, position: 101, name: 'M', name3: 'MET' },
              { sequenceIndex: 1, position: 102, name: 'S', name3: 'SER' },
              { sequenceIndex: 5, position: 106, name: 'L', name3: 'LEU' },
              { sequenceIndex: 6, position: 107, name: 'V', name3: 'VAL' },
            ],
          }),
        ],
        'MSTKQLV'
      )
    ).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'A',
        residues: [
          { residueIndex: 0, position: 101 },
          { residueIndex: 1, position: 102 },
          { residueIndex: 5, position: 106 },
          { residueIndex: 6, position: 107 },
        ],
      },
    ]);
  });

  it('maps real 6OQR ATPD chain F after its two unresolved N-terminal residues despite a sequence mismatch', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '6OQR',
      providerIdentityKey: 'RCSB:6OQR:ENTRY:AUTH_ASYM:D,E,F',
      pdbId: '6OQR',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:6OQR-atpD',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:6OQR:ENTRY',
        queryAnchor: {
          memberId: 'member:atpD',
          targetSelection: { pdbId: '6OQR', authAsymIds: ['D', 'E', 'F'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };
    const translation = loadTranslationFromGenbank('sequences/linear/mg1655-atpD-reference.gb');

    const targets = residueTargetsFromExtractedQueryChains(
      attrs,
      ['D', 'E', 'F'].map((authAsymId) => load6OqrAtpDChain(authAsymId as 'D' | 'E' | 'F')),
      translation
    );

    const targetByAuth = new Map(targets.map((target) => [target.authAsymId, target]));
    expect(targetByAuth.get('D')?.residues?.slice(0, 3)).toEqual([
      { residueIndex: 0, position: 0, labelSeqId: 12 },
      { residueIndex: 1, position: 1, labelSeqId: 13 },
      { residueIndex: 2, position: 2, labelSeqId: 14 },
    ]);
    expect(targetByAuth.get('E')?.residues?.slice(0, 3)).toEqual([
      { residueIndex: 0, position: 0, labelSeqId: 12 },
      { residueIndex: 1, position: 1, labelSeqId: 13 },
      { residueIndex: 2, position: 2, labelSeqId: 14 },
    ]);
    expect(targetByAuth.get('F')?.residues?.slice(0, 3)).toEqual([
      { residueIndex: 2, position: 2, labelSeqId: 14 },
      { residueIndex: 3, position: 3, labelSeqId: 15 },
      { residueIndex: 4, position: 4, labelSeqId: 16 },
    ]);
    expect(targetByAuth.get('F')?.residues?.some((entry) => entry.residueIndex === 0)).toBe(false);
    expect(targetByAuth.get('F')?.residues?.some((entry) => entry.residueIndex === 1)).toBe(false);
  });

  it('maps real 1FS0 ATPG chain G through the PDB/UniProt 19-248 partial overlap', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1FS0',
      providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
      pdbId: '1FS0',
      authAsymIds: ['G'],
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:1FS0-atpG',
        sceneKind: 'single_query',
        primaryResourceId: 'RCSB:1FS0:ENTRY',
        queryAnchor: {
          memberId: 'member:atpG',
          targetSelection: { pdbId: '1FS0', authAsymIds: ['G'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };
    const translation = loadTranslationFromGenbank('sequences/linear/mg1655-atpG-reference.gb');

    const [target] = residueTargetsFromExtractedQueryChains(
      attrs,
      [load1Fs0AtpGChain()],
      translation
    );

    expect(target).toMatchObject({
      chain: 'B',
      baseChain: 'B',
      labelAsymId: 'B',
      authAsymId: 'G',
      entityId: '2',
    });
    expect(target.residues?.slice(0, 3)).toEqual([
      { residueIndex: 18, position: 19, labelSeqId: 1 },
      { residueIndex: 19, position: 20, labelSeqId: 2 },
      { residueIndex: 20, position: 21, labelSeqId: 3 },
    ]);
    expect(target.residues?.find((entry) => entry.residueIndex === 30)).toEqual({
      residueIndex: 30,
      position: 31,
      labelSeqId: 13,
    });
    expect(target.residues?.at(-1)).toEqual({
      residueIndex: 247,
      position: 248,
      labelSeqId: 230,
    });
  });

  it('maps real 8QX8 VPS8 chain F through auth residue numbering despite partial cryo-EM gaps', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '8QX8',
      providerIdentityKey: 'RCSB:8QX8:ENTRY:AUTH_ASYM:F',
      pdbId: '8QX8',
      scene: {
        schemaVersion: 1,
        sceneId: 'scene:8QX8-vps8',
        sceneKind: 'complex',
        primaryResourceId: 'RCSB:8QX8:ENTRY',
        queryAnchor: {
          memberId: 'member:VPS8',
          targetSelection: { pdbId: '8QX8', authAsymIds: ['F'] },
        },
        members: [],
        layers: [],
        provenance: { createdBy: 'structure-drawer' },
      },
    };
    const translation = loadForwardOriginTranslationFromGenbank(
      'sequences/linear/structure-s288c-vps8-ape-label.gb'
    );

    const [target] = residueTargetsFromExtractedQueryChains(
      attrs,
      [load8Qx8Vps8ChainF()],
      translation
    );

    expect(target).toMatchObject({
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'F',
      entityId: '1',
    });
    expect(target.residues?.slice(0, 8)).toEqual([
      { residueIndex: 66, position: 67, labelSeqId: 67 },
      { residueIndex: 67, position: 68, labelSeqId: 68 },
      { residueIndex: 68, position: 69, labelSeqId: 69 },
      { residueIndex: 69, position: 70, labelSeqId: 70 },
      { residueIndex: 70, position: 71, labelSeqId: 71 },
      { residueIndex: 71, position: 72, labelSeqId: 72 },
      { residueIndex: 72, position: 73, labelSeqId: 73 },
      { residueIndex: 73, position: 74, labelSeqId: 74 },
    ]);
    expect(target.residues?.find((entry) => entry.position === 87)).toEqual({
      residueIndex: 86,
      position: 87,
      labelSeqId: 87,
    });
    expect(target.residues?.at(-1)).toEqual({
      residueIndex: 1263,
      position: 1264,
      labelSeqId: 1264,
    });
  });
});
