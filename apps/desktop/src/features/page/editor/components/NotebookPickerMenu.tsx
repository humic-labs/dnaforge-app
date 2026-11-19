import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { EntityLinkMenu, type EntityLinkMenuProps } from './EntityLinkMenu';
import { EntitySlashCommandMenu } from './EntitySlashCommandMenu';
import type { MentionMenuRef } from './MentionMenu';
import type { SlashCommandMenuProps } from './SlashCommandMenu';

export type NotebookPickerPage =
  | { kind: 'entity'; props: EntityLinkMenuProps }
  | { kind: 'slash'; props: SlashCommandMenuProps & { query: string } };

function pageKey(page: NotebookPickerPage) {
  if (page.kind === 'slash') return 'slash';
  const { activeCategory, browseView, recentView, allView } = page.props;
  return (
    activeCategory?.key ??
    (browseView ? 'types' : recentView ? 'recent' : allView ? 'all' : 'search')
  );
}

export const NotebookPickerMenu = forwardRef<MentionMenuRef, { page: NotebookPickerPage }>(
  function NotebookPickerMenu({ page }, ref) {
    const key = pageKey(page);
    const [limited, setLimited] = useState(false);
    const [visibleKey, setVisibleKey] = useState(key);
    const lastVisible = useRef(page);
    const activeMenu = useRef<MentionMenuRef>(null);
    const changing = visibleKey !== key;
    useLayoutEffect(() => {
      if (!changing) lastVisible.current = page;
    }, [changing, page]);
    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) =>
        changing
          ? ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
          : (activeMenu.current?.onKeyDown({ event }) ?? false),
    }));
    return (
      <>
        {(changing ? [lastVisible.current, page] : [page]).map((pane) => {
          const paneKey = pageKey(pane);
          const outgoing = paneKey !== key;
          const staged = changing && !outgoing;
          const menuRef = outgoing ? undefined : activeMenu;
          const onReady = staged ? () => setVisibleKey(key) : undefined;
          return (
            <div
              key={paneKey}
              hidden={staged}
              ref={(element) => {
                if (element) element.inert = outgoing;
              }}
              aria-busy={outgoing || undefined}
            >
              {pane.kind === 'entity' ? (
                <EntityLinkMenu
                  {...pane.props}
                  scopeControl={{ limited, toggle: () => setLimited((value) => !value) }}
                  command={outgoing ? () => {} : pane.props.command}
                  ref={menuRef}
                  onReady={onReady}
                />
              ) : (
                <EntitySlashCommandMenu {...pane.props} ref={menuRef} onReady={onReady} />
              )}
            </div>
          );
        })}
      </>
    );
  }
);
