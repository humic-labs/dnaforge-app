// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  alignmentCoverageOperationPresenters,
  createAlignmentCoverageOperationPresenter,
} from './alignment-coverage-operation-presenter';

describe('alignment coverage operation presenter', () => {
  it('gives Jobs a feature-owned label and no false result action', () => {
    const presenter = createAlignmentCoverageOperationPresenter();

    expect(presenter.title({} as never)).toBe('Prepare alignment coverage');
    expect(presenter.review({} as never)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult({} as never)).toBe(false);
    expect(presenter.openResult).toBeNull();
  });

  it('registers the compiled operation kind', () => {
    expect(alignmentCoverageOperationPresenters()).toHaveProperty('alignment-coverage-preparation');
  });
});
