// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { buildSlashAskPayload, type SlashAskSelectionSnapshot } from './build-payload';

function snap(overrides: Partial<SlashAskSelectionSnapshot> = {}): SlashAskSelectionSnapshot {
  return {
    sourceRange: null,
    sourceCaret: null,
    sequenceLength: 3000,
    isCircular: false,
    ...overrides,
  };
}

describe('buildSlashAskPayload  selection semantics)', () => {
  it('RANGE → stages EXACTLY that range, not inferred', () => {
    const payload = buildSlashAskPayload(snap({ sourceRange: { start: 123, end: 456 } }));
    expect(payload).toEqual({ range: { start: 123, end: 456 }, inferredWindow: false });
  });

  it('RANGE preserves a wrapping flag verbatim', () => {
    const payload = buildSlashAskPayload(
      snap({ sourceRange: { start: 2900, end: 40, wraps: true } })
    );
    expect(payload).toEqual({
      range: { start: 2900, end: 40, wraps: true },
      inferredWindow: false,
    });
  });

  it('CARET only → stages a codon-aligned inferred window (NEVER whole-entity)', () => {
    const payload = buildSlashAskPayload(snap({ sourceCaret: 1500 }));
    expect(payload).not.toBeNull();
    expect(payload!.inferredWindow).toBe(true);
    expect((payload!.range.start - 1) % 3).toBe(0);
    expect(payload!.range.start).toBeGreaterThan(1);
    expect(payload!.range.end).toBeLessThan(3000);
  });

  it('a RANGE wins over a caret when both are somehow present', () => {
    const payload = buildSlashAskPayload(
      snap({ sourceRange: { start: 10, end: 20 }, sourceCaret: 999 })
    );
    expect(payload).toEqual({ range: { start: 10, end: 20 }, inferredWindow: false });
  });

  it('NOTHING (no range, no caret) → null (must not open, never whole-entity)', () => {
    expect(buildSlashAskPayload(snap())).toBeNull();
  });
});
