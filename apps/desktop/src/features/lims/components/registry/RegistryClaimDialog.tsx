import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import { Button, Select, TextField } from '../../../../components/ui';
import type { LimsRegistrySummary, LimsRegistrySummaryPage } from '../../../../shared/lims';
import type { EntitySchemaFieldSnapshot } from '../../../../shared/entity-schema';
import { RegistryRecordFields, RegistryRecordValue } from './RegistryRecordFields';
import type {
  OrganizationRegistryClaimPreparationRequest,
  PreparedOrganizationRegistryClaim,
} from '../../../../shared/org-registry-sync';
export type { PreparedOrganizationRegistryClaim } from '../../../../shared/org-registry-sync';

interface ClaimSchema {
  id: string;
  currentRevisionId: string;
  name: string;
  baseKind: string;
  displayName: string;
  version: number | null;
  fields: EntitySchemaFieldSnapshot[];
}

export function RegistryClaimDialog({
  organizationName,
  localRecords,
  searchRecords,
  schemas,
  prepareClaim,
  onConfirm,
  onCancel,
}: {
  organizationName: string;
  localRecords: LimsRegistrySummary[];
  searchRecords?: (search: string) => Promise<LimsRegistrySummaryPage>;
  schemas: Record<string, unknown>[];
  prepareClaim: (
    request: OrganizationRegistryClaimPreparationRequest
  ) => Promise<PreparedOrganizationRegistryClaim>;
  onConfirm: (
    claims: PreparedOrganizationRegistryClaim[]
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onCancel: () => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  const parsedSchemas = useMemo(() => schemas.flatMap(parseClaimSchema), [schemas]);
  const [selectedRecords, setSelectedRecords] = useState<Map<string, LimsRegistrySummary>>(
    () => new Map()
  );
  const [search, setSearch] = useState('');
  const [searchPage, setSearchPage] = useState<LimsRegistrySummaryPage | null>(null);
  const [searching, setSearching] = useState(Boolean(searchRecords));
  const [schemaByEntity, setSchemaByEntity] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<PreparedOrganizationRegistryClaim[] | null>(null);
  const [preparedSchemas, setPreparedSchemas] = useState<Record<string, ClaimSchema>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!searchRecords) return;
    let current = true;
    setSearching(true);
    setError(null);
    void searchRecords(search.trim())
      .then((page) => {
        if (current) setSearchPage(page);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setSearchPage(null);
        setError(toUserMessage(error, 'failure.saved-records-could-not-be-loaded'));
      })
      .finally(() => {
        if (current) setSearching(false);
      });
    return () => {
      current = false;
    };
  }, [searchRecords, search]);

  const records = searchRecords ? (searchPage?.summaries ?? []) : localRecords;
  const selectedCount = selectedRecords.size;
  const searchText = search.trim().toLocaleLowerCase();
  const visibleRecords = (searching ? [] : records).filter((record) =>
    `${record.name} ${record.registryId ?? ''} ${record.kind}`
      .toLocaleLowerCase()
      .includes(searchText)
  );
  const compatibleSchemas = (record: LimsRegistrySummary) =>
    parsedSchemas.filter(
      (schema) => schema.baseKind === record.kind || schema.name === record.kind
    );

  async function reviewClaims(): Promise<void> {
    if (selectedCount === 0 || busy || searching) return;
    setBusy(true);
    setError(null);
    try {
      const claims = await Promise.all(
        [...selectedRecords.values()].map(async (record) => {
          const choices = compatibleSchemas(record);
          const selectedSchemaId = schemaByEntity[record.id] ?? choices[0]?.id;
          const schema = choices.find((candidate) => candidate.id === selectedSchemaId);
          if (!schema) throw new Error(`${record.name} needs a compatible organization schema.`);
          return prepareClaim({
            entityId: record.id,
            schemaId: schema.id,
            schemaRevisionId: schema.currentRevisionId,
          });
        })
      );
      const definitions: Record<string, ClaimSchema> = {};
      for (const claim of claims) {
        const schema = parsedSchemas.find(
          (candidate) =>
            candidate.id === claim.payload.schemaId &&
            candidate.currentRevisionId === claim.payload.schemaRevisionId
        );
        if (!schema)
          throw new Error(
            'The organization schema changed during preparation. Review these records again.'
          );
        const values = claim.payload.fields;
        if (!values || typeof values !== 'object' || Array.isArray(values))
          throw new Error(
            'The saved record fields could not be reviewed. Try preparing this record again.'
          );
        const sourceFields =
          selectedRecords.get(claim.sourceEntityId)?.schemaSnapshot?.fields ?? [];
        const additional = Object.keys(values)
          .filter(
            (key) =>
              key !== 'artifact' &&
              key !== 'sourceMetadata' &&
              !schema.fields.some((field) => field.key === key)
          )
          .map((key) => {
            const field = sourceFields.find((field) => field.key === key);
            return field
              ? { ...field, required: false }
              : {
                  key,
                  label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '),
                  type: 'text',
                };
          });
        definitions[claim.sourceEntityId] = {
          ...schema,
          fields: [...schema.fields, ...additional],
        };
      }
      setPreparedSchemas(definitions);
      setPrepared(claims);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-local-claim-preview-could-not-load'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmClaims(): Promise<void> {
    if (!prepared?.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onConfirm(prepared);
      if (!result.ok) setError(toUserMessage(result, 'operation.failed'));
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-records-could-not-be-claimed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="registry-claim-title"
        data-testid="registry-claim-dialog"
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6"
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
          <header className="border-b border-border px-5 py-4">
            <h2 id="registry-claim-title" className="text-base font-semibold text-fg">
              Register records with {organizationName}
            </h2>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Register these saved records with the organization using their existing identities and
              home projects. Nothing is sent until you confirm the reviewed fields.
            </p>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {prepared ? (
              <div className="space-y-4">
                <div className="rounded-md border border-accent/30 bg-accent/5 p-3 text-xs text-fg-muted">
                  <p className="font-medium text-fg">Fields to register</p>
                  <p className="mt-1">
                    Each record keeps its identity and home project. The organization assigns its
                    display identifier and validates these fields against the selected definition.
                  </p>
                  <p className="mt-2" data-testid="registry-claim-custody-notice">
                    {organizationName} will retain custody if you leave the organization. Creator
                    attribution and record history are preserved.
                  </p>
                </div>
                {prepared.map((claim) => (
                  <article
                    key={claim.sourceEntityId}
                    data-testid={`registry-claim-preview-${claim.sourceEntityId}`}
                    className="rounded-lg border border-border p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-fg">{String(claim.payload.name)}</p>
                      <p className="font-mono text-xs text-fg-muted">
                        {claim.sourceRegistryId ?? claim.sourceEntityId}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-fg-muted">
                      {preparedSchemas[claim.sourceEntityId]?.displayName}
                      {preparedSchemas[claim.sourceEntityId]?.version
                        ? ` · v${preparedSchemas[claim.sourceEntityId].version}`
                        : ''}
                    </p>
                    <p
                      data-testid={`registry-claim-home-${claim.sourceEntityId}`}
                      className="mt-1 text-xs text-fg-muted"
                      title={claim.homeProjectUuid}
                    >
                      Home project: {claim.homeProjectName}
                    </p>
                    <div className="mt-3">
                      <RegistryRecordFields
                        schema={{
                          schemaId: preparedSchemas[claim.sourceEntityId].id,
                          schemaRevisionId: preparedSchemas[claim.sourceEntityId].currentRevisionId,
                          name: preparedSchemas[claim.sourceEntityId].name,
                          baseKind: preparedSchemas[claim.sourceEntityId].baseKind,
                          displayName: preparedSchemas[claim.sourceEntityId].displayName,
                          fields: preparedSchemas[claim.sourceEntityId].fields,
                        }}
                        fields={claim.payload.fields as Record<string, unknown>}
                      />
                    </div>
                    {Object.entries(claim.payload.fields as Record<string, unknown>).filter(
                      ([key]) =>
                        !preparedSchemas[claim.sourceEntityId].fields.some(
                          (field) => field.key === key
                        )
                    ).length ? (
                      <details className="mt-3 text-xs text-fg-muted">
                        <summary>Additional saved metadata</summary>
                        <dl className="mt-2 space-y-2">
                          {Object.entries(claim.payload.fields as Record<string, unknown>)
                            .filter(
                              ([key]) =>
                                !preparedSchemas[claim.sourceEntityId].fields.some(
                                  (field) => field.key === key
                                )
                            )
                            .map(([key, value]) => (
                              <div key={key}>
                                <dt className="font-medium">
                                  {key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}
                                </dt>
                                <dd className="mt-1 text-fg">
                                  <RegistryRecordValue type="text" value={value} />
                                </dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="block pb-2 text-xs text-fg-muted">
                  Find saved records
                  <TextField
                    type="search"
                    value={search}
                    placeholder="Search by name or record ID"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                {searching ? (
                  <p role="status" className="py-8 text-center text-sm text-fg-muted">
                    Searching saved records…
                  </p>
                ) : records.length === 0 && !searchText ? (
                  <p className="py-10 text-center text-sm text-fg-muted">
                    No saved records are available.
                  </p>
                ) : (
                  visibleRecords.map((record) => {
                    const choices = compatibleSchemas(record);
                    const checked = selectedRecords.has(record.id);
                    const selectedSchemaId = schemaByEntity[record.id] ?? choices[0]?.id ?? '';
                    return (
                      <div
                        key={record.id}
                        data-testid={`registry-claim-record-${record.id}`}
                        className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)]"
                      >
                        <label className="flex min-w-0 items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={record.archived || choices.length === 0}
                            onChange={(event) => {
                              setSelectedRecords((current) => {
                                const next = new Map(current);
                                if (event.target.checked) next.set(record.id, record);
                                else next.delete(record.id);
                                return next;
                              });
                            }}
                            className="mt-0.5 h-4 w-4 accent-accent"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-fg">
                              {record.name}
                            </span>
                            <span className="mt-0.5 block font-mono text-[11px] text-fg-muted">
                              Local · {record.registryId ?? record.id} · {record.kind}
                            </span>
                            {record.archived ? (
                              <span className="mt-1 block text-xs text-warning">
                                Restore this local record before claiming it.
                              </span>
                            ) : choices.length === 0 ? (
                              <span className="mt-1 block text-xs text-warning">
                                No compatible organization schema for {record.kind}.
                              </span>
                            ) : null}
                          </span>
                        </label>
                        {choices.length > 0 ? (
                          <label className="text-[11px] text-fg-muted">
                            Organization schema
                            <Select
                              ariaLabel={`Organization schema for ${record.name}`}
                              value={selectedSchemaId}
                              disabled={!checked}
                              onValueChange={(value) =>
                                setSchemaByEntity((current) => ({
                                  ...current,
                                  [record.id]: value,
                                }))
                              }
                              options={choices.map((schema) => ({
                                value: schema.id,
                                label: `${schema.displayName}${schema.version === null ? '' : ` v${schema.version}`}`,
                              }))}
                            />
                          </label>
                        ) : null}
                      </div>
                    );
                  })
                )}
                {!searching && visibleRecords.length === 0 && searchText ? (
                  <p className="py-8 text-center text-sm text-fg-muted">
                    No saved records match your search.
                  </p>
                ) : null}
                {!searching && searchPage && searchPage.totalCount > records.length ? (
                  <p className="text-xs text-fg-muted">
                    Showing {records.length} of {searchPage.totalCount} saved records. Search by
                    name or record ID to find another record.
                  </p>
                ) : null}
              </div>
            )}
            {error ? (
              <p className="mt-4 text-sm text-error">{toUserMessage(error, 'operation.failed')}</p>
            ) : null}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
            <Button
              type="button"
              disabled={busy}
              onClick={prepared ? () => setPrepared(null) : onCancel}
            >
              {prepared ? 'Back' : 'Cancel'}
            </Button>
            {prepared ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void confirmClaims()}
                variant="primary"
              >
                {busy
                  ? 'Registering…'
                  : `Confirm and register ${prepared.length} ${prepared.length === 1 ? 'record' : 'records'}`}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={busy || searching || selectedCount === 0}
                onClick={() => void reviewClaims()}
                variant="primary"
              >
                {busy
                  ? 'Loading preview…'
                  : `Review ${selectedCount} ${selectedCount === 1 ? 'record' : 'records'}`}
              </Button>
            )}
          </footer>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}

function parseClaimSchema(raw: Record<string, unknown>): ClaimSchema[] {
  if (
    typeof raw.id !== 'string' ||
    typeof raw.currentRevisionId !== 'string' ||
    typeof raw.name !== 'string'
  ) {
    return [];
  }
  return [
    {
      id: raw.id,
      currentRevisionId: raw.currentRevisionId,
      name: raw.name,
      baseKind: typeof raw.baseKind === 'string' ? raw.baseKind : raw.name,
      displayName: typeof raw.displayName === 'string' ? raw.displayName : raw.name,
      version: typeof raw.version === 'number' ? raw.version : null,
      fields: Array.isArray(raw.fields)
        ? raw.fields
            .filter(
              (field): field is EntitySchemaFieldSnapshot =>
                field !== null &&
                typeof field === 'object' &&
                typeof field.key === 'string' &&
                typeof field.label === 'string' &&
                typeof field.type === 'string'
            )
            .map((field) => ({ ...field }))
        : [],
    },
  ];
}
