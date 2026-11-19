import { useEffect, useRef, useState } from 'react';
import { Button } from '@/shared/components/Button';
import { Button as ActionButton } from '../../../components/ui';
import { Input } from '@/shared/components/Input';
import { MenuRow, MenuSurface } from '@waypoint/ui-components';
import {
  entityLocationLabel,
  getEntityIcon,
  resolveEntityLinks,
  type Entity,
  type EntityLinkFilter,
} from '../editor/lib/search';
import { useEntityDiscovery } from '../editor/lib/use-entity-discovery';
import { useOptionalReferenceContext } from '../entity-ref/reference-context';

export function EntityPicker({
  label,
  filter,
  onSelect,
  onCancel,
  selectFirst = false,
}: {
  label: string;
  filter: EntityLinkFilter;
  onSelect: (entity: Entity) => void;
  onCancel: () => void;
  selectFirst?: boolean;
}) {
  const context = useOptionalReferenceContext();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const discovery = useEntityDiscovery({ query, filter, workspaceRoot: context?.owningRoot });
  const requestToken = discovery.requestToken;
  const currentRequestToken = useRef(requestToken);
  currentRequestToken.current = requestToken;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setSelectedId(null);
    setError(null);
  }, [requestToken]);
  const selected =
    discovery.items.find((entity) => entity.id === selectedId) ??
    (selectFirst ? discovery.items[0] : undefined);

  const confirm = async (entity = selected) => {
    if (
      !entity ||
      confirming ||
      discovery.status !== 'ready' ||
      !discovery.items.some((item) => item.id === entity.id)
    )
      return;
    setConfirming(true);
    try {
      const [resolved] = await resolveEntityLinks([entity.id]);
      if (!alive.current || currentRequestToken.current !== requestToken) return;
      if (resolved?.status === 'available') onSelect(resolved.entity);
      else setError('This entity is no longer available. Refresh the results.');
    } catch {
      if (alive.current && currentRequestToken.current === requestToken)
        setError('Could not verify this entity. Try again.');
    } finally {
      if (alive.current) setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Search ${label}...`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
          if (event.key === 'Enter' && selected) {
            event.preventDefault();
            void confirm();
          }
          if (
            (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
            discovery.status === 'ready' &&
            discovery.items.length
          ) {
            event.preventDefault();
            const index = discovery.items.findIndex((entity) => entity.id === selectedId);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const next =
              index < 0
                ? direction > 0
                  ? 0
                  : discovery.items.length - 1
                : (index + direction + discovery.items.length) % discovery.items.length;
            setSelectedId(discovery.items[next].id);
          }
        }}
        autoFocus
      />
      <MenuSurface
        surface="inline-workspace"
        layout={{ maxHeight: '12rem', overflowY: 'auto' }}
        density="form"
        icons
        selection={false}
        role="listbox"
        aria-label={label}
        aria-busy={discovery.status === 'loading'}
      >
        {discovery.status === 'loading' && (
          <div className={discovery.items.length ? 'sr-only' : 'px-3 py-2 text-sm text-fg-muted'}>
            Loading…
          </div>
        )}
        {discovery.status === 'ready' && !discovery.items.length && (
          <div className="px-3 py-2 text-sm text-fg-muted">No {label} found</div>
        )}
        {discovery.items.map((entity) => (
          <MenuRow
            key={entity.id}
            type="button"
            role="option"
            aria-selected={selected?.id === entity.id}
            aria-disabled={discovery.status !== 'ready' ? true : undefined}
            onClick={() => {
              if (discovery.status === 'ready') setSelectedId(entity.id);
            }}
            onDoubleClick={() => void confirm(entity)}
            active={selectedId === entity.id}
            icon={getEntityIcon(entity)}
            description={
              <>
                {entity.sequenceLength != null
                  ? `${entity.sequenceLength.toLocaleString()} ${entity.type === 'protein' || entity.registryKind === 'protein' ? 'aa' : 'bp'} · `
                  : ''}
                {[entity.kindLabel, entityLocationLabel(entity)].filter(Boolean).join(' · ')}
              </>
            }
          >
            {entity.name}
          </MenuRow>
        ))}
        {discovery.nextCursor && discovery.status === 'ready' && (
          <MenuRow disabled={discovery.loadingMore} onClick={discovery.loadMore}>
            {discovery.loadingMore ? 'Loading…' : 'Load more results'}
          </MenuRow>
        )}
      </MenuSurface>
      {(error || discovery.error) && (
        <div role="alert" className="text-sm text-fg-muted">
          {error ?? discovery.error}
          <span className="ml-2 text-fg">
            <ActionButton
              type="button"
              variant="link"
              onClick={() => {
                setError(null);
                discovery.retry();
              }}
            >
              Refresh
            </ActionButton>
          </span>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void confirm()}
          disabled={!selected || confirming || discovery.status !== 'ready'}
        >
          {confirming ? 'Checking…' : 'Insert Link'}
        </Button>
      </div>
    </div>
  );
}
