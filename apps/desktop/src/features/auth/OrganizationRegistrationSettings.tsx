import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useState, type FormEvent } from 'react';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_CARD_CLASS,
  SettingsSection,
  SettingsNotice,
} from '../../components/SettingsSubsection';
import { requestRegistryOpen } from '../../shared/registry-events';
import type { OrganizationSettingsModel } from './useOrganizationSettings';
import { organizationRegistrySchemas } from './registry-schema-sources';

export function OrganizationRegistrationSettings({ model }: { model: OrganizationSettingsModel }) {
  const {
    selected,
    directory,
    loading,
    busy,
    error,
    viewer,
    registry,
    registrySync,
    registryLoading,
    refreshRegistry,
    refreshDirectory,
    configureRegistry,
    resolveRegistryConflict,
  } = model;
  const [registryPrefix, setRegistryPrefix] = useState('REG');
  const [registryPadWidth, setRegistryPadWidth] = useState('6');
  const [registryFormError, setRegistryFormError] = useState<string | null>(null);
  if (loading || !selected || directory?.orgId !== selected.orgId) {
    if (error && selected) {
      return (
        <SettingsNotice tone="error">
          {toUserMessage(error, 'account.failed')}
          <button
            type="button"
            className={SETTINGS_SECONDARY_BUTTON_CLASS}
            onClick={() => void refreshDirectory(selected.orgId)}
          >
            Retry organization
          </button>
        </SettingsNotice>
      );
    }
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading organization registration…
      </p>
    );
  }
  const errorBanner = error ? (
    <SettingsNotice testId="organization-admin-error" tone="error">
      {toUserMessage(error, 'account.failed')}
    </SettingsNotice>
  ) : null;
  const configured =
    registry != null &&
    registrySync != null &&
    registrySync.status !== 'not_configured' &&
    registrySync.status !== 'access_revoked';
  const handleConfigureRegistry = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setRegistryFormError(null);
    const padWidth = Number(registryPadWidth);
    if (!Number.isSafeInteger(padWidth) || padWidth < 2 || padWidth > 12) {
      setRegistryFormError(userMessage('failure.id-width-must-be-an-integer-from-2-through-12'));
      return;
    }
    await configureRegistry({
      defaultPrefix: registryPrefix.trim().toUpperCase(),
      defaultPadWidth: padWidth,
      schemes: [],
    });
  };

  const organizationSchemas = registry ? organizationRegistrySchemas(registry) : [];
  const openRegistry = (entityId: string | null = null, action: 'browse' | 'claim' = 'browse') =>
    requestRegistryOpen({ entityId, fallbackSearch: '', organizationId: selected.orgId, action });

  return (
    <SettingsSection
      title="Organization registration"
      description={selected.displayName}
      testId="organization-settings-registry"
    >
      {errorBanner}
      {registryFormError ? (
        <SettingsNotice tone="error">
          {toUserMessage(registryFormError, 'account.failed')}
        </SettingsNotice>
      ) : null}
      <div className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_CARD_CLASS}`}>
        <div>
          <p className="text-sm font-medium text-fg">
            {registryLoading
              ? 'Synchronizing…'
              : registrySync?.status === 'ready'
                ? 'Up to date'
                : registrySync?.status === 'error'
                  ? 'Offline changes are queued'
                  : registrySync?.status === 'access_revoked'
                    ? 'Access revoked; cached organization data was removed'
                    : 'Registration setup required'}
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {registry?.pendingMutations.length
              ? `${registry.pendingMutations.length} changes waiting to sync`
              : 'Organization custody and registration'}
          </p>
        </div>
        <button
          type="button"
          disabled={busy || registryLoading}
          onClick={() => void refreshRegistry(selected.orgId)}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          Sync now
        </button>
      </div>

      {registryLoading && !registry ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading organization registration…
        </p>
      ) : registrySync?.status === 'access_revoked' ? (
        <SettingsNotice tone="warning">
          Access to this Registry has been removed. Select an organization you can access.
        </SettingsNotice>
      ) : !registry && registrySync?.status !== 'not_configured' ? (
        <SettingsNotice tone="error">
          The Registry could not be loaded. Use Sync now to retry.
        </SettingsNotice>
      ) : !configured ? (
        viewer?.canEditSettings ? (
          <form
            className={`space-y-3 ${SETTINGS_CARD_CLASS}`}
            onSubmit={(event) => void handleConfigureRegistry(event)}
          >
            <div>
              <p className="text-sm font-medium text-fg">Organization record IDs</p>
              <p className="mt-1 text-xs text-fg-muted">
                Registered entities receive organization IDs such as REG-000001. Independent
                entities are not uploaded until you confirm registration.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="min-w-40 flex-1 text-xs text-fg-muted">
                Prefix
                <input
                  value={registryPrefix}
                  onChange={(event) => setRegistryPrefix(event.target.value.toUpperCase())}
                  className={`mt-1 font-mono ${SETTINGS_FIELD_CLASS}`}
                />
              </label>
              <label className="w-28 text-xs text-fg-muted">
                Number width
                <input
                  value={registryPadWidth}
                  onChange={(event) => setRegistryPadWidth(event.target.value)}
                  inputMode="numeric"
                  min={2}
                  max={12}
                  className={`mt-1 ${SETTINGS_FIELD_CLASS}`}
                />
              </label>
            </div>
            <button disabled={busy} className={SETTINGS_PRIMARY_BUTTON_CLASS}>
              Set up registration
            </button>
          </form>
        ) : (
          <p className={`${SETTINGS_CARD_CLASS} text-sm text-fg-muted`}>
            An organization administrator must configure the Registry before records can
            synchronize.
          </p>
        )
      ) : (
        <>
          {registry?.conflicts.length ? (
            <div
              className="space-y-3 rounded-md bg-warning/5 p-4"
              data-testid="organization-registry-conflicts"
            >
              <p className="text-sm font-medium text-fg">Conflicts need a decision</p>
              {registry.conflicts.map((conflict) => (
                <div key={conflict.id} className="rounded-md bg-bg-muted p-3 text-sm">
                  <p className="font-medium text-fg">{conflict.operation}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {toUserMessage(conflict.errorMessage, 'account.failed')}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void resolveRegistryConflict({
                        conflictId: conflict.id,
                        resolution: 'use_remote',
                      })
                    }
                    className={`mt-2 ${SETTINGS_SECONDARY_BUTTON_CLASS}`}
                  >
                    Use organization version
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <section className={`space-y-2 ${SETTINGS_CARD_CLASS}`} aria-label="Record ID namespace">
            <h4 className="text-sm font-semibold text-fg">Record IDs</h4>
            <ul className="space-y-2">
              {registry?.idSchemes.map((scheme, index) => (
                <li
                  key={String(scheme.entityKind ?? index)}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="text-fg-muted">
                    {scheme.entityKind === '*'
                      ? 'All records'
                      : String(scheme.entityKind ?? 'Records')}
                  </span>
                  <span className="font-mono text-fg">
                    {String(scheme.prefix ?? '')}
                    {typeof scheme.padWidth === 'number' ? ` · ${scheme.padWidth} digits` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <div
            className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_CARD_CLASS}`}
          >
            <div>
              <h4 className="text-sm font-semibold text-fg">Organization custody</h4>
              <p className="mt-1 text-xs text-fg-muted">
                {registry?.entities.length ?? 0} registered{' '}
                {(registry?.entities.length ?? 0) === 1 ? 'entity' : 'entities'}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => openRegistry()}
              className={SETTINGS_SECONDARY_BUTTON_CLASS}
            >
              View entities
            </button>
          </div>

          <div
            className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_CARD_CLASS}`}
          >
            <div>
              <h4 className="text-sm font-semibold text-fg">Register saved records</h4>
              <p className="mt-1 text-xs text-fg-muted">
                Choose saved records and review their schema, fields and home project before
                registering them.
              </p>
            </div>
            <button
              type="button"
              disabled={busy || registryLoading || organizationSchemas.length === 0}
              onClick={() => openRegistry(null, 'claim')}
              className={SETTINGS_PRIMARY_BUTTON_CLASS}
            >
              Choose records…
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
