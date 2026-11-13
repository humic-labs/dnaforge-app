import { describe, expect, it } from 'vitest';

import { buildStructureAskAiSelectionInput } from './structureAskAiInput';

describe('buildStructureAskAiSelectionInput', () => {
  it('preserves exact disjoint residue identities for every structure host', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:3OAA',
      data: { label: '3OAA ATP synthase' },
      structureLink: null,
      residues: [
        { chain: 'A', position: 57, labelCompId: 'GLY' },
        { chain: 'A', position: 102, labelCompId: 'GLY' },
        { chain: 'A', position: 195, labelCompId: 'TYR' },
      ],
      chains: undefined,
      view: undefined,
    });

    expect(input).toMatchObject({
      entityType: 'structure',
      locator: 'structure:3OAA',
      displayLabel: '3OAA ATP synthase residues 57, 102, 195',
      deepLinkParams: {
        highlightGroups: [
          {
            selections: [
              {
                chain: 'A',
                ranges: [
                  [57, 57],
                  [102, 102],
                  [195, 195],
                ],
              },
            ],
          },
        ],
      },
      structure: {
        residues: [
          { chain: 'A', position: 57, labelCompId: 'GLY' },
          { chain: 'A', position: 102, labelCompId: 'GLY' },
          { chain: 'A', position: 195, labelCompId: 'TYR' },
        ],
      },
    });
  });

  it('materializes sequence-originated coordinate selections from the loaded chain inventory', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:alphafold:AF:Q31NQ2:F1:V6:MODEL:AF-Q31NQ2-F1-model_v6:all',
      data: { label: 'M744_RS09700' },
      structureLink: null,
      residues: [
        { chain: 'A', position: 373, labelSeqId: 373 },
        { chain: 'A', position: 374, labelSeqId: 374 },
        { chain: 'A', position: 375, labelSeqId: 375 },
      ],
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A',
          sequence: 'STI',
          residues: [
            { position: 373, labelSeqId: 373, sequenceIndex: 372, name: 'S', name3: 'SER' },
            { position: 374, labelSeqId: 374, sequenceIndex: 373, name: 'T', name3: 'THR' },
            { position: 375, labelSeqId: 375, sequenceIndex: 374, name: 'I', name3: 'ILE' },
          ],
        },
      ],
      view: undefined,
    });

    expect(input?.structure?.residues).toEqual([
      expect.objectContaining({ chain: 'A', position: 373, labelCompId: 'SER' }),
      expect.objectContaining({ chain: 'A', position: 374, labelCompId: 'THR' }),
      expect.objectContaining({ chain: 'A', position: 375, labelCompId: 'ILE' }),
    ]);
  });

  it('refuses to create a structure Ask-AI payload while selected identities are unresolved', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:alphafold:AF:Q31NQ2:F1:V6:MODEL:AF-Q31NQ2-F1-model_v6:all',
      data: { label: 'M744_RS09700' },
      structureLink: null,
      residues: [{ chain: 'A', position: 373, labelSeqId: 373 }],
      chains: [],
      view: undefined,
    });

    expect(input).toBeNull();
  });

  it('refuses to guess when one unscoped coordinate has conflicting chain identities', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:ambiguous-assembly',
      data: { label: 'Ambiguous assembly' },
      structureLink: null,
      residues: [{ chain: 'A', position: 10 }],
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 1',
          operator: 'ASM_1',
          sequence: 'S',
          residues: [{ position: 10, name: 'S', name3: 'SER' }],
        },
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 2',
          operator: 'ASM_2',
          sequence: 'T',
          residues: [{ position: 10, name: 'T', name3: 'THR' }],
        },
      ],
      view: undefined,
    });

    expect(input).toBeNull();
  });

  it('uses assembly scope to resolve one physical chain copy without cross-copy guessing', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:scoped-assembly',
      data: { label: 'Scoped assembly' },
      structureLink: null,
      residues: [{ chain: 'A', position: 10, operator: 'ASM_2' }],
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 1',
          operator: 'ASM_1',
          sequence: 'S',
          residues: [{ position: 10, name: 'S', name3: 'SER' }],
        },
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 2',
          operator: 'ASM_2',
          sequence: 'T',
          residues: [{ position: 10, name: 'T', name3: 'THR' }],
        },
      ],
      view: undefined,
    });

    expect(input?.structure?.residues).toEqual([
      expect.objectContaining({ chain: 'A', position: 10, operator: 'ASM_2', labelCompId: 'THR' }),
    ]);
  });

  it('rejects two indistinguishable physical copies even when their chemistry agrees', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:ambiguous-identical-assembly',
      data: { label: 'Ambiguous identical assembly' },
      structureLink: null,
      residues: [{ chain: 'A', position: 10 }],
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 1',
          operator: 'ASM_1',
          sequence: 'S',
          residues: [{ position: 10, name: 'S', name3: 'SER' }],
        },
        {
          chainId: 'A',
          chainLabel: 'Chain A copy 2',
          operator: 'ASM_2',
          sequence: 'S',
          residues: [{ position: 10, name: 'S', name3: 'SER' }],
        },
      ],
      view: undefined,
    });

    expect(input).toBeNull();
  });

  it('treats UNK as unresolved and replaces it only from one exact chain residue', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:unknown-sentinel',
      data: { label: 'Unknown sentinel' },
      structureLink: null,
      residues: [{ chain: 'A', position: 10, labelCompId: 'UNK' }],
      chains: [
        {
          chainId: 'A',
          chainLabel: 'Chain A',
          sequence: 'S',
          residues: [{ position: 10, name: 'S', name3: 'SER' }],
        },
      ],
      view: undefined,
    });

    expect(input?.structure?.residues).toEqual([
      expect.objectContaining({ chain: 'A', position: 10, labelCompId: 'SER' }),
    ]);
  });

  it('refuses a selection that exceeds the exact model-context residue limit', () => {
    const input = buildStructureAskAiSelectionInput({
      structureId: 'structure:over-cap',
      data: { label: 'Over-cap selection' },
      structureLink: null,
      residues: Array.from({ length: 201 }, (_, index) => ({
        chain: 'A',
        position: index + 1,
        labelCompId: 'GLY',
      })),
      chains: undefined,
      view: undefined,
    });

    expect(input).toBeNull();
  });

  it('returns null without a visible residue selection', () => {
    expect(
      buildStructureAskAiSelectionInput({
        structureId: 'structure:empty',
        data: null,
        structureLink: null,
        residues: [],
        chains: undefined,
        view: undefined,
      })
    ).toBeNull();
  });
});
