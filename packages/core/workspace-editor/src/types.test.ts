import { describe, it, expect } from 'vitest';
import { DEFAULT_EDITOR_CONFIG } from './types';

describe('DEFAULT_EDITOR_CONFIG', () => {
  it('sequence fontFamily is byte-pinned (regression guard for the  font-leak incident)', () => {
    expect(DEFAULT_EDITOR_CONFIG.fontFamily).toBe(
      '"JetBrains Mono", "SF Mono", "Fira Code", monospace'
    );
  });
});
