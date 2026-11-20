// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { useEntityViewHistory } from './recent-entity-views';

beforeEach(() => {
  localStorage.clear();
  useEntityViewHistory.setState({ views: [] });
});

it('keeps viewing time separately from entity edits and stores only canonical identities', () => {
  const { recordView } = useEntityViewHistory.getState();
  recordView('project-beta::sequence', 200);
  recordView('project-alpha::sequence', 100);
  expect(useEntityViewHistory.getState().views).toEqual([
    { entityId: 'project-beta::sequence', viewedAt: 200 },
    { entityId: 'project-alpha::sequence', viewedAt: 100 },
  ]);
});

it('revisiting moves one identity to the top while late observations cannot move it backward', () => {
  const { recordView } = useEntityViewHistory.getState();
  recordView('a', 100);
  recordView('b', 200);
  recordView('a', 300);
  recordView('a', 50);
  expect(useEntityViewHistory.getState().views).toEqual([
    { entityId: 'a', viewedAt: 300 },
    { entityId: 'b', viewedAt: 200 },
  ]);
});

it('persists views across app reloads without copying names, kinds or entity content', async () => {
  useEntityViewHistory.getState().recordView('catalog-id', 100);
  const saved = localStorage.getItem('dnaforge-entity-view-history')!;
  useEntityViewHistory.setState({ views: [] });
  localStorage.setItem('dnaforge-entity-view-history', saved);
  await useEntityViewHistory.persist.rehydrate();
  expect(useEntityViewHistory.getState().views).toEqual([
    { entityId: 'catalog-id', viewedAt: 100 },
  ]);
  expect(JSON.parse(saved).state).toEqual({ views: [{ entityId: 'catalog-id', viewedAt: 100 }] });
});

it('bounds history and rejects invalid persisted viewing metadata', async () => {
  const { recordView } = useEntityViewHistory.getState();
  for (let index = 0; index < 105; index++) recordView(`entity-${index}`, index);
  expect(useEntityViewHistory.getState().views).toHaveLength(100);
  expect(useEntityViewHistory.getState().views[99].entityId).toBe('entity-5');
  localStorage.setItem(
    'dnaforge-entity-view-history',
    JSON.stringify({ state: { views: [{ entityId: {}, viewedAt: 'yesterday' }] }, version: 0 })
  );
  await useEntityViewHistory.persist.rehydrate();
  expect(useEntityViewHistory.getState().views).toEqual([]);
});
