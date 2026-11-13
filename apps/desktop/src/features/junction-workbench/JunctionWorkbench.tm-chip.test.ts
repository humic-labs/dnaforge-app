// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { workbenchTemperatureSummary } from './JunctionWorkbench';

type Session = Parameters<typeof workbenchTemperatureSummary>[0];

function session(primerTms: number[]): Session {
  return {
    mode: 'goldengate',
    controls: {
      junctions: [{ homology: undefined, primers: primerTms.map((tm) => ({ tm })) }],
    },
  } as unknown as Session;
}

describe('workbenchTemperatureSummary  #11)', () => {
  it('shows the Anneal Tm chip for Golden Gate (no longer gated off)', () => {
    const items = workbenchTemperatureSummary(session([58.2, 57.8]));
    expect(items.find((i) => i.label === 'Anneal Tm')).toBeDefined();
  });

  it('filters RD placeholder primers (tm:0) — no chip for a pure-RD assembly', () => {
    const items = workbenchTemperatureSummary(session([0, 0]));
    expect(items.find((i) => i.label === 'Anneal Tm')).toBeUndefined();
  });

  it('mixed RD/PCR shows the chip from the real primer only', () => {
    const items = workbenchTemperatureSummary(session([0, 58.5]));
    const anneal = items.find((i) => i.label === 'Anneal Tm');
    expect(anneal?.value).toContain('58.5');
  });
});
