/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  readCustomMolecularPromptVariants,
  saveCustomMolecularPromptVariant,
} from './molecular-prompt-variants';

describe('immutable protein prompt variants', () => {
  beforeEach(() => localStorage.clear());

  it('retains the original variant when a revised hypothesis is saved', () => {
    const first = saveCustomMolecularPromptVariant({
      id: '',
      label: 'Candidate A',
      instructions: 'Emphasize the question relationship.',
    });
    expect(() =>
      saveCustomMolecularPromptVariant({
        id: first.id,
        label: 'Candidate A revised',
        instructions: 'Show every ligand as a surface.',
      })
    ).toThrow(/immutable/i);
    const second = saveCustomMolecularPromptVariant({
      id: '',
      label: 'Candidate A revised',
      instructions: 'Show every ligand as a surface.',
    });
    expect(second.id).not.toBe(first.id);
    expect(readCustomMolecularPromptVariants()).toEqual([first, second]);
  });

  it('treats an identical save as idempotent and rejects an unknown custom id', () => {
    const first = saveCustomMolecularPromptVariant({
      id: '',
      label: 'Candidate A',
      instructions: 'Emphasize the question relationship.',
    });
    expect(saveCustomMolecularPromptVariant(first)).toEqual(first);
    expect(() =>
      saveCustomMolecularPromptVariant({
        id: 'custom:unrecorded',
        label: first.label,
        instructions: first.instructions,
      })
    ).toThrow(/unknown/i);
    expect(readCustomMolecularPromptVariants()).toEqual([first]);
  });
});
