// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  getInitialPolymerRepresentationPlanForRole,
  polymerRepresentationSlotForCell,
  polymerRepresentationTag,
} from './renderPlan';

function representationCell(ref: string, tags?: string[]) {
  return {
    cell: {
      transform: {
        ref,
        tags,
      },
    },
  };
}

describe('MolStar render plan', () => {
  it('assigns stable DNAForge tags to initial query polymer representation slots', () => {
    const plan = getInitialPolymerRepresentationPlanForRole('query');

    expect(plan.map((entry) => ({ role: entry.role, slot: entry.slot, tag: entry.tag }))).toEqual([
      {
        role: 'query',
        slot: 'primary',
        tag: polymerRepresentationTag('query', 'primary'),
      },
      {
        role: 'query',
        slot: 'detail',
        tag: polymerRepresentationTag('query', 'detail'),
      },
    ]);
    expect(plan[0].props).toMatchObject({
      type: 'cartoon',
      color: 'chain-id',
    });
    expect(plan[1].props).toMatchObject({
      type: 'ball-and-stick',
      color: 'element-symbol',
      typeParams: expect.objectContaining({ alpha: 0 }),
    });
  });

  it('assigns focus polymer representation slots like query polymers', () => {
    const plan = getInitialPolymerRepresentationPlanForRole('focus');

    expect(plan.map((entry) => ({ role: entry.role, slot: entry.slot, tag: entry.tag }))).toEqual([
      {
        role: 'focus',
        slot: 'primary',
        tag: polymerRepresentationTag('focus', 'primary'),
      },
      {
        role: 'focus',
        slot: 'detail',
        tag: polymerRepresentationTag('focus', 'detail'),
      },
    ]);
    expect(plan[0].props).toMatchObject({
      type: 'cartoon',
      color: 'chain-id',
    });
    expect(plan[1].props).toMatchObject({
      type: 'ball-and-stick',
      color: 'element-symbol',
      typeParams: expect.objectContaining({ alpha: 0 }),
    });
  });

  it('uses representation tags before array order when resolving slots', () => {
    expect(
      polymerRepresentationSlotForCell(
        'query',
        representationCell('late-primary', [polymerRepresentationTag('query', 'primary')]),
        1
      )
    ).toBe('primary');
    expect(
      polymerRepresentationSlotForCell(
        'query',
        representationCell('early-detail', [polymerRepresentationTag('query', 'detail')]),
        0
      )
    ).toBe('detail');
  });

  it('keeps index fallback for older cached plugins without tags', () => {
    expect(polymerRepresentationSlotForCell('query', representationCell('slot-0'), 0)).toBe(
      'primary'
    );
    expect(polymerRepresentationSlotForCell('query', representationCell('slot-1'), 1)).toBe(
      'detail'
    );
    expect(polymerRepresentationSlotForCell('context', representationCell('slot-1'), 1)).toBe(null);
  });
});
