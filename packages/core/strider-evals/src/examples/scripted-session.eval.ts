import { describe, expect, it, beforeEach } from 'vitest';
import { MockLLM } from '../mock-llm/mock-llm.ts';
import type { MockLLMScript } from '../mock-llm/types.ts';
import { runMockSession } from '../mock-llm/scripted-session.ts';
import { buildExampleEnvironment } from './test-environment.ts';
import type { EvalEnvironment } from '../runner/types.ts';

const script: MockLLMScript = {
  id: 'rename-then-amplify',
  turns: [
    {
      userPrompt: 'rename plasmid-001 to pUC19-fixed',
      toolCalls: [
        {
          actionName: 'sequence.rename',
          input: { sequenceId: 'plasmid-001', newName: 'pUC19-fixed' },
        },
      ],
      finalText: 'Renamed plasmid-001 to pUC19-fixed.',
    },
    {
      userPrompt: 'now amplify it with primers fwd and rev into pcr-product-1',
      toolCalls: [
        {
          actionName: 'sequence.pcrAmplify',
          input: {
            templateSequenceId: 'plasmid-001',
            forwardPrimerId: 'primer-fwd',
            reversePrimerId: 'primer-rev',
            productId: 'pcr-product-1',
          },
        },
      ],
      finalText: 'PCR product pcr-product-1 ready.',
    },
  ],
};

describe('[scripted-session] rename-then-amplify', () => {
  let env: EvalEnvironment;
  beforeEach(() => {
    env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
  });

  it('replays a two-turn mock-LLM transcript through the action registry', async () => {
    const session = await runMockSession({
      mock: new MockLLM(script),
      prompts: script.turns.map((t) => t.userPrompt),
      resolveAction: (name) => env.resolveAction(name),
      dispatch: {
        sessionId: 'session-mock-replay',
        store: env.store,
        audit: env.audit,
        provenance: env.provenance,
      },
    });

    expect(session.turns).toHaveLength(2);
    for (const turn of session.turns) {
      const envelope = turn.toolResults[0]?.envelope;
      expect(envelope?.ok).toBe(true);
    }

    expect(env.audit.entries()).toHaveLength(2);
    expect(env.audit.entries()[0]?.actionName).toBe('sequence.rename');
    expect(env.audit.entries()[1]?.actionName).toBe('sequence.pcrAmplify');

    const record = env.provenance.recordFor({ kind: 'sequence', id: 'pcr-product-1' });
    expect(record).toBeDefined();
    expect(record?.derivationKind).toBe('pcr');
    expect(record?.sources.map((s) => s.entity.id).sort()).toEqual(
      ['plasmid-001', 'primer-fwd', 'primer-rev'].sort()
    );
  });
});
