// @vitest-environment node
import { expect, it } from 'vitest';
import { parseNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { DEV_SCENARIO_PRESETS } from './dev-presets';
import {
  notebookAuthoringLinks,
  prepareNotebookAuthoringLinks,
  NOTEBOOK_AUTHORING_ALPHA_ROOT,
  NOTEBOOK_AUTHORING_BETA_ROOT,
  NOTEBOOK_AUTHORING_PAGE_ID,
  NOTEBOOK_AUTHORING_PRESET_ID,
} from './notebook-authoring-links';

it('keeps duplicate sequence names in separate native projects with distinct identities', () => {
  const scenario = notebookAuthoringLinks();
  const sources = Object.entries(scenario.sequenceSources ?? {});
  expect(sources).toHaveLength(2);
  expect(new Set(sources.map(([id]) => id)).size).toBe(2);
  expect(sources.map(([, source]) => source.sourcePath)).toEqual([
    `${NOTEBOOK_AUTHORING_ALPHA_ROOT}/pUC19.gb`,
    `${NOTEBOOK_AUTHORING_BETA_ROOT}/pUC19.gb`,
  ]);
  expect(sources.map(([, source]) => source.name)).toEqual(['pUC19', 'pUC19']);
});

it('serializes the visible notebook as a real package and offers the one-click preset', () => {
  const scenario = notebookAuthoringLinks();
  const markdown = Object.entries(scenario.files ?? {}).find(([path]) => path.endsWith('.md'));
  expect(markdown).toBeDefined();
  const packageRoot = markdown![0].slice(0, markdown![0].lastIndexOf('/'));
  const payloads = new Map(
    Object.entries(scenario.files ?? {})
      .filter(([path]) => path.startsWith(`${packageRoot}/.forge/blocks/`))
      .map(([path, content]) => [path.slice(packageRoot.length + 1), content as string])
  );
  const parsed = parseNotebookMarkdown({ markdown: markdown![1] as string, payloads });
  expect(parsed.id).toBe(NOTEBOOK_AUTHORING_PAGE_ID);
  expect(parsed.content.content?.[0]).toEqual({
    type: 'heading',
    attrs: { level: 1 },
    content: [{ type: 'text', text: 'Notebook authoring review' }],
  });
  expect(scenario.pages).toBeUndefined();
  const preset = DEV_SCENARIO_PRESETS.find((item) => item.id === NOTEBOOK_AUTHORING_PRESET_ID);
  expect(preset?.noAutoReplay).toBe(true);
  expect(preset?.afterApply).toBe(prepareNotebookAuthoringLinks);
});
