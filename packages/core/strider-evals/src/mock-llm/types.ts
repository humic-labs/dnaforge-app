export interface ScriptedToolCall {
  actionName: string;
  input: unknown;
}

export interface ScriptedTurn {
  userPrompt: string;
  toolCalls: ScriptedToolCall[];
  finalText: string;
}

export interface MockLLMScript {
  id: string;
  turns: ScriptedTurn[];
}

export interface MockLLMRunResult {
  toolCalls: ScriptedToolCall[];
  finalText: string;
}
