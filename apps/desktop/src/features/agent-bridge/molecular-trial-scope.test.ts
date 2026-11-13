/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../ai/public/molecular-prompt-trials', async (original) => ({
  ...(await original<typeof import('../ai/public/molecular-prompt-trials')>()),
  readMolecularPromptTrialForTurn: (id?: string) =>
    ['owned-turn', 'profiled-turn', 'document-turn'].includes(id ?? '')
      ? {
          question: 'How do these components interact?',
          fixtures:
            id === 'document-turn'
              ? [
                  {
                    structureViewId: 'molecular-draft:00000000-0000-4000-8000-000000000010',
                    documentDraftId: '00000000-0000-4000-8000-000000000010',
                    pdbId: '1ABC',
                  },
                ]
              : [{ savedViewId: 'saved-view:own', pdbId: '1ABC' }],
          ...(id === 'profiled-turn' ? { execution: { renderProfile: 'native' } } : {}),
        }
      : null,
}));

import {
  molecularTrialToolScope,
  filterMolecularTrialStructures,
  molecularTrialProteinContextBinding,
  validateMolecularTrialProteinAuthorChain,
} from './molecular-trial-scope';

describe('isolated visualization trial tools', () => {
  it('normalizes exact document targets while rejecting another document or a conflicting alias', async () => {
    const { molecularTrialArgumentTargets } = await import('../ai/public/molecular-prompt-trials');
    const reference = {
      kind: 'molecular-document',
      version: 1,
      projectId: 'owned-project',
      documentId: '00000000-0000-4000-8000-000000000010',
      revisionId: '00000000-0000-4000-8000-000000000011',
      revisionSha256: 'a'.repeat(64),
    };
    expect(molecularTrialArgumentTargets({ documentReference: reference })).toEqual([
      `molecular-draft:${reference.documentId}`,
    ]);
    expect(
      molecularTrialToolScope('mol_get_scene', { documentReference: reference }, 'document-turn')
    ).toEqual([`molecular-draft:${reference.documentId}`]);
    expect(() =>
      molecularTrialToolScope('mol_get_scene', { documentReference: reference }, 'owned-turn')
    ).toThrow('another viewer');
    expect(() =>
      molecularTrialToolScope(
        'mol_get_scene',
        {
          structureViewId: 'saved-view:own',
          documentReference: reference,
        },
        'owned-turn'
      )
    ).toThrow('another viewer');
    expect(() =>
      molecularTrialArgumentTargets({ documentReference: { ...reference, revisionSha256: 'bad' } })
    ).toThrow('invalid');
  });
  it('permits only annotations for a pinned PDB and explicit author chain', () => {
    const request = {
      source: 'protein-mcp',
      operation: 'annotations',
      pdbId: '1abc',
      chain: 'B',
      limit: 20,
    };
    expect(molecularTrialToolScope('protein_get_context', request, 'owned-turn')).toEqual([
      'saved-view:own',
    ]);
    expect(molecularTrialProteinContextBinding(request, 'owned-turn')).toEqual({
      structureViewId: 'saved-view:own',
      authorChain: 'B',
    });
    for (const input of [
      { ...request, pdbId: '2ABC' },
      { source: 'protein-mcp', operation: 'search', query: 'protein' },
      { source: 'protein-mcp', operation: 'structure', pdbId: '1ABC' },
      { source: 'uniprot-mcp', operation: 'annotations', uniprotId: 'P12345' },
      { ...request, uniprotId: 'P12345' },
      { ...request, limit: 21 },
      { ...request, chain: '' },
    ])
      expect(() => molecularTrialToolScope('protein_get_context', input, 'owned-turn')).toThrow(
        'isolated'
      );
    expect(molecularTrialToolScope('protein_get_context', request, 'ordinary-turn')).toBeNull();
  });

  it('validates the protein author namespace, not a matching label chain or RNA chain', () => {
    const binding = { structureViewId: 'saved-view:own', authorChain: 'B' };
    const chains = [
      { authAsymId: 'B', labelAsymId: 'A', polymerType: 'protein' },
      { authAsymId: 'A', labelAsymId: 'B', polymerType: 'rna' },
    ];
    expect(() => validateMolecularTrialProteinAuthorChain(binding, chains)).not.toThrow();
    expect(() =>
      validateMolecularTrialProteinAuthorChain({ ...binding, authorChain: 'A' }, chains)
    ).toThrow('protein author chain');
    expect(() =>
      validateMolecularTrialProteinAuthorChain({ ...binding, authorChain: 'Z' }, chains)
    ).toThrow('protein author chain');
  });

  it('requires a final scientific review answering the exact trial question before save dispatch', () => {
    const target = { structureViewId: 'saved-view:own' };
    expect(() => molecularTrialToolScope('mol_save_view', target, 'owned-turn')).toThrow(
      'require scientificReview'
    );
    expect(() =>
      molecularTrialToolScope(
        'mol_save_view',
        {
          ...target,
          scientificReview: { question: 'A different question.' },
        },
        'owned-turn'
      )
    ).toThrow('exact original trial question');
    expect(
      molecularTrialToolScope(
        'mol_save_view',
        {
          ...target,
          scientificReview: {
            question: 'How do these components interact?',
            questionCoverage: {
              relationship: 'The interaction between the two supplied components.',
              directEvidence: [{ stepIndex: 0, evidence: 'Their opposing interface is visible.' }],
              supportingEvidence: [],
              unanswered: [],
            },
          },
        },
        'owned-turn'
      )
    ).toEqual(['saved-view:own']);
    expect(molecularTrialToolScope('mol_save_view', target, 'ordinary-turn')).toBeNull();
  });
  it('requires direct question evidence or an explicit unanswered requirement before a trial save', () => {
    const input = {
      structureViewId: 'saved-view:own',
      scientificReview: { question: 'How do these components interact?' },
    };
    expect(() => molecularTrialToolScope('mol_save_view', input, 'owned-turn')).toThrow(
      'questionCoverage'
    );
    const questionCoverage = {
      relationship: 'The interaction between the supplied components.',
      directEvidence: [],
      supportingEvidence: [{ stepIndex: 0, evidence: 'A neighboring mechanism is visible.' }],
      unanswered: [],
    };
    expect(() =>
      molecularTrialToolScope(
        'mol_save_view',
        { ...input, scientificReview: { ...input.scientificReview, questionCoverage } },
        'owned-turn'
      )
    ).toThrow('direct question evidence or an explicit unanswered requirement');
    expect(
      molecularTrialToolScope(
        'mol_save_view',
        {
          ...input,
          scientificReview: {
            ...input.scientificReview,
            questionCoverage: {
              ...questionCoverage,
              unanswered: ["The components' opposing contact geometry is not yet readable."],
            },
          },
        },
        'owned-turn'
      )
    ).toEqual(['saved-view:own']);
  });
  it('rejects reads and writes targeting a different trial before the handler runs', () => {
    for (const name of [
      'mol_get_scene',
      'mol_apply_scene',
      'mol_align_structures',
      'mol_show_interaction_context',
      'mol_capture_screenshot',
      'mol_get_state',
    ]) {
      expect(() =>
        molecularTrialToolScope(name, { viewerId: 'saved-view:other' }, 'owned-turn')
      ).toThrow('isolated');
      expect(
        molecularTrialToolScope(name, { structureViewId: 'saved-view:own' }, 'owned-turn')
      ).toEqual(['saved-view:own']);
    }
  });
  it('keeps interaction-context changes inside the recorded trial render profile', () => {
    const input = { structureViewId: 'saved-view:own', selection: 'resn ATP' };
    expect(molecularTrialToolScope('mol_show_interaction_context', input, 'profiled-turn')).toEqual(
      ['saved-view:own']
    );
    expect(
      molecularTrialToolScope(
        'mol_show_interaction_context',
        { ...input, renderProfile: 'native' },
        'profiled-turn'
      )
    ).toEqual(['saved-view:own']);
    expect(() =>
      molecularTrialToolScope(
        'mol_show_interaction_context',
        { ...input, renderProfile: 'default' },
        'profiled-turn'
      )
    ).toThrow('render profile fixed');
  });
  it('requires an owned explicit target and prevents outside scientific context tools', () => {
    expect(
      molecularTrialToolScope(
        'mol_align_structures',
        {
          structureViewId: 'saved-view:own',
          referenceStructureRef: 'dnaforge:comparison:1',
          mobileStructureRef: 'dnaforge:comparison:2',
        },
        'owned-turn'
      )
    ).toEqual(['saved-view:own']);
    expect(() => molecularTrialToolScope('mol_get_state', {}, 'owned-turn')).toThrow('target');
    expect(() => molecularTrialToolScope('protein_get_context', {}, 'owned-turn')).toThrow(
      'isolated'
    );
  });
  it('lists only the trial viewers and leaves ordinary chats unchanged', () => {
    const result = {
      ok: true,
      structures: [{ structureViewId: 'saved-view:own' }, { structureViewId: 'saved-view:other' }],
    };
    expect(filterMolecularTrialStructures(result, ['saved-view:own'])).toEqual({
      ok: true,
      structures: [{ structureViewId: 'saved-view:own' }],
    });
    expect(molecularTrialToolScope('mol_apply_scene', {}, 'ordinary-turn')).toBeNull();
    expect(filterMolecularTrialStructures(result, null)).toBe(result);
  });
});
