import { describe, it, expect } from 'vitest';
import {
  realAssemblyManyTabsAppScenario,
  realAssemblyManyTabs,
  realAssemblyManyTabsStress,
} from './assembly-real-pipeline';

describe('realAssemblyManyTabs scenario ', () => {
  it('opens the requested number of design tabs', () => {
    const scenario = realAssemblyManyTabsAppScenario(8);
    expect(scenario.canvas?.tabs).toHaveLength(8);
    expect(scenario.canvas?.tabs.every((tab) => tab.type === 'design')).toBe(true);
  });

  it('activates a MIDDLE tab, never the first or last', () => {
    for (const count of [4, 8, 11]) {
      const scenario = realAssemblyManyTabsAppScenario(count);
      const active = scenario.canvas?.activeTabIndex ?? 0;
      const tabs = scenario.canvas?.tabs ?? [];
      expect(active).toBeGreaterThan(0);
      expect(active).toBeLessThan(tabs.length - 1);
    }
  });

  it('gives every tab a DISTINCT design', () => {
    const scenario = realAssemblyManyTabsAppScenario(11);
    const entityIds = (scenario.canvas?.tabs ?? []).map((tab) => tab.entityId);
    expect(new Set(entityIds).size).toBe(entityIds.length);
  });

  it('seeds every tab’s design into the store, with the active pointer on the middle one', () => {
    const scenario = realAssemblyManyTabsAppScenario(8);
    const tabs = scenario.canvas?.tabs ?? [];
    const designs = scenario.designs?.designs ?? {};

    for (const tab of tabs) {
      expect(designs[tab.entityId], `design missing for tab ${tab.label}`).toBeDefined();
    }
    const middle = tabs[scenario.canvas?.activeTabIndex ?? 0];
    expect(scenario.designs?.activeDesignId).toBe(middle.entityId);
  });

  it('uses DRAFTED designs, so each tab carries a realistic render cost', () => {
    const scenario = realAssemblyManyTabsAppScenario(11);
    const designs = Object.values(scenario.designs?.designs ?? {});
    expect(designs.length).toBe(11);
    for (const design of designs) {
      expect(design.designPrimers?.length ?? 0, `${design.name} has no primers`).toBeGreaterThan(0);
      expect(design.assemblyState).toBe('ready');
    }
  });

  it('clamps a request beyond the fixture pool instead of producing empty tabs', () => {
    const scenario = realAssemblyManyTabsAppScenario(999);
    const tabs = scenario.canvas?.tabs ?? [];
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs.every((tab) => tab.entityId.length > 0)).toBe(true);
    expect(realAssemblyManyTabsAppScenario(0).canvas?.tabs.length).toBe(1);
  });

  it('exposes the two DevPanel factories the presets point at', () => {
    expect(realAssemblyManyTabs().canvas?.tabs).toHaveLength(8);
    expect(realAssemblyManyTabsStress().canvas?.tabs).toHaveLength(11);
  });
});
