import { describe, expect, it } from 'vitest';

import { DEV_SCENARIO_PRESET_GROUPS } from './dev-presets';
import {
  LEGACY_REPAIR_NOTEBOOK_DIR,
  LEGACY_REPAIR_ROOT,
  legacyReferenceRepairWorkspace,
} from './legacy-reference-repair';

function notebookJsonOf(scenario: ReturnType<typeof legacyReferenceRepairWorkspace>): string {
  const files = scenario.files ?? {};
  const key = Object.keys(files).find((p) => p.endsWith('.forge/notebook.json'));
  expect(key, 'the scenario must materialize a notebook package').toBeTruthy();
  return String(files[key!]);
}

describe('legacyReferenceRepairWorkspace', () => {
  it('materializes the sequence files at their PACKAGED paths', () => {
    const paths = Object.keys(legacyReferenceRepairWorkspace().files ?? {});

    for (const stem of ['J23106_AB', 'E1010m_CD', 'B0015_DE']) {
      expect(
        paths.some((p) => p.endsWith(`sequences/kits/moclo-cidar/${stem}/${stem}.gb`)),
        `${stem} must exist at its packaged path`
      ).toBe(true);
      expect(
        paths.some((p) => p.endsWith(`sequences/kits/moclo-cidar/${stem}.gb`)),
        `${stem} must NOT also exist at the flat path, or nothing is broken`
      ).toBe(false);
    }
  });

  it('🟥 writes chips that point at the OLD FLAT paths — the break itself', () => {
    const json = notebookJsonOf(legacyReferenceRepairWorkspace());

    expect(json).toContain('sequences/kits/moclo-cidar/E1010m_CD.gb');
    expect(json).toContain('sequences/kits/moclo-cidar/J23106_AB.gb');
    expect(json).toContain('sequences/kits/moclo-cidar/B0015_DE.gb');
  });

  it('🟥 writes chips with NOTHING durable, or there is nothing to repair', () => {
    const json = notebookJsonOf(legacyReferenceRepairWorkspace());

    expect(json, 'a chip carrying a durable id would be skipped by the repair').not.toContain(
      'objectUuid'
    );
    expect(json).not.toContain('contentHash');
    expect(json, 'a chip carrying a path would resolve without repair').not.toMatch(/"path"\s*:/);
  });

  it('uses DISPLAY labels that do not match the file stems', () => {
    const json = notebookJsonOf(legacyReferenceRepairWorkspace());

    expect(json).toContain('E1010m (mRFP)');
    expect(json).not.toContain('"label": "E1010m_CD"');
  });

  it('does NOT open the notebook — the repair runs at the file->store seam', () => {
    const scenario = legacyReferenceRepairWorkspace();
    const tabs = scenario.canvas?.tabs ?? [];

    expect(tabs.length).toBe(1);
    expect(tabs[0].entityId).toContain('PROOF.md');
    expect(
      tabs.some((t) => t.entityId.includes('notebook')),
      'the notebook must be opened by hand, through the real file tree'
    ).toBe(false);
  });

  it('ships a walkthrough that names the packaged path as the success signal', () => {
    const files = legacyReferenceRepairWorkspace().files ?? {};
    const guide = String(files[`${LEGACY_REPAIR_ROOT}/PROOF.md`] ?? '');

    expect(guide.length, 'PROOF.md must exist').toBeGreaterThan(200);
    expect(guide).toContain('E1010m_CD/E1010m_CD.gb');
    expect(guide.toLowerCase()).toContain('migration, not a healer');
    expect(guide.toLowerCase()).toContain('refuses to guess');
  });

  it('mints a fresh scenario id per apply, so a previous run cannot make it pass', () => {
    const a = legacyReferenceRepairWorkspace();
    const b = legacyReferenceRepairWorkspace();

    expect(a.dev?.scenarioId).toBeTruthy();
    expect(a.dev?.scenarioId).not.toBe(b.dev?.scenarioId);
    expect(a.dev?.initializeGit).toBe(true);
  });

  it('writes the notebook package under the notebooks directory', () => {
    const paths = Object.keys(legacyReferenceRepairWorkspace().files ?? {});
    expect(paths).toContain(`${LEGACY_REPAIR_NOTEBOOK_DIR}/.forge/notebook.json`);
    expect(LEGACY_REPAIR_NOTEBOOK_DIR).toContain('/notebooks/');
  });

  it('is registered in the DevPanel with noAutoReplay', () => {
    const entries = DEV_SCENARIO_PRESET_GROUPS.flatMap((group) =>
      group.presets.map((preset) => ({ group: group.id, preset }))
    );
    const found = entries.find((entry) => entry.preset.id === 'legacy-reference-repair');

    expect(found, 'the preset must be reachable from the DevPanel').toBeTruthy();
    expect(found!.group).toBe('notebook-references');
    expect(found!.preset.noAutoReplay).toBe(true);
    expect(found!.preset.aliases).toContain('legacy-repair');
  });
});
