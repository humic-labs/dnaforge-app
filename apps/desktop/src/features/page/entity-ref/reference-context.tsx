import { createContext, useContext, type ReactNode } from 'react';

export interface ReferenceContext {
  owningRoot: string;
  workspaceScopeKey: string;
  pageId?: string;
}

const Context = createContext<ReferenceContext | null>(null);

export function ReferenceContextProvider({
  value,
  children,
}: {
  value: ReferenceContext | null;
  children: ReactNode;
}): React.JSX.Element {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReferenceContext(): ReferenceContext {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error(
      'useReferenceContext must be used within a ReferenceContextProvider. ' +
        'A notebook reference cannot be resolved without knowing which project owns the page.'
    );
  }
  return ctx;
}

export function useOptionalReferenceContext(): ReferenceContext | null {
  return useContext(Context);
}
