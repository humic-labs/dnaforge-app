import { forwardRef, useMemo, useLayoutEffect } from 'react';
import {
  SlashCommandMenu,
  type SlashCommandMenuProps,
  type SlashCommandMenuRef,
} from './SlashCommandMenu';
import { useEntityLinkTypes } from '../lib/use-entity-link-types';
import { entityLinkSlashCommands } from '../lib/entity-link-commands';

export const EntitySlashCommandMenu = forwardRef<
  SlashCommandMenuRef,
  SlashCommandMenuProps & { query: string; onReady?: () => void }
>(function EntitySlashCommandMenu({ items, query, command, onReady }, ref) {
  const types = useEntityLinkTypes();
  useLayoutEffect(() => {
    if (!types.loading) onReady?.();
  }, [types.loading, onReady]);
  const commands = useMemo(
    () => [
      ...items.filter((item) => item.category !== 'entity'),
      ...entityLinkSlashCommands(types.types, query),
    ],
    [items, query, types.types]
  );
  return (
    <SlashCommandMenu
      ref={ref}
      items={commands}
      command={command}
      error={types.error}
      onRetry={types.retry}
    />
  );
});
