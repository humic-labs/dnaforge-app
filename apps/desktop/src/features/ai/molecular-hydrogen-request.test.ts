import { describe, expect, it } from 'vitest';
import {
  explicitHydrogenAtomRequest,
  molecularHydrogenRequestForTurn,
  registerMolecularHydrogenRequest,
} from './molecular-hydrogen-request';

describe('submitted-user hydrogen display authority', () => {
  it.each([
    'Show hydrogen atoms.',
    'Please display the hydrogens.',
    'Can you show all hydrogen atoms in this view?',
  ])('recognizes the explicit request %s', (request) => {
    expect(explicitHydrogenAtomRequest(request)).toBeTruthy();
  });
  it.each([
    'Show hydrogen bonds.',
    'Do not show hydrogen atoms.',
    'Never show hydrogens unless explicitly requested.',
    'Why did it show hydrogen atoms?',
    'The agent said "show hydrogen atoms".',
    'Show the peptide and sugar contacts.',
  ])('does not authorize %s', (request) => {
    expect(explicitHydrogenAtomRequest(request)).toBeUndefined();
  });
  it('binds authority to the host turn and clears it', () => {
    const clear = registerMolecularHydrogenRequest('actual-turn', 'Show hydrogen atoms.');
    expect(molecularHydrogenRequestForTurn('actual-turn')).toBe('Show hydrogen atoms');
    expect(molecularHydrogenRequestForTurn('other-turn')).toBeUndefined();
    clear();
    expect(molecularHydrogenRequestForTurn('actual-turn')).toBeUndefined();
  });
});
