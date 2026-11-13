import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ReferenceContextProvider,
  useOptionalReferenceContext,
  useReferenceContext,
  type ReferenceContext,
} from './reference-context';

const CTX: ReferenceContext = {
  owningRoot: '/workspaces/beta',
  workspaceScopeKey: 'repo-uuid-beta',
};

function Consumer(): React.JSX.Element {
  const ctx = useReferenceContext();
  return (
    <div>
      <span data-testid="root">{ctx.owningRoot}</span>
      <span data-testid="scope">{ctx.workspaceScopeKey}</span>
    </div>
  );
}

function OptionalConsumer(): React.JSX.Element {
  const ctx = useOptionalReferenceContext();
  return <span data-testid="optional">{ctx ? ctx.owningRoot : 'none'}</span>;
}

describe('ReferenceContext', () => {
  it('provides the owning root and scope key to descendants', () => {
    render(
      <ReferenceContextProvider value={CTX}>
        <Consumer />
      </ReferenceContextProvider>
    );

    expect(screen.getByTestId('root')).toHaveTextContent('/workspaces/beta');
    expect(screen.getByTestId('scope')).toHaveTextContent('repo-uuid-beta');
  });

  it('throws a named error when consumed outside a provider', () => {
    expect(() => render(<Consumer />)).toThrow(/ReferenceContextProvider/);
  });

  it('lets an optional consumer opt out of the throw', () => {
    render(<OptionalConsumer />);
    expect(screen.getByTestId('optional')).toHaveTextContent('none');
  });

  it('serves the nearest provider when nested', () => {
    render(
      <ReferenceContextProvider value={CTX}>
        <ReferenceContextProvider
          value={{ owningRoot: '/workspaces/inner', workspaceScopeKey: 'inner-scope' }}
        >
          <Consumer />
        </ReferenceContextProvider>
      </ReferenceContextProvider>
    );

    expect(screen.getByTestId('root')).toHaveTextContent('/workspaces/inner');
    expect(screen.getByTestId('scope')).toHaveTextContent('inner-scope');
  });
});
