import { expect, it } from 'vitest';
import {
  AGENT_EXECUTION_INSTRUCTIONS,
  buildAgentExecutionInstructions,
} from './agent-execution-instructions';

it('preserves user constraints alongside the shared execution contract', () => {
  const instructions = buildAgentExecutionInstructions(
    'Draft only; keep all sequence tabs closed.'
  );
  expect(instructions).toContain(AGENT_EXECUTION_INSTRUCTIONS);
  expect(instructions).toContain('Draft only; keep all sequence tabs closed.');
  expect(instructions).toContain('Never blindly repeat a mutation whose outcome is unknown');
  expect(instructions).toContain('does not leave work running in the background');
});
