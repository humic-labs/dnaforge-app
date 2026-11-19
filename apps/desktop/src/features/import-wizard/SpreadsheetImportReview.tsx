import { MenuNativeSelect } from '@waypoint/ui-components';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { toUserMessage } from '@waypoint/user-messages';
import { Button } from '../../components/ui';
import { platform } from '../../platform';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  listImportableSheets,
  type LimsImportPlan,
  type LimsSchemaDefinitionView,
} from '../../shared/lims';
import type { ImportItem, SpreadsheetImport } from '../workspace-loader/public/import-wizard-state';
import { importItemSourcePath } from '../workspace-loader/public/import-wizard-state';
import { getExtension } from '../../utils/fileTypes';
import {
  acceptLimsImportReviewRecords,
  cancelLimsImportReview,
  executeLimsImportReview,
  mapLimsImportReview,
  prepareLimsImportReview,
} from '../lims/public/import-review-client';
import {
  computeImportPlanView,
  LimsImportColumnsPane,
} from '../lims/public/components/import-record-review';
import { getLimsSchemas } from '../lims/public/operations';

interface Props {
  item: ImportItem;
  selected: boolean;
  submitted?: RefObject<boolean>;
  onChange(value: SpreadsheetImport): void;
}

export function SpreadsheetImportReview({ item, selected, submitted, onChange }: Props) {
  const records = item.spreadsheetImport?.kind === 'records';
  const [plan, setPlan] = useState<LimsImportPlan | null>(null);
  const [schemas, setSchemas] = useState<LimsSchemaDefinitionView[]>([]);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const currentPlan = useRef<LimsImportPlan | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const currentSelected = useRef(selected);
  currentSelected.current = selected;
  const kind = plan?.forcedKind ?? plan?.records[0]?.entityDraft.kind ?? '';
  const schema = schemas.find((schema) => schema.entityKind === kind);
  const view = plan ? computeImportPlanView(plan, [], undefined, schema) : null;
  const choices = new Map(
    LIMS_BUILTIN_ENTITY_SCHEMAS.filter((schema) => schema.kind === 'entity').map((schema) => [
      schema.name,
      schema.displayName,
    ])
  );
  for (const schema of schemas) choices.set(schema.entityKind, schema.displayName);

  const release = (previous: LimsImportPlan | null) => {
    if (!previous) return;
    void pending.current
      .catch(() => undefined)
      .then(() => cancelLimsImportReview(previous))
      .catch(() => undefined);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (!submitted?.current || !currentSelected.current) release(currentPlan.current);
    };
  }, [submitted]);

  const publish = (next: LimsImportPlan) => {
    if (!next.review)
      throw new Error('Reopen the spreadsheet to prepare its native import review.');
    currentPlan.current = next;
    setPlan(next);
    const nextKind = next.forcedKind ?? next.records[0]?.entityDraft.kind;
    const nextSchema = schemas.find((schema) => schema.entityKind === nextKind);
    const nextView = computeImportPlanView(next, [], undefined, nextSchema);
    onChange({
      kind: 'records',
      phase: 'ready',
      review: next.review,
      count: nextView.acceptedCount,
      canApply: nextView.canApply,
      entityKind: nextKind,
    });
  };

  const fail = (error: unknown) =>
    onChange({
      kind: 'records',
      phase: 'failed',
      review: currentPlan.current?.review,
      count: 0,
      canApply: false,
      error: toUserMessage(error, 'registry.importFailed'),
    });

  const keepFile = () => {
    generation.current += 1;
    const previous = currentPlan.current;
    currentPlan.current = null;
    setPlan(null);
    setBusy(false);
    onChange({ kind: 'file' });
    release(previous);
  };

  const createRecords = () => {
    if (
      busy ||
      (records &&
        plan &&
        item.spreadsheetImport?.kind === 'records' &&
        item.spreadsheetImport.phase !== 'failed')
    )
      return;
    release(currentPlan.current);
    currentPlan.current = null;
    setPlan(null);
    const attempt = ++generation.current;
    setBusy(true);
    onChange({ kind: 'records', phase: 'preparing', count: 0, canApply: false });
    const operation = async () => {
      try {
        const sourcePath = importItemSourcePath(item);
        const fileName = sourcePath.split(/[\\/]/).pop() ?? item.name;
        const definitions = await getLimsSchemas();
        const extension = getExtension(fileName);
        const workbook = extension === 'xls' || extension === 'xlsx';
        const source = workbook
          ? await platform()
              .fs.readFile(sourcePath)
              .then((bytes) => ({
                arrayBuffer: bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength
                ) as ArrayBuffer,
              }))
          : { text: await platform().fs.readTextFile(sourcePath) };
        const next = await prepareLimsImportReview({ fileName, sourcePath, ...source });
        if (!mounted.current || generation.current !== attempt) {
          await cancelLimsImportReview(next);
          return;
        }
        setSchemas(definitions);
        publish(next);
      } catch (error) {
        if (mounted.current && generation.current === attempt) fail(error);
      } finally {
        if (mounted.current && generation.current === attempt) setBusy(false);
      }
    };
    pending.current = operation();
  };

  const changePlan = (change: (current: LimsImportPlan) => Promise<LimsImportPlan>) => {
    if (busy || !currentPlan.current) return;
    const previous = currentPlan.current;
    const attempt = generation.current;
    setBusy(true);
    onChange({
      kind: 'records',
      phase: 'preparing',
      review: previous.review,
      count: 0,
      canApply: false,
    });
    const operation = async () => {
      try {
        const next = await change(previous);
        if (!mounted.current || generation.current !== attempt) {
          await cancelLimsImportReview(next);
          return;
        }
        publish(next);
      } catch (error) {
        if (mounted.current && generation.current === attempt) fail(error);
      } finally {
        if (mounted.current && generation.current === attempt) setBusy(false);
      }
    };
    pending.current = operation();
  };

  const sheets = listImportableSheets(plan?.sheetDispositions ?? []);
  return (
    <div className="mt-2 space-y-3" data-testid="spreadsheet-import-choice">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={records ? 'secondary' : 'primary'}
          aria-pressed={!records}
          onClick={keepFile}
        >
          Keep spreadsheet
        </Button>
        <Button
          type="button"
          variant={records ? 'primary' : 'secondary'}
          aria-pressed={records}
          disabled={busy}
          onClick={createRecords}
        >
          Create records
        </Button>
      </div>
      {!records ? (
        <p className="text-xs text-fg-muted">Keeps the original spreadsheet in this location.</p>
      ) : (
        <div className="space-y-3" data-testid="spreadsheet-record-review">
          {busy && (
            <p role="status" className="text-xs text-fg-muted">
              Preparing records…
            </p>
          )}
          {item.spreadsheetImport?.kind === 'records' && item.spreadsheetImport.error && (
            <p role="alert" className="text-xs text-warning">
              {toUserMessage(item.spreadsheetImport.error, 'registry.importFailed')}
            </p>
          )}
          {plan && view && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  Record type
                  <span className="block min-w-0 w-full">
                    <MenuNativeSelect
                      density="form"
                      aria-label="Record type"
                      value={kind}
                      disabled={busy}
                      onChange={(event) => {
                        const forcedKind = event.currentTarget.value;
                        changePlan((current) =>
                          executeLimsImportReview(current, {
                            kind: 'set-source-options',
                            forcedKind,
                          })
                        );
                      }}
                    >
                      <option value="" disabled>
                        Choose record type
                      </option>
                      {[...choices].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </MenuNativeSelect>
                  </span>
                </label>
                {sheets.length > 1 && (
                  <label className="flex items-center gap-2">
                    Sheet
                    <span className="block min-w-0 w-full">
                      <MenuNativeSelect
                        density="form"
                        aria-label="Sheet"
                        value={plan.selectedSheet ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const sheetName = event.currentTarget.value;
                          changePlan((current) =>
                            executeLimsImportReview(current, {
                              kind: 'set-source-options',
                              sheetName,
                            })
                          );
                        }}
                      >
                        {sheets.map((sheet) => (
                          <option key={sheet.sheetName} value={sheet.sheetName}>
                            {sheet.sheetName}
                          </option>
                        ))}
                      </MenuNativeSelect>
                    </span>
                  </label>
                )}
              </div>
              <p className="text-xs text-fg-muted" role="status">
                Creates {view.acceptedCount} {view.acceptedCount === 1 ? 'record' : 'records'} and
                keeps the source spreadsheet in this location.
              </p>
              <fieldset disabled={busy} className="min-w-0 overflow-x-auto">
                <LimsImportColumnsPane
                  plan={plan}
                  view={view}
                  onColumnMappingsChange={(mappings) =>
                    changePlan((current) => mapLimsImportReview(current, mappings))
                  }
                  onRecordAcceptedChange={(id, accepted) =>
                    changePlan((current) => acceptLimsImportReviewRecords(current, [id], accepted))
                  }
                  onRecordsAcceptedChange={(ids, accepted) =>
                    changePlan((current) => acceptLimsImportReviewRecords(current, ids, accepted))
                  }
                />
              </fieldset>
            </>
          )}
        </div>
      )}
    </div>
  );
}
