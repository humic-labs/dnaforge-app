import type { MockLLMRunResult, MockLLMScript, ScriptedTurn } from './types.ts';

export class MockLLM {
  private turnIndex = 0;
  constructor(private readonly script: MockLLMScript) {}

  run(userPrompt: string): MockLLMRunResult {
    if (this.turnIndex >= this.script.turns.length) {
      throw new Error(
        `MockLLM(${this.script.id}): script exhausted at turn ${this.turnIndex}, ` +
          `but prompt arrived: ${truncate(userPrompt)}`
      );
    }
    const turn = this.script.turns[this.turnIndex] as ScriptedTurn;
    if (turn.userPrompt !== userPrompt) {
      throw new Error(
        `MockLLM(${this.script.id}) turn ${this.turnIndex}: expected prompt ` +
          `${JSON.stringify(turn.userPrompt)}, got ${JSON.stringify(userPrompt)}.`
      );
    }
    this.turnIndex += 1;
    return { toolCalls: turn.toolCalls, finalText: turn.finalText };
  }

  isExhausted(): boolean {
    return this.turnIndex >= this.script.turns.length;
  }

  remaining(): readonly ScriptedTurn[] {
    return this.script.turns.slice(this.turnIndex);
  }
}

export function assertScriptFullyConsumed(mock: MockLLM): void {
  const remaining = mock.remaining();
  if (remaining.length === 0) return;
  const sample = remaining.map((t, i) => `${i}: ${truncate(t.userPrompt)}`).join('; ');
  throw new Error(
    `MockLLM script not fully consumed — ${remaining.length} turn(s) left: ${sample}`
  );
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
