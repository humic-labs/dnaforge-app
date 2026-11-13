import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CompiledBroadDemandCellBank } from './indexed-compiled-broad-demand-cells';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function cell(id: string) {
  return { cellId: id };
}

describe('CompiledBroadDemandCellBank', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain('class CompiledBroadDemandCellBank');
  });

  it('promotes a lower-tier cell into required and drops it from every other tier', () => {
    const bank = new CompiledBroadDemandCellBank();
    bank.addPrefetch(cell('a'));
    bank.addSuccessor(cell('a'));
    bank.addRequired(cell('a'));
    expect([...bank.required.keys()]).toEqual(['a']);
    expect(bank.successor.size).toBe(0);
    expect(bank.prefetch.size).toBe(0);
  });

  it('refuses to demote a higher-tier cell into prefetch or interaction prefetch', () => {
    const bank = new CompiledBroadDemandCellBank();
    bank.addRequired(cell('need'));
    bank.addSuccessor(cell('next'));
    bank.addInteractionPrefetch(cell('need'));
    bank.addInteractionPrefetch(cell('next'));
    bank.addPrefetch(cell('need'));
    bank.addPrefetch(cell('next'));
    expect([...bank.required.keys()]).toEqual(['need']);
    expect([...bank.successor.keys()]).toEqual(['next']);
    expect(bank.interactionPrefetch.size).toBe(0);
    expect(bank.prefetch.size).toBe(0);
  });

  it('keeps successor ahead of interaction prefetch, and prefetch last', () => {
    const bank = new CompiledBroadDemandCellBank();
    bank.addPrefetch(cell('warm'));
    bank.addInteractionPrefetch(cell('runway'));
    bank.addSuccessor(cell('runway'));
    expect([...bank.successor.keys()]).toEqual(['runway']);
    expect([...bank.prefetch.keys()]).toEqual(['warm']);
    expect(bank.interactionPrefetch.size).toBe(0);
  });
});
