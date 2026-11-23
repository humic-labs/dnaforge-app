import { beforeEach, expect, it } from 'vitest';
import { useDesignStore } from '../store';
import { checkDesignDraftRecovery } from './check-design-draft-recovery';

beforeEach(() => {
  useDesignStore.setState({ designs: {}, activeDesignId: null });
  localStorage.clear();
});

it('checks the live draft used by the normal opener without changing active selection or storage', () => {
  const draftId = useDesignStore.getState().createDesign('Recovered design');
  const currentId = useDesignStore.getState().createDesign('Active design');
  const draft = useDesignStore.getState().designs[draftId];
  const before = localStorage.getItem('waypoint-designs');
  const revision = checkDesignDraftRecovery(draftId);
  expect(revision).toMatch(/^[a-f0-9]{64}$/u);
  expect(useDesignStore.getState().activeDesignId).toBe(currentId);
  expect(useDesignStore.getState().designs[draftId]).toBe(draft);
  expect(localStorage.getItem('waypoint-designs')).toBe(before);

  useDesignStore.setState((state) => ({
    designs: { ...state.designs, [draftId]: { ...draft, name: 'Edited design' } },
  }));
  expect(checkDesignDraftRecovery(draftId)).not.toBe(revision);
});

it('requires the exact draft key and leaves unrelated drafts alone', () => {
  const id = useDesignStore.getState().createDesign('Unrelated available draft');
  expect(() => checkDesignDraftRecovery('missing-design')).toThrow(
    expect.objectContaining({ code: 'missing-asset', recognized: true })
  );
  expect(() => checkDesignDraftRecovery(id)).not.toThrow();
});

it('reports a corrupt draft or a draft stored under the wrong key', () => {
  const id = useDesignStore.getState().createDesign('Draft');
  const original = useDesignStore.getState().designs[id];
  const wrongShape = { ...original, regions: null } as unknown as typeof original;
  useDesignStore.setState({ designs: { [id]: wrongShape } });
  expect(() => checkDesignDraftRecovery(id)).toThrow(
    expect.objectContaining({ code: 'malformed', recognized: true })
  );

  useDesignStore.setState({ designs: { [id]: { ...original, id: 'different-draft' } } });
  expect(() => checkDesignDraftRecovery(id)).toThrow(
    expect.objectContaining({ code: 'malformed', recognized: true })
  );
});
