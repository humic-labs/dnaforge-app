import { describe, it, expect } from 'vitest';
import {
  DEV_SCENARIO_PRESET_GROUPS,
  DEV_SCENARIO_PRESETS,
  filterDevScenarioPresetGroups,
} from './dev-presets';

const countPresets = (groups: readonly { presets: readonly unknown[] }[]) =>
  groups.reduce((sum, group) => sum + group.presets.length, 0);

describe('filterDevScenarioPresetGroups', () => {
  it('returns the groups unchanged for an empty or whitespace query', () => {
    expect(filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, '')).toBe(
      DEV_SCENARIO_PRESET_GROUPS
    );
    expect(filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, '   ')).toBe(
      DEV_SCENARIO_PRESET_GROUPS
    );
  });

  it('matches on the camelCase label a developer would type from memory', () => {
    const found = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'nrdFB');
    expect(countPresets(found)).toBe(1);
    expect(found[0].presets[0].label).toBe('nrdFBGroupIIntron');
  });

  it('matches on description prose, where gene names and ticket ids live', () => {
    const found = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'group I intron');
    expect(countPresets(found)).toBeGreaterThanOrEqual(1);
  });

  it('matches on the group heading, so a topic surfaces its whole group', () => {
    const found = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'recoded');
    expect(found).toHaveLength(1);
    expect(countPresets(found)).toBe(3);
  });

  it('matches on id and on legacy aliases', () => {
    expect(
      countPresets(filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'is3-slip'))
    ).toBe(1);
    expect(
      countPresets(filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'primer-proof'))
    ).toBe(1);
  });

  it('is case-insensitive', () => {
    const lower = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'prfb');
    const upper = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'PRFB');
    expect(countPresets(lower)).toBe(countPresets(upper));
    expect(countPresets(lower)).toBeGreaterThanOrEqual(1);
  });

  it('ANDs whitespace-separated terms, so more words narrow rather than widen', () => {
    const one = countPresets(filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'assembly'));
    const two = countPresets(
      filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'assembly golden')
    );
    expect(two).toBeLessThanOrEqual(one);
  });

  it('drops emptied groups so the panel shows no orphan headings', () => {
    const found = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'nrdFB');
    expect(found.every((group) => group.presets.length > 0)).toBe(true);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(
      filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'zzzz-no-such-scenario')
    ).toHaveLength(0);
  });

  it('never invents or duplicates a preset', () => {
    const found = filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, 'e');
    const ids = found.flatMap((group) => group.presets.map((preset) => preset.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(DEV_SCENARIO_PRESETS.length);
    for (const id of ids) {
      expect(DEV_SCENARIO_PRESETS.some((preset) => preset.id === id)).toBe(true);
    }
  });
});
