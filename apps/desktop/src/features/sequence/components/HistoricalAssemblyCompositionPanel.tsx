import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SequencePackageHistoryView } from '../hooks/useSequencePackageHistory';
import {
  type HistoricalAssemblyComponent,
  type HistoricalAssemblyCatalog,
  type HistoricalAssemblySelection,
  type HistoricalAssemblyTarget,
} from '../../assembly/public/historical-component-composition';
import {
  inspectHistoricalAssemblyStageTarget,
  listHistoricalAssemblyComponents,
  previewHistoricalAssemblyComponentStage,
  type HistoricalAssemblyStageTarget,
  type StageHistoricalAssemblyComponentsInput,
} from '../../assembly/public/historical-component-workflow';
import {
  acceptedAssemblyVersionFromSidecar,
  parseAcceptedAssemblyPayload,
} from '../../assembly/public/accepted-reopen';

type ChoiceKind = HistoricalAssemblyComponent['kind'];
type ChoiceRow = {
  id: number;
  kind: ChoiceKind;
  targetKey: string;
  sourceKey: string;
};

export type HistoricalAssemblyCompositionController = {
  isDirty: boolean;
  stage(input: StageHistoricalAssemblyComponentsInput): Promise<void>;
};

function savedAssemblyId(
  value: Record<string, unknown> | null,
  packageRoot: string
): string | null {
  if (!value) return null;
  try {
    return acceptedAssemblyVersionFromSidecar(parseAcceptedAssemblyPayload(value, { packageRoot }))
      .id;
  } catch {
    return null;
  }
}

function key(value: unknown): string {
  return JSON.stringify(value);
}

function sourceKey(source: HistoricalAssemblyComponent): string {
  return key([source.acceptedAssemblyVersionId, source.componentId, source.componentDigest]);
}

function targetLabel(target: HistoricalAssemblyTarget): string {
  if (target.kind === 'region') return `Region ${target.regionId}`;
  if (target.kind === 'primer-pair') return `Primer pair for ${target.regionId}`;
  return `${target.leftRegionId} → ${target.rightRegionId}`;
}

function sourceLabel(source: HistoricalAssemblyComponent): string {
  const location =
    source.kind === 'region' || source.kind === 'primer-pair'
      ? source.regionId
      : source.kind === 'spacer'
        ? `${source.spacerId} · ${source.leftRegionId} → ${source.rightRegionId}`
        : `${source.leftRegionId} → ${source.rightRegionId}`;
  return `${source.acceptedAssemblyVersionId} · ${location}`;
}

const KIND_LABELS: Record<ChoiceKind, string> = {
  region: 'Region',
  spacer: 'Spacer',
  join: 'Join',
  'primer-pair': 'Primer pair',
};

export function HistoricalAssemblyCompositionPanel({
  index,
  controller,
}: {
  index: NonNullable<SequencePackageHistoryView['index']>;
  controller: HistoricalAssemblyCompositionController;
}) {
  const acceptedIds = useMemo(() => {
    const idFor = (value: Record<string, unknown> | null) =>
      savedAssemblyId(value, index.packageRoot);
    const current = idFor(index.document.assembly?.accepted ?? null);
    const fromRevisions = index.document.versionHistory.revisions.flatMap((revision) => {
      const id = idFor(revision.state.acceptedAssembly);
      return id ? [id] : [];
    });
    const fromLegacy = (index.document.assembly?.history ?? []).flatMap((value) => {
      const id = idFor(value);
      return id ? [id] : [];
    });
    return {
      current,
      all: [...new Set([...(current ? [current] : []), ...fromRevisions, ...fromLegacy])],
    };
  }, [index]);
  const [baseId, setBaseId] = useState<string>(
    acceptedIds.current ?? acceptedIds.all[acceptedIds.all.length - 1] ?? ''
  );
  const [catalog, setCatalog] = useState<HistoricalAssemblyCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [target, setTarget] = useState<HistoricalAssemblyStageTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);
  const [refreshSerial, setRefreshSerial] = useState(0);
  const [rows, setRows] = useState<ChoiceRow[]>([]);
  const rowSerial = useRef(0);
  const [preview, setPreview] = useState<
    | { status: 'ready'; request: StageHistoricalAssemblyComponentsInput }
    | { status: 'blocked'; reason: string }
    | null
  >(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const previewSerial = useRef(0);

  useEffect(() => {
    setBaseId(acceptedIds.current ?? acceptedIds.all[acceptedIds.all.length - 1] ?? '');
    setRows([]);
    setPreview(null);
  }, [acceptedIds]);
  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCatalogError(null);
    const referenceId = acceptedIds.current ?? acceptedIds.all[acceptedIds.all.length - 1];
    if (!referenceId)
      return () => {
        active = false;
      };
    setCatalogBusy(true);
    void listHistoricalAssemblyComponents({
      constructId: index.document.id,
      referenceAcceptedAssemblyVersionId: referenceId,
    })
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((error) => {
        if (active) setCatalogError(toUserMessage(error, 'tracks.loadFailed'));
      })
      .finally(() => {
        if (active) setCatalogBusy(false);
      });
    return () => {
      active = false;
    };
  }, [acceptedIds, index.document.id, refreshSerial]);
  useEffect(() => {
    let active = true;
    setTarget(null);
    setTargetError(null);
    setPreview(null);
    previewSerial.current += 1;
    if (!baseId)
      return () => {
        active = false;
      };
    setTargetBusy(true);
    void inspectHistoricalAssemblyStageTarget({
      constructId: index.document.id,
      baseAcceptedAssemblyVersionId: baseId,
    })
      .then((value) => {
        if (active) setTarget(value);
      })
      .catch((error) => {
        if (active) setTargetError(toUserMessage(error, 'tracks.loadFailed'));
      })
      .finally(() => {
        if (active) setTargetBusy(false);
      });
    return () => {
      active = false;
    };
  }, [baseId, index.document.id, refreshSerial]);
  useEffect(() => {
    previewSerial.current += 1;
    setPreview(null);
  }, [controller.isDirty]);

  const versionIds = useMemo(
    () => [
      ...new Set([
        ...acceptedIds.all,
        ...(catalog?.components.map((item) => item.acceptedAssemblyVersionId) ?? []),
      ]),
    ],
    [acceptedIds.all, catalog]
  );
  const targetByKey = useMemo(
    () => new Map((target?.targets ?? []).map((item) => [key(item), item])),
    [target]
  );
  const sourceByKey = useMemo(
    () => new Map((catalog?.components ?? []).map((item) => [sourceKey(item), item])),
    [catalog]
  );
  const editRow = (id: number, update: Partial<ChoiceRow>) => {
    previewSerial.current += 1;
    setPreview(null);
    setStageError(null);
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...update } : row)));
  };
  const selected = (): HistoricalAssemblySelection[] | null => {
    if (rows.length === 0) return null;
    const selections: HistoricalAssemblySelection[] = [];
    for (const row of rows) {
      const source = sourceByKey.get(row.sourceKey);
      const selectedTarget = targetByKey.get(row.targetKey);
      if (
        !source ||
        !selectedTarget ||
        source.kind !== row.kind ||
        selectedTarget.kind !== row.kind
      )
        return null;
      selections.push({ source, target: selectedTarget });
    }
    return selections;
  };
  const previewStage = async () => {
    const selections = selected();
    if (!target || !selections) return;
    const serial = ++previewSerial.current;
    setPreviewBusy(true);
    setPreview(null);
    setStageError(null);
    const request: StageHistoricalAssemblyComponentsInput = {
      constructId: index.document.id,
      baseAcceptedAssemblyVersionId: baseId,
      expectedDesignVersion: target.designVersion,
      expectedDraftDigest: target.draftDigest,
      selections,
      reopenIdempotencyKey: globalThis.crypto.randomUUID(),
    };
    try {
      const result = await previewHistoricalAssemblyComponentStage(request);
      if (serial !== previewSerial.current) return;
      setPreview(
        result.status === 'ready'
          ? { status: 'ready', request }
          : { status: 'blocked', reason: result.reason }
      );
    } catch (error) {
      if (serial === previewSerial.current) {
        setPreview({
          status: 'blocked',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (serial === previewSerial.current) setPreviewBusy(false);
    }
  };
  const stage = async () => {
    if (preview?.status !== 'ready' || controller.isDirty || stageBusy) return;
    setStageBusy(true);
    setStageError(null);
    try {
      await controller.stage(preview.request);
      previewSerial.current += 1;
      setPreview(null);
      setRows([]);
      setRefreshSerial((value) => value + 1);
    } catch (error) {
      setStageError(toUserMessage(error, 'tracks.loadFailed'));
      previewSerial.current += 1;
      setPreview(null);
      setRefreshSerial((value) => value + 1);
    } finally {
      setStageBusy(false);
    }
  };

  return (
    <section className="border-t border-border px-4 py-3" data-testid="history-compose-assembly">
      <div className="font-semibold text-fg">Compose assembly working copy</div>
      <p className="mt-1 text-xs text-fg-muted">
        Pick saved parts and exact target slots. Staging edits the package-owned working copy; it
        does not restore DNA or accept a new recipe. Validate and finalize in Assembly.
      </p>
      {catalogBusy && <p className="mt-2 text-xs text-fg-muted">Loading saved components…</p>}
      {catalogError && (
        <p role="alert" className="mt-2 text-xs text-error">
          {toUserMessage(catalogError, 'tracks.loadFailed')}
        </p>
      )}
      {catalog?.unavailable.map((item) => (
        <p key={item.acceptedAssemblyVersionId} role="alert" className="mt-2 text-xs text-error">
          {item.acceptedAssemblyVersionId}: {item.reason}
        </p>
      ))}
      {versionIds.length > 0 && (
        <label className="mt-3 block text-xs text-fg">
          Working-copy base
          <span className="block min-w-0 mt-1 w-full">
            <MenuNativeSelect
              density="compact"
              aria-label="Assembly working-copy base"
              value={baseId}
              disabled={stageBusy}
              onChange={(event) => {
                setBaseId(event.target.value);
                setStageError(null);
              }}
            >
              {versionIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {id === acceptedIds.current ? ' · current saved assembly' : ''}
                </option>
              ))}
            </MenuNativeSelect>
          </span>
        </label>
      )}
      {targetBusy && <p className="mt-2 text-xs text-fg-muted">Inspecting assembly copy…</p>}
      {targetError && (
        <p role="alert" className="mt-2 text-xs text-error">
          {toUserMessage(targetError, 'tracks.loadFailed')}
        </p>
      )}
      {target && (
        <p className="mt-2 text-xs text-fg-muted" data-testid="assembly-stage-target">
          {target.exists ? 'Continue existing copy' : 'Start one package-owned copy'} from{' '}
          {target.baseAcceptedAssemblyVersionId} · draft version {target.designVersion}
        </p>
      )}
      {controller.isDirty && (
        <p role="alert" className="mt-2 text-xs text-error">
          Save or discard unsaved sequence edits before staging. Preview remains read-only.
        </p>
      )}
      {target && catalog && (
        <>
          <div className="mt-3 space-y-3">
            {rows.map((row) => {
              const availableTargets = target.targets.filter((item) => item.kind === row.kind);
              const availableSources = catalog.components.filter((item) => item.kind === row.kind);
              return (
                <div
                  key={row.id}
                  className="rounded border border-border p-2 text-xs"
                  data-testid={`assembly-choice-${row.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <label>
                      Piece
                      <span className="inline-block min-w-0 ml-2">
                        <MenuNativeSelect
                          density="compact"
                          aria-label={`Piece kind ${row.id}`}
                          value={row.kind}
                          onChange={(event) =>
                            editRow(row.id, {
                              kind: event.target.value as ChoiceKind,
                              targetKey: '',
                              sourceKey: '',
                            })
                          }
                        >
                          {(Object.keys(KIND_LABELS) as ChoiceKind[]).map((kind) => (
                            <option key={kind} value={kind}>
                              {KIND_LABELS[kind]}
                            </option>
                          ))}
                        </MenuNativeSelect>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="text-error"
                      onClick={() => {
                        previewSerial.current += 1;
                        setRows((current) => current.filter((item) => item.id !== row.id));
                        setPreview(null);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <label className="mt-2 block">
                    Target slot
                    <span className="block min-w-0 mt-1 w-full">
                      <MenuNativeSelect
                        density="compact"
                        aria-label={`Target slot ${row.id}`}
                        value={row.targetKey}
                        onChange={(event) => editRow(row.id, { targetKey: event.target.value })}
                      >
                        <option value="">Choose a target</option>
                        {availableTargets.map((item) => (
                          <option key={key(item)} value={key(item)}>
                            {targetLabel(item)}
                          </option>
                        ))}
                      </MenuNativeSelect>
                    </span>
                  </label>
                  <label className="mt-2 block">
                    Saved source
                    <span className="block min-w-0 mt-1 w-full">
                      <MenuNativeSelect
                        density="compact"
                        aria-label={`Saved source ${row.id}`}
                        value={row.sourceKey}
                        onChange={(event) => editRow(row.id, { sourceKey: event.target.value })}
                      >
                        <option value="">Choose a saved piece</option>
                        {availableSources.map((item) => (
                          <option key={sourceKey(item)} value={sourceKey(item)}>
                            {sourceLabel(item)}
                          </option>
                        ))}
                      </MenuNativeSelect>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-3 rounded border border-border px-2 py-1 text-xs"
            onClick={() => {
              previewSerial.current += 1;
              setPreview(null);
              setRows((current) => [
                ...current,
                {
                  id: ++rowSerial.current,
                  kind: 'region',
                  targetKey: '',
                  sourceKey: '',
                },
              ]);
            }}
          >
            Add historical piece
          </button>
          {rows.length > 0 && !selected() && (
            <p className="mt-2 text-xs text-fg-muted">
              Choose a target and saved source for every piece.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={previewBusy || stageBusy || !selected()}
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
              onClick={() => void previewStage()}
            >
              {previewBusy ? 'Previewing…' : 'Preview composition'}
            </button>
            {preview?.status === 'ready' && (
              <button
                type="button"
                disabled={stageBusy || controller.isDirty}
                className="rounded border border-accent bg-accent px-2 py-1 text-xs text-accent-fg disabled:opacity-50"
                onClick={() => void stage()}
              >
                {stageBusy ? 'Staging…' : 'Stage in Assembly'}
              </button>
            )}
          </div>
          {preview?.status === 'ready' && (
            <p className="mt-2 text-xs text-fg-muted" data-testid="assembly-composition-ready">
              Ready to stage {preview.request.selections.length} saved piece
              {preview.request.selections.length === 1 ? '' : 's'} in this copy. No accepted
              assembly or sequence version is created yet.
            </p>
          )}
          {preview?.status === 'blocked' && (
            <p
              role="alert"
              className="mt-2 text-xs text-error"
              data-testid="assembly-composition-blocked"
            >
              {preview.reason}
            </p>
          )}
          {stageError && (
            <p role="alert" className="mt-2 text-xs text-error">
              {toUserMessage(stageError, 'tracks.loadFailed')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
