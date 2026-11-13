import { afterEach, describe, expect, it } from 'vitest';
import {
  freezeDesignEditsForPublication,
  unfreezeDesignEditsForPublication,
  useDesignStore,
  withAuthorizedDesignPublicationUpdate,
} from './store';

describe('assembly publication edit fence', () => {
  const designId = 'publication-fence-design';

  afterEach(() => {
    unfreezeDesignEditsForPublication(designId);
    useDesignStore.setState({ designs: {}, activeDesignId: null });
  });

  it('blocks both action and direct-store edits while allowing the publication writer', () => {
    const sourceId = useDesignStore.getState().createDesign('Before');
    const design = useDesignStore.getState().designs[sourceId];
    useDesignStore.setState({ designs: { [designId]: { ...design, id: designId } } });
    freezeDesignEditsForPublication(designId);

    expect(() =>
      useDesignStore.getState().updateDesign(designId, { name: 'Unauthorized' })
    ).toThrow(/being finalized/);
    expect(() =>
      useDesignStore.setState((state) => ({
        designs: {
          ...state.designs,
          [designId]: { ...state.designs[designId], name: 'Also unauthorized' },
        },
      }))
    ).toThrow(/being finalized/);
    expect(useDesignStore.getState().designs[designId].name).toBe('Before');

    withAuthorizedDesignPublicationUpdate(designId, () =>
      useDesignStore.getState().updateDesign(designId, { name: 'Published' })
    );
    expect(useDesignStore.getState().designs[designId].name).toBe('Published');
  });
});
