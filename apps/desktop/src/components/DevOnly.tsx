import type { ReactNode } from 'react';

export function DevOnly({ children }: { children: ReactNode }) {
  if (!import.meta.env.DEV) return null;
  return <>{children}</>;
}
