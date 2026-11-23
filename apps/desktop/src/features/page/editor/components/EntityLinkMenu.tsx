import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MentionMenu,
  type MentionMenuProps,
  type MentionMenuRef,
  type MentionAttrs,
} from './MentionMenu';
import { resolveEntityLinks } from '../lib/search';
import { useEntityDiscovery } from '../lib/use-entity-discovery';
import { useEntityLinkTypes } from '../lib/use-entity-link-types';

export interface EntityLinkMenuProps extends Omit<MentionMenuProps, 'items'> {
  workspaceRoot: string | null;
  onReady?: () => void;
  scopeControl?: { limited: boolean; toggle: () => void };
}

export const EntityLinkMenu = forwardRef<MentionMenuRef, EntityLinkMenuProps>(
  function EntityLinkMenu(props, ref) {
    const [localScope, setLocalScope] = useState(false);
    const projectScope = props.scopeControl?.limited ?? localScope;
    const [linkError, setLinkError] = useState<string | null>(null);
    const home =
      !props.query.trim() &&
      !props.activeCategory &&
      !props.recentView &&
      !props.browseView &&
      !props.allView;
    const scope = {
      ...(projectScope && props.workspaceRoot ? { projectRoot: props.workspaceRoot } : {}),
    };
    const types = useEntityLinkTypes(scope);
    const discovery = useEntityDiscovery({
      query: props.query,
      filter: props.activeCategory?.filter,
      workspaceRoot: props.workspaceRoot,
      scope,
      recent: props.recentView || home,
      enabled: !props.browseView,
    });
    useLayoutEffect(() => {
      if (discovery.status !== 'loading' && (!props.browseView || !types.loading))
        props.onReady?.();
    }, [discovery.status, props.browseView, types.loading, props.onReady]);
    const requestToken = discovery.requestToken;
    const current = useRef({ requestToken, command: props.command });
    current.current = { requestToken, command: props.command };
    const alive = useRef(true);
    const resolving = useRef(false);
    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);
    useEffect(() => {
      setLinkError(null);
    }, [requestToken]);

    const command = async (attrs: MentionAttrs) => {
      if (
        resolving.current ||
        discovery.status !== 'ready' ||
        !discovery.items.some((item) => item.id === attrs.entityId)
      )
        return;
      resolving.current = true;
      try {
        const [resolved] = await resolveEntityLinks([attrs.entityId], scope);
        if (!alive.current || current.current.requestToken !== requestToken) return;
        if (!resolved || resolved.status !== 'available') {
          setLinkError('This entity is no longer available. Choose another result or refresh.');
          return;
        }
        const entity = resolved.entity;
        current.current.command({
          entityId: entity.id,
          entityType: entity.type,
          label: entity.name,
          path: entity.path,
          contentHash: entity.contentHash,
          objectUuid: entity.objectUuid,
          registryKind: entity.registryKind,
          projectId: entity.projectId,
        });
      } catch {
        if (alive.current && current.current.requestToken === requestToken)
          setLinkError('Could not verify this entity. Your text is unchanged. Try again.');
      } finally {
        resolving.current = false;
      }
    };

    return (
      <MentionMenu
        {...props}
        ref={ref}
        command={command}
        categories={types.types}
        items={discovery.groups}
        status={discovery.status}
        error={linkError ?? discovery.error ?? types.error}
        onRetry={() => {
          setLinkError(null);
          discovery.retry();
          if (types.error) types.retry();
        }}
        nextCursor={discovery.nextCursor}
        onLoadMore={discovery.loadMore}
        loadingMore={discovery.loadingMore}
        projectScope={projectScope}
        onToggleProjectScope={
          props.workspaceRoot
            ? (props.scopeControl?.toggle ?? (() => setLocalScope((value) => !value)))
            : undefined
        }
      />
    );
  }
);
