import { toUserMessage } from '@waypoint/user-messages';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../../shared/entity-schema';
import type { OrganizationRegistrySavedRecordResolutionRequest } from '../../../../shared/org-registry-sync';
import { otherEntityMetadata } from '../../../../shared/entity-record';
import { RegistryRecordFields, RegistryRecordValue } from './RegistryRecordFields';
import type { useOrganizationRecordSync } from './useOrganizationRecordSync';

export function SavedRecordOrganizationStatus({
  organizationSync,
  schema,
  testIdPrefix,
  resolutionBlocked,
  applyingResolution,
  saving,
  hasDraft,
  resolutionAccessMessage,
  resolveOrganizationVersion,
}: {
  organizationSync: ReturnType<typeof useOrganizationRecordSync>;
  schema?: ProjectableEntitySchemaRevisionSnapshot;
  testIdPrefix: string;
  resolutionBlocked: boolean;
  applyingResolution: boolean;
  saving: boolean;
  hasDraft: boolean;
  resolutionAccessMessage: string | null;
  resolveOrganizationVersion: (
    choice?: OrganizationRegistrySavedRecordResolutionRequest['choice']
  ) => Promise<void>;
}) {
  return (
    <>
      {organizationSync.status ? (
        <div
          data-testid={`${testIdPrefix}-organization-sync`}
          data-status={organizationSync.status.status}
          className="space-y-2 rounded border border-border p-3 text-sm"
        >
          <p role="status">
            {organizationSync.status.status === 'synced'
              ? `Organization Registry synchronized · revision ${organizationSync.status.baseRevision}`
              : organizationSync.status.status === 'remote_changes'
                ? 'The organization Registry has changes to review.'
                : organizationSync.status.status === 'claim_pending'
                  ? 'Organization registration is pending.'
                  : organizationSync.status.status === 'publication_pending'
                    ? 'The local save must finish before it can synchronize.'
                    : organizationSync.status.status === 'conflict'
                      ? 'The saved record and organization version have conflicting changes.'
                      : organizationSync.status.status === 'failed'
                        ? 'The saved record could not synchronize with the organization.'
                        : 'Saved changes are waiting to synchronize with the organization.'}
          </p>
          {organizationSync.status.status === 'conflict' ||
          organizationSync.status.status === 'remote_changes' ||
          organizationSync.pendingResolution ? (
            <div data-testid={`${testIdPrefix}-organization-conflict`} className="space-y-3">
              <p className="text-warning">
                Both versions are retained. Review the changes before replacing either version.
              </p>
              {!organizationSync.pendingResolution && organizationSync.review && schema ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ['Saved on this device', organizationSync.review.local],
                      [
                        `Organization · revision ${organizationSync.review.organizationRevision}`,
                        organizationSync.review.organization,
                      ],
                    ] as const
                  ).map(([label, version]) => (
                    <section key={label} className="space-y-2">
                      <h2 className="font-medium">{label}</h2>
                      <p>
                        {version.name} · {version.archived ? 'Archived' : 'Active'}
                      </p>
                      <RegistryRecordFields schema={schema} fields={version.fields} />
                      {otherEntityMetadata(schema, version.fields)
                        .filter((entry) => entry.key !== 'artifact')
                        .map((entry) => (
                          <div key={entry.key} className="text-xs">
                            <span>{entry.key}: </span>
                            <RegistryRecordValue type="text" value={entry.value} />
                          </div>
                        ))}
                    </section>
                  ))}
                </div>
              ) : null}
              {organizationSync.pendingResolution ? (
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-retry-organization-resolution`}
                  disabled={resolutionBlocked}
                  className="rounded border border-border px-3 py-1.5 disabled:opacity-50"
                  onClick={() => void resolveOrganizationVersion()}
                >
                  {applyingResolution ? 'Applying change…' : 'Retry approved change'}
                </button>
              ) : organizationSync.review ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid={`${testIdPrefix}-use-organization`}
                    disabled={resolutionBlocked}
                    className="rounded border border-border px-3 py-1.5 disabled:opacity-50"
                    onClick={() => void resolveOrganizationVersion('use_remote')}
                  >
                    Use organization version
                  </button>
                  <button
                    type="button"
                    data-testid={`${testIdPrefix}-keep-saved`}
                    disabled={resolutionBlocked}
                    className="rounded border border-border px-3 py-1.5 disabled:opacity-50"
                    onClick={() => void resolveOrganizationVersion('keep_saved')}
                  >
                    Keep saved version
                  </button>
                </div>
              ) : null}
              {hasDraft ? (
                <p>Save or discard your local edits before choosing a version.</p>
              ) : resolutionAccessMessage ? (
                <p>{resolutionAccessMessage}</p>
              ) : null}
            </div>
          ) : null}
          {organizationSync.status.message ? (
            <p>{toUserMessage(organizationSync.status.message, 'account.failed')}</p>
          ) : null}
          <button
            type="button"
            data-testid={`${testIdPrefix}-organization-sync-now`}
            disabled={
              organizationSync.busy ||
              saving ||
              applyingResolution ||
              Boolean(organizationSync.pendingResolution)
            }
            className="rounded border border-border px-3 py-1.5"
            onClick={() => void organizationSync.synchronize()}
          >
            {organizationSync.busy ? 'Synchronizing…' : 'Sync organization Registry'}
          </button>
        </div>
      ) : null}
      {organizationSync.error ? (
        <p role="status" className="text-sm text-warning">
          {toUserMessage(organizationSync.error, 'account.failed')}
        </p>
      ) : null}
    </>
  );
}
