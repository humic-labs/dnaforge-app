import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  }, [host, visible, chrome]);
  return (
    <>
      <div
        ref={fallback}
        className={chrome ? 'dnaforge-terminal-chrome-fallback' : 'dnaforge-terminal-host-slot'}
        style={{ display: !target && visible ? (chrome ? 'contents' : 'flex') : 'none' }}
      />
      {createPortal(children, host)}
    </>
  );
}
