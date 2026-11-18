import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { MolecularVariationPicker } from './MolecularVariationPicker';
import type { Structure3dAttrs } from '../types';
import { MEASUREMENT_PALETTES } from '../utils/residueMeasurement';
import {
  molecularDocumentReferenceRecord,
  type MolecularDocumentReference,
} from '../../../../../shared/molecular-document-reference';
import {
  molecularDataPublicationSchema,
  parseMolecularDataTable,
  type MolecularDataLayer,
  type MolecularDataPublication,
  type MolecularDataValue,
} from '../utils/molecularData';
import { molecularDataKeyTitle } from '../molstar/molViewSpecLegend';

const selectClass = 'rounded border border-border bg-bg px-2 py-1';
type Outcome = {
  ok: boolean;
  error?: string;
  coordinateSha256?: string;
  dataRevision?: string;
  mappingRevision?: string;
  referenceId?: string;
  revisionId?: string;
  documentReference?: MolecularDocumentReference;
  unresolved?: Array<{ row: number; reason: string }>;
  unrenderedRows?: number[];
};
async function command(input: unknown): Promise<Outcome> {
  const { handleMolData } = await import('../../../../agent-bridge/public/structure-tools');
  const outcome = (await handleMolData(input)) as Outcome;
  if (!outcome.ok) throw new Error(outcome.error ?? 'The data operation failed.');
  return outcome;
}

export function MolecularDataControls({
  structureViewId,
  attrs,
  ready,
}: {
  structureViewId: string;
  attrs: Structure3dAttrs;
  ready: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [saveOpen, setSaveOpen] = useState(false),
    [editorOpen, setEditorOpen] = useState(false);
  const [savedReferenceId, setSavedReferenceId] = useState<string | null>(null);
  const [savedDocumentReference, setSavedDocumentReference] =
    useState<MolecularDocumentReference | null>(null);
  const documentReference = savedDocumentReference ?? attrs.molecularDocumentReference;
  const [importName, setImportName] = useState(''),
    [chainColumn, setChainColumn] = useState(''),
    [positionColumn, setPositionColumn] = useState('');
  const [numbering, setNumbering] = useState<'label' | 'auth'>('label');
  const [input, setInput] = useState<{
    filename: string;
    records: Array<Record<string, MolecularDataValue>>;
    table?: { format: 'csv' | 'tsv'; text: string };
    publication?: MolecularDataPublication;
  } | null>(null);
  const [datasetKey, setDatasetKey] = useState(''),
    [column, setColumn] = useState('');
  const [palette, setPalette] = useState<keyof typeof MEASUREMENT_PALETTES | 'custom'>('viridis');
  const [valueKind, setValueKind] = useState<'continuous' | 'categorical'>('continuous');
  const [minimum, setMinimum] = useState('0'),
    [maximum, setMaximum] = useState('1'),
    [logarithmic, setLogarithmic] = useState(false);
  const [variationName, setVariationName] = useState(''),
    [savedTitle, setSavedTitle] = useState('');
  const state = attrs.molecularData;
  const active = state?.layers.find((layer) => layer.id === state.activeLayerId);
  const dataset =
    state?.datasets.find((item) => `${item.id}:${item.revision}` === datasetKey) ??
    state?.datasets[state.datasets.length - 1];
  const columns = [...new Set(dataset?.records.flatMap((row) => Object.keys(row)) ?? [])];
  const importColumns = [...new Set(input?.records.flatMap((row) => Object.keys(row)) ?? [])];
  const execute = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (active) {
      setDatasetKey(`${active.datasetId}:${active.dataRevision}`);
      setColumn(active.column);
      setVariationName(active.name);
      setSavedTitle(active.name);
      setValueKind(active.style.kind);
      const colors =
        active.style.kind === 'continuous'
          ? active.style.colors
          : Object.values(active.style.colors);
      const matching =
        active.style.kind === 'continuous'
          ? Object.entries(MEASUREMENT_PALETTES).find(
              ([, stops]) =>
                JSON.stringify(stops.map((color) => color.toLowerCase())) ===
                JSON.stringify(colors.map((color) => color.toLowerCase()))
            )?.[0]
          : undefined;
      setPalette((matching as keyof typeof MEASUREMENT_PALETTES) ?? 'custom');
      if (active.style.kind === 'continuous') {
        setMinimum(String(active.style.domain[0]));
        setMaximum(String(active.style.domain[1]));
        setLogarithmic(active.style.transform === 'log10');
      }
    }
  }, [active]);
  const chooseColumn = (value: string) => {
    setColumn(value);
    setVariationName(value);
    const populated =
      dataset?.records
        .map((row) => row[value])
        .filter((value) => value !== null && value !== undefined && value !== '') ?? [];
    setValueKind(
      populated.every((value) => typeof value !== 'boolean' && Number.isFinite(Number(value)))
        ? 'continuous'
        : 'categorical'
    );
    setPalette('viridis');
    setLogarithmic(false);
    const numbers =
      dataset?.records
        .map((row) => row[value])
        .filter((value) => value !== null && value !== undefined && value !== '')
        .map((value) => (typeof value === 'boolean' ? NaN : Number(value)))
        .filter(Number.isFinite) ?? [];
    const low = numbers.length ? Math.min(...numbers) : 0,
      high = numbers.length ? Math.max(...numbers) : 1;
    setMinimum(String(low));
    setMaximum(String(high === low ? low + 1 : high));
  };
  const apply = async (variation: boolean) => {
    if (!dataset || !column) throw new Error('Choose a dataset and column.');
    const mapping = state?.mappings.find(
      (item) => item.datasetId === dataset.id && item.dataRevision === dataset.revision
    );
    if (!mapping) throw new Error('This dataset has no mapping for the current coordinates.');
    const values = dataset.records
      .map((row) => row[column])
      .filter((value) => value !== null && value !== undefined && value !== '');
    const sameBasis =
      active?.datasetId === dataset.id &&
      active.dataRevision === dataset.revision &&
      active.column === column;
    if (palette === 'custom' && (!sameBasis || active?.style.kind !== valueKind))
      throw new Error('Choose a palette for the new signal.');
    const selectedPalette = MEASUREMENT_PALETTES[palette === 'custom' ? 'viridis' : palette];
    const categorical =
      palette === 'custom' && active?.style.kind === 'categorical'
        ? active.style.colors
        : Object.fromEntries(
            [...new Set(values.map(String))].map((value, index) => [
              value,
              selectedPalette[index % selectedPalette.length],
            ])
          );
    const missingColor = sameBasis ? active!.style.missingColor : '#9ca3af';
    const layer: MolecularDataLayer = {
      id: variation
        ? `visual:${crypto.randomUUID()}`
        : (active?.id ?? `visual:${crypto.randomUUID()}`),
      name: variationName.trim() || column,
      datasetId: dataset.id,
      dataRevision: dataset.revision,
      mappingRevision: mapping.revision,
      column,
      ...(sameBasis ? { units: active!.units, filter: active!.filter } : {}),
      style:
        valueKind === 'continuous'
          ? {
              kind: 'continuous',
              domain: [Number(minimum), Number(maximum)],
              colors:
                palette === 'custom' && active?.style.kind === 'continuous'
                  ? active.style.colors
                  : selectedPalette,
              missingColor,
              transform: logarithmic ? 'log10' : 'linear',
            }
          : { kind: 'categorical', colors: categorical, missingColor },
    };
    const result = await command({ operation: 'apply', structureViewId, layer });
    const warnings = [
      result.unresolved?.length ? `${result.unresolved.length} rows have no coordinates` : '',
      result.unrenderedRows?.length
        ? `${result.unrenderedRows.length} mapped rows are not drawn`
        : '',
    ].filter(Boolean);
    setNotice(warnings.length ? `${warnings.join('; ')}. Original rows are retained.` : null);
  };
  const publish = async () => {
    if (!input) throw new Error('Choose a data file.');
    const inspected = await command({ operation: 'inspect', structureViewId });
    const publication: MolecularDataPublication = input.publication ?? {
      id: `data:${crypto.randomUUID()}`,
      name: importName.trim() || input.filename,
      ...(input.table ? { table: input.table } : { records: input.records }),
      source: { label: input.filename },
      mapping: {
        coordinateSha256: inspected.coordinateSha256!,
        selectorColumns: {
          [numbering === 'label' ? 'label_asym_id' : 'auth_asym_id']: chainColumn,
          ...(positionColumn
            ? { [numbering === 'label' ? 'label_seq_id' : 'auth_seq_id']: positionColumn }
            : {}),
        },
      },
    };
    const latest = [...(state?.datasets ?? [])]
      .reverse()
      .find((dataset) => dataset.id === publication.id);
    const result = await command({
      operation: 'publish',
      structureViewId,
      publication,
      ...(latest ? { expectedRevision: latest.revision } : {}),
    });
    setDatasetKey(`${publication.id}:${result.dataRevision}`);
    setColumn('');
    setImportOpen(false);
    setEditorOpen(true);
    setNotice(
      `Imported ${input.records.length} rows${result.unresolved?.length ? `; ${result.unresolved.length} unresolved` : ''}. Choose a column to display.`
    );
  };
  const loadFile = async (file: File) => {
    if (file.size > 2_000_000) throw new Error('This data file exceeds the current 2 MB limit.');
    const text = await file.text();
    const format = file.name.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv';
    const parsed = file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : undefined;
    const publication =
      parsed && !Array.isArray(parsed) ? molecularDataPublicationSchema.parse(parsed) : undefined;
    const records = publication
      ? (publication.records ??
        parseMolecularDataTable(publication.table!.text, publication.table!.format))
      : (parsed ?? parseMolecularDataTable(text, format));
    if (!Array.isArray(records) || !records.length)
      throw new Error('Use a nonempty JSON record array/publication, CSV, or TSV.');
    setInput({
      filename: file.name,
      records,
      publication,
      ...(!parsed ? { table: { format, text } } : {}),
    });
    setImportName(file.name.replace(/\.[^.]+$/, ''));
    const headers = Object.keys(records[0]);
    setChainColumn(
      headers.find((key) => ['label_asym_id', 'auth_asym_id', 'chain'].includes(key)) ?? headers[0]
    );
    setPositionColumn(
      headers.find((key) => ['label_seq_id', 'auth_seq_id', 'position', 'residue'].includes(key)) ??
        ''
    );
    setNumbering(headers.includes('auth_asym_id') ? 'auth' : 'label');
  };
  return (
    <div data-testid="molecular-data-controls" className="shrink-0 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Data</span>
        {!attrs.molViewSpec && (
          <button
            className={selectClass}
            disabled={!ready || busy}
            onClick={() =>
              void execute(async () => {
                const { handleMolGetScene, handleMolApplyScene } =
                  await import('../../../../agent-bridge/public/structure-tools');
                const read = (await handleMolGetScene({ structureViewId })) as Outcome & {
                  scene?: string;
                };
                if (!read.ok) throw new Error(read.error ?? 'The loaded view could not be read.');
                const applied = (await handleMolApplyScene({
                  structureViewId,
                  scene: read.scene,
                })) as Outcome;
                if (!applied.ok)
                  throw new Error(applied.error ?? 'The data view could not be prepared.');
              })
            }
          >
            Prepare data view
          </button>
        )}
        <button
          className={selectClass}
          disabled={!ready || busy}
          onClick={() => setImportOpen(!importOpen)}
        >
          Import data
        </button>
        {!!state?.layers.length && (
          <label>
            View{' '}
            <MolecularVariationPicker
              label="Data view"
              disabled={!ready || busy}
              activeId={state.activeLayerId}
              variations={state.layers}
              onSelect={(id) =>
                void execute(async () => {
                  const layer = state.layers.find((layer) => layer.id === id)!;
                  await command({ operation: 'apply', structureViewId, layer });
                })
              }
            />
          </label>
        )}
        {!!state?.datasets.length && (
          <>
            <button
              className={selectClass}
              disabled={busy}
              aria-expanded={editorOpen}
              onClick={() => setEditorOpen(!editorOpen)}
            >
              {active ? 'Edit view' : 'Create view'}
            </button>
            <button
              className={selectClass}
              disabled={!active || busy}
              onClick={() => setSaveOpen(!saveOpen)}
            >
              Save data view
            </button>
          </>
        )}
        {busy && <span role="status">Updating…</span>}
        {(documentReference || savedReferenceId) && (
          <button
            data-testid="open-saved-data-view"
            data-reference-id={savedReferenceId ?? undefined}
            data-document-reference={
              documentReference ? JSON.stringify(documentReference) : undefined
            }
            className={selectClass}
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                const [{ getEntityReference }, { navigateToReference }] = await Promise.all([
                  import('../../../../../db/entity-references'),
                  import('../../../../ai/public/navigate-to-reference'),
                ]);
                const reference = documentReference
                  ? molecularDocumentReferenceRecord(documentReference, savedTitle)
                  : await getEntityReference(savedReferenceId!);
                if (!reference) throw new Error('The saved view is unavailable.');
                await navigateToReference(reference);
              })
            }
          >
            Open saved view
          </button>
        )}
      </div>
      {editorOpen && !!state?.datasets.length && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-border p-2">
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              aria-label="Data source"
              disabled={busy}
              value={dataset ? `${dataset.id}:${dataset.revision}` : ''}
              onChange={(event) => {
                setDatasetKey(event.target.value);
                setColumn('');
                setPalette('viridis');
              }}
            >
              {state.datasets.map((item, index) => (
                <option key={`${item.id}:${item.revision}`} value={`${item.id}:${item.revision}`}>
                  {item.name}
                  {state.datasets.filter((dataset) => dataset.id === item.id).length > 1
                    ? ` · revision ${state.datasets.slice(0, index + 1).filter((dataset) => dataset.id === item.id).length}`
                    : ''}
                </option>
              ))}
            </MenuNativeSelect>
          </span>
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              aria-label="Data column"
              disabled={busy}
              value={column}
              onChange={(event) => chooseColumn(event.target.value)}
            >
              <option value="" disabled>
                Choose signal
              </option>
              {columns.map((column) => (
                <option key={column}>{column}</option>
              ))}
            </MenuNativeSelect>
          </span>
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              aria-label="Data kind"
              disabled={busy}
              value={valueKind}
              onChange={(event) => {
                setValueKind(event.target.value as 'continuous' | 'categorical');
                setPalette('viridis');
              }}
            >
              <option value="continuous">Numbers</option>
              <option value="categorical">Categories</option>
            </MenuNativeSelect>
          </span>
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              aria-label="Data palette"
              disabled={busy}
              value={palette}
              onChange={(event) => setPalette(event.target.value as typeof palette)}
            >
              {palette === 'custom' && <option value="custom">Custom colors</option>}
              {Object.keys(MEASUREMENT_PALETTES).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </MenuNativeSelect>
          </span>
          {valueKind === 'continuous' && (
            <>
              <input
                aria-label="Color minimum"
                type="number"
                className={`${selectClass} w-20`}
                value={minimum}
                disabled={busy}
                onChange={(event) => setMinimum(event.target.value)}
              />
              <span>to</span>
              <input
                aria-label="Color maximum"
                type="number"
                className={`${selectClass} w-20`}
                value={maximum}
                disabled={busy}
                onChange={(event) => setMaximum(event.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={logarithmic}
                  disabled={busy}
                  onChange={(event) => setLogarithmic(event.target.checked)}
                />{' '}
                Log scale
              </label>
            </>
          )}
          <label>
            View name{' '}
            <input
              aria-label="Data variation name"
              className={selectClass}
              value={variationName}
              onChange={(event) => setVariationName(event.target.value)}
            />
          </label>
          <button
            className={selectClass}
            disabled={!column || !ready || busy}
            onClick={() => void execute(() => apply(false))}
          >
            Apply signal
          </button>
          <button
            className={selectClass}
            disabled={!column || !ready || busy}
            onClick={() => void execute(() => apply(true))}
          >
            New variation
          </button>
        </div>
      )}
      {importOpen && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border p-2">
          <input
            aria-label="Molecular data file"
            type="file"
            accept=".csv,.tsv,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void execute(() => loadFile(file));
            }}
          />
          {input && (
            <>
              <label>
                Name{' '}
                <input
                  aria-label="Imported data name"
                  className={selectClass}
                  value={importName}
                  onChange={(event) => setImportName(event.target.value)}
                />
              </label>
              {!input.publication && (
                <>
                  <label>
                    Chain column{' '}
                    <span className="inline-block min-w-0">
                      <MenuNativeSelect
                        density="compact"
                        aria-label="Target chain column"
                        value={chainColumn}
                        onChange={(event) => setChainColumn(event.target.value)}
                      >
                        {importColumns.map((column) => (
                          <option key={column}>{column}</option>
                        ))}
                      </MenuNativeSelect>
                    </span>
                  </label>
                  <label>
                    Numbering{' '}
                    <span className="inline-block min-w-0">
                      <MenuNativeSelect
                        density="compact"
                        aria-label="Target numbering"
                        value={numbering}
                        onChange={(event) => setNumbering(event.target.value as 'label' | 'auth')}
                      >
                        <option value="label">File labels</option>
                        <option value="auth">Author labels</option>
                      </MenuNativeSelect>
                    </span>
                  </label>
                  <label>
                    Position column{' '}
                    <span className="inline-block min-w-0">
                      <MenuNativeSelect
                        density="compact"
                        aria-label="Target position column"
                        value={positionColumn}
                        onChange={(event) => setPositionColumn(event.target.value)}
                      >
                        <option value="">Whole chain</option>
                        {importColumns.map((column) => (
                          <option key={column}>{column}</option>
                        ))}
                      </MenuNativeSelect>
                    </span>
                  </label>
                </>
              )}
              <button className={selectClass} disabled={busy} onClick={() => void execute(publish)}>
                Publish data
              </button>
            </>
          )}
        </div>
      )}
      {saveOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label="Saved data view title"
            className={selectClass}
            value={savedTitle}
            onChange={(event) => setSavedTitle(event.target.value)}
          />
          <button
            className={selectClass}
            disabled={busy || !savedTitle.trim()}
            onClick={() =>
              void execute(async () => {
                const { handleMolSaveView } =
                  await import('../../../../agent-bridge/public/structure-tools');
                const saved = (await handleMolSaveView({
                  ...(attrs.molecularDocumentReference
                    ? { documentReference: attrs.molecularDocumentReference }
                    : { structureViewId }),
                  title: savedTitle.trim(),
                  caption: active?.name ?? '',
                  evidence: [],
                })) as Outcome;
                if (!saved.ok) throw new Error(saved.error ?? 'The view could not be saved.');
                setSavedReferenceId(saved.referenceId ?? saved.revisionId ?? null);
                setSavedDocumentReference(saved.documentReference ?? null);
                setNotice(`Saved “${savedTitle.trim()}” with its original data and mappings.`);
                setSaveOpen(false);
              })
            }
          >
            Save view
          </button>
        </div>
      )}
      {active && (
        <div data-testid="molecular-data-legend" className="mt-1 flex flex-wrap items-center gap-2">
          <span>{molecularDataKeyTitle(active)}</span>
          {active.style.kind === 'continuous' ? (
            <>
              <span>{active.style.domain[0]}</span>
              <span
                className="h-2 w-36 rounded"
                style={{ background: `linear-gradient(to right,${active.style.colors.join(',')})` }}
              />
              <span>{active.style.domain[1]}</span>
            </>
          ) : (
            Object.entries(active.style.colors)
              .slice(0, 12)
              .map(([label, color]) => (
                <span key={label}>
                  <span style={{ color }}>■</span> {label}
                </span>
              ))
          )}
          <span style={{ color: active.style.missingColor }}>■</span>
          <span>Missing</span>
        </div>
      )}
      {notice && (
        <p role="status" className="pt-1 text-muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="pt-1 text-red-500">
          {toUserMessage(error, 'structure.failed')}
        </p>
      )}
    </div>
  );
}
