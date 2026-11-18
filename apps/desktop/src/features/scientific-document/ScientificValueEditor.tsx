import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  editProtocolSlotDeclarations,
  editProtocolRunValues,
  readProtocolRunSlotDeclarations,
  type ProtocolSimpleValueKind,
  type ProtocolSlotDeclarationUpsert,
  type ProtocolRunValueUpsert,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { UI_MODAL_LAYER_CLASS } from '../../components/ui/styles';
import {
  protocolEditDeclarationsSchema,
  protocolRecordRunValuesSchema,
  type NativeProtocolPackageSnapshot,
  type NativeProtocolCreationResult,
} from '../../shared/protocol-packages';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { ProtocolOperation, ProtocolOperationSession } from './protocol-operation-session';
type ValueOperation = Extract<ProtocolOperation, { kind: 'edit-declarations' | 'record-values' }>;
type Collection = 'inputs' | 'outputs' | 'measurements';
type Row = {
  collection: Collection;
  key: string;
  label: string;
  kind: ProtocolSimpleValueKind;
  input: string;
  required: boolean;
  description: string;
  existing: boolean;
  origin: ProtocolRunValueUpsert['origin'];
};
const simple = (value: unknown): value is ProtocolSimpleValueKind =>
  ['text', 'number', 'boolean', 'date'].includes(String(value));
const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
function rawKind(row: Record<string, unknown>, declarations: boolean) {
  const value = (declarations ? row.valueType : row.value) as Record<string, unknown> | undefined;
  return value?.[declarations ? 'kind' : 'type'];
}
function entered(row: Row): ProtocolRunValueUpsert['value'] {
  switch (row.kind) {
    case 'text':
      return { type: 'text', value: row.input };
    case 'boolean':
      if (!['true', 'false'].includes(row.input))
        throw Error(`Choose Yes or No for ${row.label || 'this value'}.`);
      return { type: 'boolean', value: row.input === 'true' };
    case 'number': {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(row.input.trim()))
        throw Error('Enter a number.');
      const value = Number(row.input);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw Error('Enter a finite number within the supported integer range.');
      return { type: 'number', value };
    }
    case 'date': {
      const epoch = Date.parse(row.input);
      if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== row.input)
        throw Error('Enter an exact UTC timestamp, such as 2026-11-17T12:00:00.000Z.');
      return { type: 'date', value: row.input };
    }
  }
}
export function scientificValueEditRequest(
  source: NativeProtocolPackageSnapshot,
  mode: 'declarations' | 'values',
  rows: readonly Row[],
  reason: string,
  requestId: string
): ValueOperation {
  if (!reason.trim()) throw Error('Enter a reason for this save.');
  if (!rows.length) throw Error('Choose a row to edit or add a new value.');
  const base = {
    project: source.projectId,
    entityId: source.entityId,
    requestId,
    expectedSourceSha256: source.sourceSha256,
  };
  if (mode === 'declarations') {
    const upserts: ProtocolSlotDeclarationUpsert[] = rows.map((row) => {
      if (row.collection === 'measurements')
        throw Error('Protocol declarations are inputs or outputs.');
      return {
        direction: row.collection,
        key: row.key,
        label: row.label.trim(),
        required: row.required,
        description: row.description.trim() || null,
        valueType: { kind: row.kind },
      };
    });
    editProtocolSlotDeclarations(source.originalText, upserts);
    return {
      kind: 'edit-declarations',
      request: protocolEditDeclarationsSchema.parse({
        ...base,
        choices: { upserts, reason: reason.trim() },
      }),
    };
  }
  const upserts: ProtocolRunValueUpsert[] = rows.map((row) => ({
    collection: row.collection,
    key: row.key,
    label: row.label.trim(),
    value: entered(row),
    origin: row.origin,
  }));
  editProtocolRunValues(source.originalText, upserts);
  return {
    kind: 'record-values',
    request: protocolRecordRunValuesSchema.parse({
      ...base,
      choices: { upserts, reason: reason.trim() },
    }),
  };
}
export function ScientificValueEditor({
  source,
  mode,
  operation,
  onSaved,
  onClose,
}: {
  source: NativeProtocolPackageSnapshot;
  mode: 'declarations' | 'values';
  operation: ProtocolOperationSession;
  onSaved(): Promise<boolean>;
  onClose(): void;
}) {
  const raw = useMemo(
      () => JSON.parse(source.originalText) as Record<string, unknown>,
      [source.originalText]
    ),
    snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot),
    [rows, setRows] = useState<Row[]>([]),
    [reason, setReason] = useState(''),
    [prepared, setPrepared] = useState<ValueOperation | null>(null),
    [error, setError] = useState<string | null>(null),
    [adopting, setAdopting] = useState(false);
  const overlay = usePresentationOverlay('modal'),
    active = useRef(true),
    generation = useRef(0);
  const declarations = mode === 'declarations',
    frozen = useMemo(
      () => (declarations ? null : readProtocolRunSlotDeclarations(source.originalText)),
      [declarations, source.originalText]
    );
  const pending =
      'attempt' in snapshot && !(snapshot.phase === 'result' && snapshot.result.kind === 'ready'),
    ownReady =
      snapshot.phase === 'result' &&
      snapshot.result.kind === 'ready' &&
      prepared?.request.requestId === snapshot.attempt.request.requestId,
    locked = pending || ownReady || adopting;
  useEffect(() => {
    operation.refresh();
    const storage = () => operation.refresh();
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [operation]);
  useEffect(() => {
    active.current = true;
    ++generation.current;
    return () => {
      active.current = false;
      ++generation.current;
    };
  }, [source.projectId, source.entityId, source.sourceSha256, mode]);
  function update(next: Row[]) {
    if (locked) return;
    setRows(next);
    setPrepared(null);
    setError(null);
  }
  function beginRow(
    collection: Collection,
    existing?: Record<string, unknown>,
    declared?: Record<string, unknown>
  ) {
    const target = existing ?? declared,
      key = target
        ? String(target.key)
        : `${collection === 'inputs' ? 'input' : collection === 'outputs' ? 'output' : 'measurement'}_${crypto.randomUUID().replaceAll('-', '')}`;
    if (rows.some((row) => row.collection === collection && row.key === key)) return;
    const kind = target ? rawKind(target, declarations || Boolean(declared)) : 'text';
    if (!simple(kind)) return;
    const value = existing?.value as Record<string, unknown> | undefined;
    const origin: Row['origin'] =
      !declarations &&
      collection !== 'measurements' &&
      frozen?.kind === 'available' &&
      array(frozen[collection]).some((item) => item.key === key)
        ? { kind: 'frozen-declaration', definitionSha256: frozen.definitionSha256 }
        : { kind: 'local-actual' };
    update([
      ...rows,
      {
        collection,
        key,
        label: String(target?.label ?? ''),
        kind,
        input:
          value?.type === 'boolean'
            ? String(value.value)
            : value && 'value' in value
              ? String(value.value)
              : '',
        required: target?.required === true,
        description: typeof target?.description === 'string' ? target.description : '',
        existing: Boolean(target),
        origin,
      },
    ]);
  }
  function rowChange(index: number, change: Partial<Row>) {
    update(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  }
  function prepare() {
    try {
      setPrepared(scientificValueEditRequest(source, mode, rows, reason, crypto.randomUUID()));
      setError(null);
    } catch (cause) {
      setPrepared(null);
      setError(message(cause));
    }
  }
  async function finish(
    pendingResult:
      | Promise<NativeProtocolCreationResult | null>
      | NativeProtocolCreationResult
      | null
  ) {
    const ticket = generation.current,
      result = await pendingResult;
    if (!active.current || ticket !== generation.current || result?.kind !== 'ready') return;
    setAdopting(true);
    try {
      if (result.currentAvailability?.kind === 'unavailable')
        throw Error(result.currentAvailability.message);
      if (await onSaved()) onClose();
      else
        throw Error('The original save is ready. The current document could not be reloaded yet.');
    } catch (cause) {
      if (active.current && ticket === generation.current) setError(message(cause));
    } finally {
      if (active.current && ticket === generation.current) setAdopting(false);
    }
  }
  const collections: Collection[] = declarations
    ? ['inputs', 'outputs']
    : ['inputs', 'outputs', 'measurements'];
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} grid place-items-center bg-black/40 p-4`}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-label={declarations ? 'Edit input and output declarations' : 'Edit recorded values'}
          className="flex max-h-[calc(100vh-48px)] w-full max-w-5xl flex-col rounded-lg border border-border bg-bg shadow-xl"
          data-testid={declarations ? 'protocol-declarations-editor' : 'run-recorded-values-editor'}
          data-edit-phase={
            pending ? snapshot.phase : ownReady ? 'ready' : prepared ? 'prepared' : 'editing'
          }
        >
          <header className="flex items-center justify-between border-b border-border p-4">
            <h2 className="font-semibold">
              {declarations ? 'Edit input and output declarations' : 'Edit recorded values'}
            </h2>
            <Button disabled={snapshot.phase === 'sending'} onClick={onClose}>
              Close value editor
            </Button>
          </header>
          <main className="min-h-0 space-y-4 overflow-auto p-4">
            <p>
              {declarations
                ? 'Declarations describe this saved Protocol. Starting a Run freezes its saved declarations.'
                : 'Record ordinary values for this Run. These entries do not identify physical aliquots or change inventory.'}
            </p>
            {!declarations && frozen?.kind === 'unavailable' ? (
              <Notice>
                Frozen declarations unavailable: {frozen.reason}. Local values can still be
                recorded.
              </Notice>
            ) : null}
            {collections.map((collection) => (
              <section
                className="space-y-3 rounded border border-border p-3"
                key={collection}
                data-slot-section={collection}
              >
                <h3 className="font-semibold">
                  {collection[0]!.toUpperCase() + collection.slice(1)}
                </h3>
                {array(raw[collection]).map((saved) => {
                  const key = String(saved.key),
                    kind = rawKind(saved, declarations),
                    decl =
                      !declarations && collection !== 'measurements' && frozen?.kind === 'available'
                        ? array(frozen[collection]).find((item) => item.key === key)
                        : null,
                    declKind = decl ? rawKind(decl, true) : null,
                    editable =
                      simple(kind) &&
                      /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) &&
                      (!decl || declKind === kind);
                  return (
                    <article
                      className="space-y-1 rounded border border-border p-2"
                      key={key}
                      data-saved-slot-key={key}
                      data-slot-collection={collection}
                    >
                      <p className="font-medium">{String(saved.label)}</p>
                      <p>
                        {String(kind)}
                        {declarations
                          ? saved.required
                            ? ' · Required'
                            : ' · Optional'
                          : decl
                            ? ' · From frozen Protocol'
                            : ' · Added for this Run'}
                      </p>
                      {!declarations ? (
                        <p>{display((saved.value as Record<string, unknown>)?.value)}</p>
                      ) : null}
                      {editable ? (
                        <Button
                          disabled={
                            locked ||
                            rows.some((row) => row.collection === collection && row.key === key)
                          }
                          onClick={() => beginRow(collection, saved)}
                        >
                          Edit {declarations ? 'declaration' : 'value'}
                        </Button>
                      ) : (
                        <p>This type or preserved key is read only here.</p>
                      )}
                    </article>
                  );
                })}
                {!declarations && collection !== 'measurements' && frozen?.kind === 'available'
                  ? array(frozen[collection])
                      .filter(
                        (decl) => !array(raw[collection]).some((saved) => saved.key === decl.key)
                      )
                      .map((decl) => (
                        <article
                          className="space-y-1 rounded border border-border p-2"
                          key={String(decl.key)}
                          data-missing-slot-key={String(decl.key)}
                        >
                          <p>
                            {String(decl.label)} · {decl.required ? 'Required' : 'Optional'} · Not
                            recorded
                          </p>
                          {simple(rawKind(decl, true)) ? (
                            <Button
                              disabled={
                                locked ||
                                rows.some(
                                  (row) => row.collection === collection && row.key === decl.key
                                )
                              }
                              onClick={() => beginRow(collection, undefined, decl)}
                            >
                              Record value
                            </Button>
                          ) : (
                            <p>This declaration type is read only here.</p>
                          )}
                        </article>
                      ))
                  : null}
                <Button
                  disabled={locked || rows.length >= 100}
                  onClick={() => beginRow(collection)}
                >
                  {declarations
                    ? collection === 'inputs'
                      ? 'Add input declaration'
                      : 'Add output declaration'
                    : collection === 'inputs'
                      ? 'Add input value'
                      : collection === 'outputs'
                        ? 'Add output value'
                        : 'Add measurement'}
                </Button>
                {rows.map((row, index) =>
                  row.collection !== collection ? null : (
                    <fieldset
                      key={row.key}
                      disabled={locked}
                      className="space-y-3 rounded border border-accent p-3"
                      data-slot-collection={row.collection}
                      data-slot-key={row.key}
                    >
                      <Field label="Label">
                        <TextField
                          aria-label="Label"
                          value={row.label}
                          onChange={(event) => rowChange(index, { label: event.target.value })}
                        />
                      </Field>
                      <Field label="Type">
                        <Select
                          ariaLabel="Type"
                          value={row.kind}
                          disabled={row.existing}
                          options={[
                            { value: 'text', label: 'Text' },
                            { value: 'number', label: 'Number' },
                            { value: 'boolean', label: 'Yes or no' },
                            { value: 'date', label: 'Date and time' },
                          ]}
                          onValueChange={(value) =>
                            rowChange(index, { kind: value as Row['kind'], input: '' })
                          }
                        />
                      </Field>
                      {declarations ? (
                        <>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              aria-label="Required"
                              checked={row.required}
                              onChange={(event) =>
                                rowChange(index, { required: event.target.checked })
                              }
                            />
                            Required
                          </label>
                          <Field label="Description">
                            <TextField
                              aria-label="Description"
                              value={row.description}
                              onChange={(event) =>
                                rowChange(index, { description: event.target.value })
                              }
                            />
                          </Field>
                        </>
                      ) : (
                        <>
                          <p>
                            {row.origin.kind === 'frozen-declaration'
                              ? 'From frozen Protocol'
                              : 'Added for this Run'}
                          </p>
                          <Field label={row.kind === 'date' ? 'Date and time (UTC)' : 'Value'}>
                            {row.kind === 'boolean' ? (
                              <Select
                                ariaLabel="Value"
                                value={row.input}
                                options={[
                                  { value: '', label: 'Choose a value' },
                                  { value: 'true', label: 'Yes' },
                                  { value: 'false', label: 'No' },
                                ]}
                                onValueChange={(value) => rowChange(index, { input: value })}
                              />
                            ) : row.kind === 'text' ? (
                              <TextArea
                                aria-label="Value"
                                rows={2}
                                value={row.input}
                                onChange={(event) =>
                                  rowChange(index, { input: event.target.value })
                                }
                              />
                            ) : (
                              <TextField
                                aria-label={row.kind === 'date' ? 'Date and time (UTC)' : 'Value'}
                                value={row.input}
                                placeholder={
                                  row.kind === 'date' ? '2026-11-17T12:00:00.000Z' : undefined
                                }
                                onChange={(event) =>
                                  rowChange(index, { input: event.target.value })
                                }
                              />
                            )}
                          </Field>
                        </>
                      )}
                      <details>
                        <summary>Stable field key</summary>
                        <p className="break-all text-xs">{row.key}</p>
                      </details>
                      <Button onClick={() => update(rows.filter((_, at) => at !== index))}>
                        Discard this draft row
                      </Button>
                    </fieldset>
                  )
                )}
              </section>
            ))}
            <fieldset disabled={locked} className="space-y-3">
              <Field label="Reason for save">
                <TextArea
                  aria-label="Reason for save"
                  rows={2}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPrepared(null);
                  }}
                />
              </Field>
              <Button onClick={prepare}>Preview value changes</Button>
            </fieldset>
            {prepared ? (
              <section className="space-y-3" data-testid="scientific-value-edit-preview">
                <Notice>
                  Ready to save these explicit {declarations ? 'declarations' : 'recorded values'}.
                  The native owner checks the saved source before writing.
                </Notice>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(prepared.request.choices, null, 2)}
                </pre>
                <details>
                  <summary>Prepared save request</summary>
                  <TextArea
                    readOnly
                    aria-label="Prepared scientific value request"
                    rows={8}
                    value={JSON.stringify(prepared.request, null, 2)}
                  />
                </details>
              </section>
            ) : null}
            <Button
              disabled={!prepared || locked}
              variant="primary"
              onClick={() => prepared && void finish(operation.begin(prepared))}
            >
              {declarations ? 'Save declarations' : 'Save recorded values'}
            </Button>
            {snapshot.phase === 'sending' ? (
              <p role="status">Saving the original operation…</p>
            ) : pending ? (
              <Notice>
                <p>
                  {snapshot.phase === 'result'
                    ? snapshot.result.kind === 'missing'
                      ? 'The original save has no receipt yet.'
                      : snapshot.result.kind !== 'ready'
                        ? snapshot.result.message
                        : ''
                    : 'message' in snapshot
                      ? snapshot.message
                      : ''}
                </p>
                <Button onClick={() => void finish(operation.inspect())}>
                  Check original save
                </Button>
                <Button onClick={() => void finish(operation.retry())}>Retry same save</Button>
              </Notice>
            ) : ownReady ? (
              <Notice>
                The original save is ready.
                <Button onClick={() => void finish(Promise.resolve(snapshot.result))}>
                  Reload saved values
                </Button>
              </Notice>
            ) : snapshot.phase === 'failed' ? (
              <Notice tone="error">{snapshot.message}</Notice>
            ) : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
          </main>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
function display(value: unknown) {
  return value === false
    ? 'No'
    : value === true
      ? 'Yes'
      : value === ''
        ? 'Recorded empty text'
        : value === undefined
          ? 'Preserved value'
          : String(value);
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The scientific values could not be saved.';
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
