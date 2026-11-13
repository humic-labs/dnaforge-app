// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  createVariantSourceOperationPresenter,
  variantSourceOperationPresenters,
} from './variant-source-operation-presenter';

describe('variant source operation presenter', () => {
  it('gives the Jobs row a stable title without claiming an open-result action', () => {
    const presenter = createVariantSourceOperationPresenter();

    expect(presenter.title({} as never)).toBe('Prepare variant source');
    expect(presenter.review({} as never)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult({} as never)).toBe(false);
    expect(presenter.openResult).toBeNull();
    expect(variantSourceOperationPresenters()).toHaveProperty('variant-source-preparation');
  });
});
