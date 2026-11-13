import { shallow } from 'zustand/shallow';
import type { Tab } from '../types';

export function panelContentPropsEqual<T extends { tab: Tab | null }>(
  previous: T,
  next: T
): boolean {
  if (!shallow({ ...previous, tab: null }, { ...next, tab: null })) return false;
  if (previous.tab === next.tab) return true;
  if (
    previous.tab?.type !== 'sequence' ||
    next.tab?.type !== 'sequence' ||
    !previous.tab.sequenceDocument ||
    !next.tab.sequenceDocument
  ) {
    return false;
  }
  const { viewState: previousView, ...previousDocument } = previous.tab;
  const { viewState: nextView, ...nextDocument } = next.tab;
  return (
    shallow(previousDocument, nextDocument) &&
    previousView?.entityDetailsOpen === nextView?.entityDetailsOpen &&
    previousView?.entityDetailsEntityId === nextView?.entityDetailsEntityId
  );
}
