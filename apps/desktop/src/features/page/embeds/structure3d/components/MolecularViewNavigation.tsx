import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRightIcon } from '../../../../../components/icons';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import { molViewSpecStorySteps } from '../utils/molViewSpecStory';
import { MolecularViewLibrary } from './MolecularViewLibrary';
import { useMolecularViewWorkspace } from './MolecularViewWorkspace';

const actionClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted wp-interactive disabled:opacity-30';

export type MolecularViewNavigationProps = {
  scene: string;
  activeIndex: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
};

export function MolecularViewNavigation({
  scene,
  activeIndex,
  onSelect,
  disabled = false,
}: MolecularViewNavigationProps) {
  const steps = useMemo(() => molViewSpecStorySteps(scene), [scene]);
  const workspace = useMolecularViewWorkspace();
  const open = workspace?.libraryOpen ?? false;
  const trigger = useRef<HTMLButtonElement>(null);
  const setLibraryOpen = workspace?.setLibraryOpen;
  useLayoutEffect(() => {
    const footer = workspace?.footer;
    const navigation = workspace?.navigation;
    if (!footer || !navigation || steps.length < 2) return;
    let cancelled = false;
    const measure = () => {
      const title = trigger.current?.querySelector<HTMLElement>(
        '[data-testid="molecular-view-key-title"]'
      );
      const counter = trigger.current?.querySelector<HTMLElement>('[aria-label^="View "]');
      if (cancelled || !title || !counter || !navigation.getBoundingClientRect().width) return;
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      const font = getComputedStyle(title);
      context.font = font.font || `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      let longest = 0;
      for (const step of steps) longest = Math.max(longest, context.measureText(step.title).width);
      const counterFont = getComputedStyle(counter);
      context.font =
        counterFont.font ||
        `${counterFont.fontWeight} ${counterFont.fontSize} ${counterFont.fontFamily}`;
      let digit = 0;
      for (const character of '0123456789')
        digit = Math.max(digit, context.measureText(character).width);
      const count = digit * String(steps.length).length * 2 + context.measureText('/').width;
      const chrome =
        navigation.getBoundingClientRect().width -
        title.getBoundingClientRect().width -
        counter.getBoundingClientRect().width;
      const width = `${Math.ceil(longest + Math.max(count, counter.getBoundingClientRect().width) + chrome + 2)}px`;
      if (footer.style.getPropertyValue('--molecular-view-navigation-width') !== width)
        footer.style.setProperty('--molecular-view-navigation-width', width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (workspace?.root) observer.observe(workspace.root);
    const fonts = document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener('loadingdone', measure);
    return () => {
      cancelled = true;
      observer.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
      footer.style.removeProperty('--molecular-view-navigation-width');
    };
  }, [steps, workspace?.footer, workspace?.navigation, workspace?.root]);
  useEffect(() => {
    if (steps.length < 2) setLibraryOpen?.(false);
    return () => setLibraryOpen?.(false);
  }, [steps.length, setLibraryOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!workspace?.footer?.contains(event.target as Node)) setLibraryOpen?.(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, workspace?.footer]);
  if (!workspace) throw Error('View navigation requires a molecular view workspace.');
  if (steps.length < 2 || !workspace.navigation) return null;
  const close = () => {
    setLibraryOpen?.(false);
    safeFocus(trigger.current, { preventScroll: true });
  };
  const select = (index: number) => {
    if (disabled || !steps[index]) return;
    onSelect(index);
    close();
  };
  return (
    <>
      {createPortal(
        <div
          data-testid="molecular-view-navigation"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div role="toolbar" aria-label="Visualization views" className="flex items-center gap-1">
            <button
              ref={trigger}
              type="button"
              aria-label={`Browse ${steps.length} views`}
              aria-expanded={open}
              title={steps[activeIndex]?.title}
              onClick={() => (open ? close() : setLibraryOpen?.(true))}
              className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded px-1 text-right text-xs text-fg-muted wp-interactive "
            >
              <span data-testid="molecular-view-key-title" className="min-w-0 flex-1 truncate">
                {steps[activeIndex]?.title}
              </span>
              <span
                className="shrink-0 text-[10px] tabular-nums text-fg-subtle"
                aria-label={`View ${activeIndex + 1} of ${steps.length}`}
              >
                {activeIndex + 1}/{steps.length}
              </span>
              <ChevronRightIcon size={10} className={open ? 'rotate-90' : '-rotate-90'} />
            </button>
            <button
              type="button"
              aria-label="Previous view"
              title="Previous view"
              disabled={disabled || activeIndex <= 0}
              onClick={() => select(activeIndex - 1)}
              className={actionClass}
            >
              <ChevronRightIcon size={11} className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Next view"
              title="Next view"
              disabled={disabled || activeIndex >= steps.length - 1}
              onClick={() => select(activeIndex + 1)}
              className={actionClass}
            >
              <ChevronRightIcon size={11} />
            </button>
          </div>
        </div>,
        workspace.navigation
      )}
      {open &&
        workspace.library &&
        createPortal(
          <MolecularViewLibrary
            steps={steps}
            activeIndex={activeIndex}
            disabled={disabled}
            onSelect={select}
            onClose={close}
          />,
          workspace.library
        )}
    </>
  );
}
