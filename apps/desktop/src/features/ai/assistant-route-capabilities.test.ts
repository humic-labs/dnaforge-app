import { describe, expect, it } from 'vitest';
import { hasToolCall } from 'ai';

import { ASSISTANT_ROUTE_CAPABILITIES } from './assistant-route-capabilities';

describe('assistant route capabilities', () => {
  it('enables the terminal fallback only on the verified Direct provider route', () => {
    expect(ASSISTANT_ROUTE_CAPABILITIES).toEqual({
      provider: {
        inlineReferenceDeclarations: true,
        terminalReferenceFallbackSupported: true,
      },
      hosted: {
        inlineReferenceDeclarations: true,
        terminalReferenceFallbackSupported: false,
      },
      cli: {
        inlineReferenceDeclarations: true,
        terminalReferenceFallbackSupported: false,
      },
    });
  });

  it('pins the installed AI SDK stop condition to the completed create_reference step', () => {
    const stopAfterCreateReference = hasToolCall('create_reference');
    const step = (toolName: string) =>
      ({ toolCalls: [{ toolName }] }) as Parameters<typeof stopAfterCreateReference>[0]['steps'][0];

    expect(stopAfterCreateReference({ steps: [step('read_file')] })).toBe(false);
    expect(stopAfterCreateReference({ steps: [step('read_file'), step('create_reference')] })).toBe(
      true
    );
  });
});
