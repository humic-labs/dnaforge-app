import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  V12_MOLECULAR_PROMPT_PARAGRAPH,
  V13_MOLECULAR_PROMPT_PARAGRAPH,
  V14_MOLECULAR_PROMPT_PARAGRAPH,
  v14MolecularPromptInstructions,
} from './molecular-iteration-prompts';

describe('molecular prompt revisions', () => {
  it('preserves the exact historical V12 control', () => {
    expect(createHash('sha256').update(V12_MOLECULAR_PROMPT_PARAGRAPH).digest('hex')).toBe(
      'c2ea4a227adfde915ce78eba3b83697724d23efa04efd53a41a4cc325e38a9b9'
    );
  });

  it('grounds V13 in the interaction tool without adding a structure-specific render recipe', () => {
    expect(V13_MOLECULAR_PROMPT_PARAGRAPH).toContain('mol_show_interaction_context');
    expect(V13_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(/[\r\n]/);
    expect(V13_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(/\b[1-9][A-Z0-9]{3}\b/);
    expect(V13_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(
      /\b(?:sizeFactor|atomScale|baseOpacity|connectorRadius|molstar_representation_params)\b/
    );
  });

  it('changes only the versioned guidance, preserving the common scientific brief', () => {
    const brief = 'Unchanged common scientific brief.\n\n';
    expect(v14MolecularPromptInstructions(brief + V13_MOLECULAR_PROMPT_PARAGRAPH)).toBe(
      brief + V14_MOLECULAR_PROMPT_PARAGRAPH
    );
    expect(() => v14MolecularPromptInstructions(brief + 'A changed historical control.')).toThrow();
    expect(V14_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(/\b[1-9][A-Z0-9]{3}\b/);
    expect(V14_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(
      /\b(?:KcsA|Cas9|GroEL|PGT128|ribosome|streptavidin)\b/i
    );
    expect(V14_MOLECULAR_PROMPT_PARAGRAPH).not.toMatch(
      /\b(?:sizeFactor|atomScale|baseOpacity|connectorRadius|molstar_representation_params)\b/
    );
  });
});
