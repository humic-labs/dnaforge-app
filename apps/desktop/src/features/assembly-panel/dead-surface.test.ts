// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as junctionLayout from './components/JunctionSequenceLayout';
import * as overhang from './hooks/useOverhangValidation';

const here = dirname(fileURLToPath(import.meta.url));

function source(relativePath: string): string {
  return readFileSync(join(here, relativePath), 'utf8');
}

describe('unused assembly UI surface', () => {
  it('does not export the retired assembly-panel helpers', () => {
    const panel = source('./components/AssemblyPanel.tsx');
    const panelBarrel = source('./components/index.ts');
    const featureBarrel = source('./index.ts');
    const digest = source('./components/VirtualDigestPanel.tsx');

    expect(panel).not.toMatch(/function AssemblyPanel\b/);
    expect(panel).toMatch(/function AssemblyPanelContent\b/);
    expect(panelBarrel).not.toMatch(/export \{[^}]*\bAssemblyPanel\b/);
    expect(panelBarrel).toMatch(/AssemblyPanelContent/);
    expect(featureBarrel).not.toMatch(/export \{[^}]*\bAssemblyPanel\b/);
    expect(overhang).not.toHaveProperty('useFragmentValidation');
    expect(overhang).not.toHaveProperty('useAssemblyValidation');
    expect(overhang).not.toHaveProperty('useGoldenGateAssemblyValidation');
    expect(typeof overhang.validateGoldenGateAssembly).toBe('function');
    expect(junctionLayout).not.toHaveProperty('JUNCTION_ROW_CONTROL_COLUMN_CLASS');
    expect(typeof junctionLayout.calculateAlignedJunctionSequenceLayout).toBe('function');
    expect(existsSync(join(here, './components/JunctionSequenceText.tsx'))).toBe(false);
    expect(digest).not.toMatch(/FRAGMENT_COLORS/);
    expect(digest).not.toMatch(/GRAY_FRAGMENT_COLOR/);
    expect(digest).toMatch(/function VirtualDigestPanel\b/);
    expect(digest).toMatch(/function getFragmentColor\b/);
  });

  it('does not export the retired design assembly helpers', () => {
    const designIndex = source('../design/index.ts');
    expect(existsSync(join(here, '../design/components/PrimerInspectorPanel.tsx'))).toBe(false);
    expect(existsSync(join(here, '../design/hooks/useAssemblyDispatch.ts'))).toBe(false);
    expect(designIndex).not.toMatch(/PrimerInspectorPanel/);
    expect(designIndex).not.toMatch(/useAssemblyDispatch/);
    expect(designIndex).toMatch(/DesignDrawer/);
    expect(designIndex).toMatch(/reconcileMocloFactoryStageOutputsNow/);
  });
});
