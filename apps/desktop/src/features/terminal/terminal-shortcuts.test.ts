import { describe, expect, it } from 'vitest';
import { matchesCommandBinding } from '../../commands/commandRegistry';
import { DEFAULT_COMMAND_BINDINGS } from '../../commands/defaultBindings';
import { COMMAND_IDS } from '../../commands/types';

describe('terminal shortcuts', () => {
  it('recognizes the physical backquote key when Shift produces a tilde', () => {
    const binding = DEFAULT_COMMAND_BINDINGS.find(
      (entry) => entry.command === COMMAND_IDS.terminalNew
    );
    expect(binding).toBeDefined();
    expect(
      matchesCommandBinding(
        new KeyboardEvent('keydown', {
          key: '~',
          code: 'Backquote',
          ctrlKey: true,
          shiftKey: true,
        }),
        binding!,
        'MacIntel'
      )
    ).toBe(true);
  });
});
