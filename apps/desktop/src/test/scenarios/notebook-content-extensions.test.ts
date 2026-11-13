import { describe, expect, it } from 'vitest';

import { TABLE_NOTEBOOK_BLOCK } from '../../shared/table-notebook-contract';
import { DEV_SCENARIO_PRESET_GROUPS } from './dev-presets';
import { notebookContentExtensionsSession } from './notebook-content-extensions';

describe('notebook content extension scenario', () => {
  it('puts supported and future table versions in one visible notebook', () => {
    const scenario = notebookContentExtensionsSession();
    const page = scenario.pages?.pages[0];
    const embeds = page?.content.content?.filter((node) => node.type === 'embed') ?? [];

    expect(scenario.canvas).toEqual({
      tabs: [
        {
          type: 'page',
          entityId: 'fixture-notebook-content-extensions',
          label: 'Notebook content extensions',
        },
      ],
      activeTabIndex: 0,
    });
    expect(embeds.map((node) => node.attrs?.version)).toEqual([
      TABLE_NOTEBOOK_BLOCK.currentVersion,
      TABLE_NOTEBOOK_BLOCK.currentVersion + 1,
    ]);
    expect(embeds[1]?.attrs?.data).toMatchObject({
      name: 'Future table payload',
      futureOnlySetting: 'preserved',
    });
    expect(scenario.workspace?.folders).toEqual([
      {
        path: '/mock/test/workspace/notebook-content-extensions',
        name: 'Notebook content extensions',
      },
    ]);
    expect(Object.keys(scenario.files ?? {})).toEqual(
      expect.arrayContaining([
        '/mock/test/workspace/notebook-content-extensions/Notebook-content-extensions/.forge/notebook.json',
        '/mock/test/workspace/notebook-content-extensions/Notebook-content-extensions/Notebook-content-extensions.md',
      ])
    );
    expect(Object.keys(scenario.files ?? {})).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\/mock\/test\/workspace\/notebook-content-extensions\/Notebook-content-extensions\/\.forge\/blocks\/[a-f0-9]{16}\.json$/
        ),
      ])
    );
  });

  it('uses a fresh materialized workspace on every manual apply', () => {
    const first = notebookContentExtensionsSession().dev?.scenarioId;
    const second = notebookContentExtensionsSession().dev?.scenarioId;

    expect(first).toMatch(/^fixture-notebook-content-extensions-[a-f0-9-]+$/);
    expect(second).toMatch(/^fixture-notebook-content-extensions-[a-f0-9-]+$/);
    expect(first).not.toBe(second);
  });

  it('is available as a one-click DevPanel preset', () => {
    const preset = DEV_SCENARIO_PRESET_GROUPS.flatMap((group) => group.presets).find(
      ({ id }) => id === 'notebook-content-extensions'
    );

    expect(preset?.label).toBe('notebookContentExtensionsSession');
    expect(preset?.noAutoReplay).toBe(true);
  });
});
