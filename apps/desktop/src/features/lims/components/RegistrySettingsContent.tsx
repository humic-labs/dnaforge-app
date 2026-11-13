import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Notice } from '../../../components/ui';
import type { LimsSchemaDefinitionView } from '../../../shared/lims';
import { getLimsSchemas } from '../operations';
import { RegistrySchemaManager } from './registry/RegistrySchemaManager';
import type { RegistrySchemaSource } from './registry/registry-schema-library-types';

export type RegistrySettingsTab = 'schemas' | 'registration';

export function RegistrySettingsContent({
  sources = [],
  sourceError,
  sourceNotice,
  onRetrySources,
  registration,
  tab,
  onTabChange,
}: {
  sources?: RegistrySchemaSource[];
  sourceError?: string | null;
  sourceNotice?: string | null;
  onRetrySources?: () => void;
  registration?: ReactNode;
  tab?: RegistrySettingsTab;
  onTabChange?: (tab: RegistrySettingsTab) => void;
}) {
  const [schemas, setSchemas] = useState<LimsSchemaDefinitionView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<RegistrySettingsTab>('schemas');
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const serial = ++request.current;
    setError(null);
    try {
      const items = await getLimsSchemas();
      if (mounted.current && request.current === serial) setSchemas(items);
    } catch (cause) {
      if (mounted.current && request.current === serial) {
        setError(toUserMessage(cause, 'failure.schemas-could-not-be-loaded'));
      }
      throw cause;
    } finally {
      if (mounted.current && request.current === serial) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => undefined);
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, [refresh]);
  const activeTab = registration ? (tab ?? selectedTab) : 'schemas';
  const selectTab = (next: RegistrySettingsTab) => {
    setSelectedTab(next);
    onTabChange?.(next);
  };
  return (
    <section data-testid="settings-registry" aria-label="Registry settings" className="space-y-4">
      <h1 className="text-xl font-semibold text-fg">Registry</h1>
      {registration ? (
        <div role="tablist" aria-label="Registry settings" className="flex gap-2">
          {(['schemas', 'registration'] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              id={`registry-settings-tab-${value}`}
              aria-controls={`registry-settings-panel-${value}`}
              aria-selected={activeTab === value}
              variant={activeTab === value ? 'primary' : 'secondary'}
              onClick={() => selectTab(value)}
            >
              {value === 'schemas' ? 'Schemas' : 'Registration'}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <Notice tone="error">
          {toUserMessage(error, 'operation.failed')}
          <Button onClick={() => void refresh().catch(() => undefined)}>Retry</Button>
        </Notice>
      ) : null}
      {sourceError ? (
        <Notice tone="error">
          {toUserMessage(sourceError, 'operation.failed')}
          {onRetrySources ? (
            <Button onClick={onRetrySources}>Retry organization definitions</Button>
          ) : null}
        </Notice>
      ) : null}
      {sourceNotice ? <Notice>{sourceNotice}</Notice> : null}
      <div
        id="registry-settings-panel-schemas"
        role={registration ? 'tabpanel' : undefined}
        aria-labelledby={registration ? 'registry-settings-tab-schemas' : undefined}
        hidden={activeTab !== 'schemas'}
      >
        {loading && schemas === null ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading schemas…
          </p>
        ) : null}
        {schemas ? (
          <RegistrySchemaManager schemas={schemas} sources={sources} onChanged={refresh} />
        ) : null}
      </div>
      {registration ? (
        <div
          id="registry-settings-panel-registration"
          role="tabpanel"
          aria-labelledby="registry-settings-tab-registration"
          hidden={activeTab !== 'registration'}
        >
          {registration}
        </div>
      ) : null}
    </section>
  );
}
