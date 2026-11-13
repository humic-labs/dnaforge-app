import { createContext, useContext, type ReactNode } from 'react';

const TabActivityContext = createContext<boolean>(true);

export function TabActivityProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <TabActivityContext.Provider value={active}>{children}</TabActivityContext.Provider>;
}

export function useIsTabActive(): boolean {
  return useContext(TabActivityContext);
}
