import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  PresentationScopeContext,
  usePresentationSurface,
} from '../../presentation/PresentationSurface';

export function TerminalGroupHost({
  target,
  visible,
  children,
  chrome = false,
}: {
  target?: HTMLElement;
  visible: boolean;
  children: ReactNode;
  chrome?: boolean;
}) {
  const parentId = target?.closest<HTMLElement>('[data-presentation-surface]')?.dataset
    .presentationSurface;
  const presentation = usePresentationSurface({ parentId, active: visible });
  const fallback = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = chrome ? 'dnaforge-terminal-chrome-host' : 'dnaforge-terminal-group';
    return element;
  });
  useLayoutEffect(() => {
    const destination = target ?? fallback.current;
    destination?.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host, target]);
  useLayoutEffect(() => {
    host.style.display = visible ? (chrome ? 'contents' : 'flex') : 'none';
    host.dataset.presentationSurface = presentation.id;
    host.toggleAttribute('inert', !presentation.visible);
    host.style.contentVisibility = presentation.visible ? '' : 'hidden';
  }, [host, visible, chrome, presentation.id, presentation.visible]);
  return (
    <>
      <div
        ref={fallback}
        className={chrome ? 'dnaforge-terminal-chrome-fallback' : 'dnaforge-terminal-host-slot'}
        style={{ display: !target && visible ? (chrome ? 'contents' : 'flex') : 'none' }}
      />
      <PresentationScopeContext.Provider value={presentation.scope}>
        {createPortal(children, host)}
      </PresentationScopeContext.Provider>
    </>
  );
}
