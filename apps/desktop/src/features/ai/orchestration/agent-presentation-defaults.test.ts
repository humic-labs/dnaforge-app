import { expect, it } from 'vitest';
import { buildAgentExecutionInstructions } from './agent-execution-instructions';

it('supplies named overview and detail authoring to an ordinary scientific question', () => {
  const instructions = buildAgentExecutionInstructions();
  expect(instructions).toContain('named overview');
  expect(instructions).toContain('detail');
  expect(instructions).toContain('viewAction:"add"');
  expect(instructions).toContain('same molecular document');
});

it('uses editable presentation instructions and retained preferences in later turns', () => {
  const instructions = buildAgentExecutionInstructions('Use short paragraphs.', {
    molecularAgentInstructions: 'Prefer one overview unless I ask for detail.',
    rememberedAgentPreferences: 'Use purple for RNA in future presentations.',
  });
  expect(instructions).toContain('Prefer one overview unless I ask for detail.');
  expect(instructions).toContain('Use purple for RNA in future presentations.');
  expect(instructions).not.toContain('viewAction:"add"');
  expect(instructions).toContain('Use short paragraphs.');
  expect(instructions).toContain('explicit stable preferences');
  expect(instructions).toContain('expectedRevision');
});

it('allows an intentionally empty presentation instruction without restoring defaults', () => {
  expect(
    buildAgentExecutionInstructions(undefined, { molecularAgentInstructions: '' })
  ).not.toContain('viewAction:"add"');
});
