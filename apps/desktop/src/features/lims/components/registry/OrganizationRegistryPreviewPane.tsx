import { organizationRegistryUnavailableMessage } from '../../../../shared/org-registry-sync';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import type { OrganizationRegistryRecordDetails } from '../../../../shared/org-registry-sync';
import { isPortableEntitySchemaRevisionSnapshot } from '../../../../shared/entity-schema';
import { otherEntityMetadata } from '../../../../shared/entity-record';
import { formatLimsRelationshipType } from '../../../../shared/lims';
import { RegistryRecordFields, RegistryRecordValue } from './RegistryRecordFields';
import type { RegistryProjectBinding } from './RegistryScopeSurface';

export function OrganizationRegistryPreviewPane({
  details,
  loading,
  error,
  opening,
  projects,
  entities,
  onOpen,
}: {
  details: OrganizationRegistryRecordDetails | null;
  loading: boolean;
  error: string | null;
  opening: boolean;
  projects: RegistryProjectBinding[];
  entities: Record<string, unknown>[];
  onOpen: () => void;
}) {
  if (!details)
    return (
      <aside className="min-w-0 overflow-y-auto border-l border-border p-4">
        <p role={error ? 'alert' : 'status'} className="text-sm text-fg-muted">
          {error != null
            ? toUserMessage(error, 'failure.select-a-record-to-view-details')
            : loading
              ? userMessage('notice.loading-details')
              : userMessage('failure.select-a-record-to-view-details')}
        </p>
      </aside>
    );
  const { entity, schema, schemaRevision, local } = details;
  const snapshot = {
    schemaId: entity.schemaId,
    schemaRevisionId: entity.schemaRevisionId,
    name: schemaRevision.name ?? schema.name,
    displayName: schemaRevision.displayName ?? schema.displayName ?? schema.name,
    baseKind: schemaRevision.baseKind ?? schema.baseKind,
    fields: schemaRevision.fields,
    version: schemaRevision.version,
  };
  const pinned =
    isPortableEntitySchemaRevisionSnapshot(snapshot) && typeof snapshot.version === 'number'
      ? { ...snapshot, version: snapshot.version }
      : null;
  const fields =
    entity.fields && typeof entity.fields === 'object' && !Array.isArray(entity.fields)
      ? (entity.fields as Record<string, unknown>)
      : {};
  const metadata = pinned
    ? otherEntityMetadata(pinned, fields)
    : Object.entries(fields).map(([key, value]) => ({ key, label: key, value }));
  const projectName = (id: unknown) =>
    projects.find((project) => project.remoteWorkspaceId === id)?.displayName ??
    (typeof id === 'string' ? `Project ${id}` : 'Unavailable project');
  const recordName = (id: unknown) => entities.find((record) => record.id === id)?.name ?? id;
  return (
    <aside
      data-testid="lims-registry-organization-preview"
      data-entity-id={entity.id}
      data-schema-revision-id={entity.schemaRevisionId}
      className="min-w-0 space-y-4 overflow-y-auto border-l border-border p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-semibold text-fg">
            {String(entity.name ?? 'Record')}
          </h2>
          <p className="mt-1 font-mono text-xs text-accent">
            {String(entity.registryId ?? entity.id)}
          </p>
        </div>
        {local.status === 'available' ? (
          <button
            type="button"
            data-testid="lims-registry-organization-preview-open"
            disabled={loading || opening}
            onClick={onOpen}
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-fg disabled:opacity-50"
          >
            {opening ? 'Opening…' : 'Open'}
          </button>
        ) : null}
      </header>
      <div className="space-y-1 text-xs text-fg-muted">
        <p>Home project: {projectName(entity.homeWorkspaceId)}</p>
        <p>
          {String(snapshot.displayName ?? 'Record definition')} · version{' '}
          {String(snapshot.version ?? 'unavailable')}
        </p>
        {entity.archivedAt != null ? <p>Archived</p> : null}
        <p data-testid="lims-registry-organization-availability">
          {local.status === 'available'
            ? 'Saved document available on this device.'
            : organizationRegistryUnavailableMessage(local)}
        </p>
        {local.status === 'available' && local.summary.name !== entity.name ? (
          <p>Local document: {local.summary.name}</p>
        ) : null}
        <p>Showing the last synchronized organization record.</p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-error">
          {toUserMessage(error, 'account.failed')}
        </p>
      ) : null}
      {pinned ? (
        <RegistryRecordFields schema={pinned} fields={fields} />
      ) : (
        <p className="text-xs text-warning">
          This saved definition cannot be displayed by this version of the app.
        </p>
      )}
      {metadata.length ? (
        <details>
          <summary className="text-xs font-medium text-fg">Other metadata</summary>
          <dl className="space-y-2 pt-2">
            {metadata.map((entry) => (
              <div key={entry.key}>
                <dt className="text-xs text-fg-muted">{entry.label}</dt>
                <dd className="break-words text-sm">
                  <RegistryRecordValue type="text" value={entry.value} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <section className="space-y-2" aria-label="Relationships">
        <h3 className="text-xs font-semibold text-fg">Relationships</h3>
        {details.relationships.length ? (
          <ul className="space-y-2 text-xs text-fg-muted">
            {details.relationships.map((link) => (
              <li key={String(link.id)}>
                {String(recordName(link.fromEntityId))} ·{' '}
                {formatLimsRelationshipType(String(link.type))} ·{' '}
                {String(recordName(link.toEntityId))}
                {link.payload &&
                typeof link.payload === 'object' &&
                Object.keys(link.payload).length ? (
                  <RegistryRecordValue type="text" value={link.payload} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">No accessible relationships.</p>
        )}
      </section>
      <section className="space-y-2" aria-label="Project references">
        <h3 className="text-xs font-semibold text-fg">Project references</h3>
        {details.placements.length ? (
          <ul className="space-y-2 text-xs text-fg-muted">
            {details.placements.map((placement) => (
              <li key={String(placement.id)}>
                {projectName(placement.workspaceId)}
                {typeof placement.path === 'string' ? ` · ${placement.path}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-muted">No project references.</p>
        )}
      </section>
    </aside>
  );
}
