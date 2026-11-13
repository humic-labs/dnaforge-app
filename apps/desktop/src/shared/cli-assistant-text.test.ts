import { describe, expect, it } from 'vitest';
import {
  createCliAssistantTextAccumulator,
  cliAssistantText,
  isCliTerminalFailureDiagnostic,
} from './cli-assistant-text';
const event = (kind: string, text: string, providerItemId = 'item-1') => ({
  transport: 'codex-sdk',
  providerItemId,
  sequence: 1,
  display: { kind, text },
  raw: {},
});
describe('shared CLI text and failure projection', () => {
  it('uses assistant text only and replaces the same provider item rather than retaining stale text', () => {
    const partial = createCliAssistantTextAccumulator();
    partial.append(event('reasoning', 'private thought'));
    partial.append(event('tool', 'private tool output'));
    partial.append(event('assistant_text', 'old partial'));
    partial.append(event('assistant_text', '*[Paused]*'));
    expect(partial.text()).toBe('*[Paused]*');
    partial.append(event('assistant_text', 'new partial', 'item-2'));
    expect(partial.text()).toBe('*[Paused]*\nnew partial');
    expect(
      cliAssistantText({
        ...event('assistant_text', 'display'),
        raw: { item: { text: 'raw same as renderer' } },
      })
    ).toBe('raw same as renderer');
  });
  it('suppresses only redundant terminal error diagnostics, keeping failed tools and nonterminal errors', () => {
    expect(
      isCliTerminalFailureDiagnostic({ ...event('error', 'provider detail'), terminal: 'failed' })
    ).toBe(true);
    expect(isCliTerminalFailureDiagnostic(event('error', 'recoverable error'))).toBe(false);
    expect(
      isCliTerminalFailureDiagnostic({
        ...event('error', 'tool detail'),
        terminal: 'failed',
        toolCalls: [{ id: 'tool-1' }],
      })
    ).toBe(false);
  });
});
