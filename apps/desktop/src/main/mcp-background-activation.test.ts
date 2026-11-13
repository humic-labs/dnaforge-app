import { describe, expect, it } from 'vitest';
import { backgroundWindowRequested } from '../../scripts/background-window-policy.cjs';

describe('MCP background activation', () => {
  it.each(['darwin', 'win32', 'linux'] as const)(
    'starts MCP launches without activation on %s',
    (platform) => {
      expect(backgroundWindowRequested({}, platform, ['dnaforge', '--launched-by=mcp'])).toBe(true);
    }
  );

  it('keeps ordinary user launches in the foreground', () => {
    expect(backgroundWindowRequested({}, 'darwin', ['dnaforge'])).toBe(false);
  });
});
