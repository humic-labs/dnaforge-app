// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  alignmentIndexOperationPresenters,
  createAlignmentIndexOperationPresenter,
} from './alignment-index-operation-presenter';

describe('alignment index operation presenter', () => {
  it('gives Jobs a feature-owned label and no false result action', () => {
    const presenter = createAlignmentIndexOperationPresenter();

    expect(presenter.title({} as never)).toBe('Prepare alignment index');
    expect(presenter.review({} as never)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult({} as never)).toBe(false);
    expect(presenter.openResult).toBeNull();
  });

  it('registers the compiled operation kind', () => {
    expect(alignmentIndexOperationPresenters()).toHaveProperty('alignment-index-preparation');
  });
});
