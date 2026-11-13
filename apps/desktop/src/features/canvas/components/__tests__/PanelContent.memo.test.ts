// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PanelContent } from '../PanelContent';
import { panelContentPropsEqual } from '../panel-content-props';

describe('PanelContent memoization ', () => {
  it('is wrapped in React.memo', () => {
    expect((PanelContent as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );
  });

  it('uses the document-aware prop comparator', () => {
    expect((PanelContent as unknown as { compare?: unknown }).compare).toBe(panelContentPropsEqual);
  });
});
