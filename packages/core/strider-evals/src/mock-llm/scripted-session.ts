import type { ActionHandle, ActionResult } from '../define-action-stub/types.ts';
import { assertScriptFullyConsumed, type MockLLM } from './mock-llm.ts';

export interface SessionToolResult {
  actionName: string;
  envelope: ActionResult<unknown>;
}

export interface SessionTurnResult {
  userPrompt: string;
  toolResults: SessionToolResult[];
  finalText: string;
}

export interface SessionRunResult {
  turns: SessionTurnResult[];
}

export interface RunMockSessionOptions {
  mock: MockLLM;
  prompts: readonly string[];
  resolveAction: (name: string) => ActionHandle<unknown, unknown> | undefined;
  dispatch: Omit<Parameters<ActionHandle<unknown, unknown>>[1], 'expectedRevisions'>;
  assertFullyConsumed?: boolean;
}

export async function runMockSession(options: RunMockSessionOptions): Promise<SessionRunResult> {
  const turns: SessionTurnResult[] = [];
  for (const prompt of options.prompts) {
    const replay = options.mock.run(prompt);
    const toolResults: SessionToolResult[] = [];
    for (const call of replay.toolCalls) {
      const handle = options.resolveAction(call.actionName);
      if (!handle) {
        toolResults.push({
          actionName: call.actionName,
          envelope: {
            ok: false,
            error: {
              code: 'EXECUTION_FAILED',
              message: `No action registered for ${call.actionName}`,
              retriable: false,
              details: { reason: 'unregistered-action' },
            },
          },
        });
        continue;
      }
      const envelope = await handle(call.input, { ...options.dispatch });
      toolResults.push({ actionName: call.actionName, envelope });
    }
    turns.push({ userPrompt: prompt, toolResults, finalText: replay.finalText });
  }
  if (options.assertFullyConsumed !== false) {
    assertScriptFullyConsumed(options.mock);
  }
  return { turns };
}
