'use client';

import { DarkModeProvider } from './DarkModeContext';
import { PanelContextProvider } from './PanelContext';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <DarkModeProvider>
      <PanelContextProvider>{children}</PanelContextProvider>
    </DarkModeProvider>
  );
}
