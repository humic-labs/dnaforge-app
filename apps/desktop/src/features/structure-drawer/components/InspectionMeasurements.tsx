import { toUserMessage } from '@waypoint/user-messages';
import { useId, useState } from 'react';
import {
  MEASUREMENT_PALETTES,
  log2Enrichment,
  residueMeasurementSchema,
  type ResidueMeasurement,
} from '../../page/public/embeds/structure3d/residueMeasurement';
import { sha256Hex } from '../api/protein-identity';
import type { StructureInspection } from '../structure-inspection';
import { MolecularVariationPicker } from '../../page/public/embeds/structure3d/components/MolecularVariationPicker';
import type { MolecularDataLayer, MolecularDataView } from '../../../shared/molecular-data';

export function InspectionMeasurements({
  inspection,
  onApply,
  molecularData,
  onApplyLayer,
  ready = true,
}: {
  inspection: StructureInspection;
  onApply: (measurement: ResidueMeasurement) => Promise<{ unmappedResidues: number[] }>;
  molecularData?: MolecularDataView;
  onApplyLayer: (
    layer: MolecularDataLayer
  ) => Promise<{ unresolved?: Array<{ row: number; reason: string }> }>;
  ready?: boolean;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'values' | 'enrichment'>('values');
  const [palette, setPalette] = useState<keyof typeof MEASUREMENT_PALETTES>('viridis');
  const [customColors, setCustomColors] = useState('');
  const [transform, setTransform] = useState<'linear' | 'log10'>('linear');
  const [low, setLow] = useState(''),
    [high, setHigh] = useState('');
  const [pseudocount, setPseudocount] = useState('1');
  const [source, setSource] = useState('Pasted residue table');
  const [units, setUnits] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const variations = [
    ...(inspection.measurements ?? []),
    ...(molecularData?.layers.filter(
      (layer) => !inspection.measurements?.some((item) => item.id === layer.id)
    ) ?? []),
  ];
  const hasMeasurements = variations.length > 0;
  const activeId = molecularData?.activeLayerId ?? inspection.activeMeasurementId;
  const selectVariation = async (id: string) => {
    const layer = molecularData?.layers.find((item) => item.id === id);
    if (!layer) {
      const measurement = inspection.measurements?.find((item) => item.id === id);
      if (measurement) await apply(measurement);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await onApplyLayer(layer);
      setOpen(false);
      if (result.unresolved?.length)
        setMessage(
          `Applied. ${result.unresolved.length} data rows have no resolved coordinates; their values remain saved.`
        );
    } catch (error) {
      setMessage(
        toUserMessage(error instanceof Error ? error.message : String(error), 'structure.failed')
      );
    } finally {
      setBusy(false);
    }
  };
  const apply = async (measurement: ResidueMeasurement) => {
    setBusy(true);
    setMessage('');
    try {
      const result = await onApply(measurement);
      setOpen(false);
      setMessage(
        result.unmappedResidues.length
          ? `Applied. No coordinates for residues ${result.unmappedResidues.join(', ')}; these values remain saved.`
          : ''
      );
    } catch (error) {
      setMessage(
        toUserMessage(error instanceof Error ? error.message : String(error), 'structure.failed')
      );
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    try {
      const rows = text
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split(/[,\t]/).map((value) => value.trim()));
      if (/^residue$/i.test(rows[0]?.[0] ?? '')) rows.shift();
      if (!rows.length || rows.some((row) => row.length !== (kind === 'values' ? 2 : 3)))
        throw new Error(
          kind === 'values'
            ? 'Use two columns: residue,value. Blank values mean missing.'
            : 'Use three columns: residue,before,after.'
        );
      const counts =
        kind === 'enrichment'
          ? rows.map((row) => {
              if (row.some((value) => !value))
                throw new Error('Enrichment needs both counts at every residue.');
              return { residue: Number(row[0]), before: Number(row[1]), after: Number(row[2]) };
            })
          : undefined;
      const values = counts
        ? log2Enrichment(counts, Number(pseudocount))
        : rows.map((row) => ({
            residue: Number(row[0]),
            value: row[1] === '' ? null : Number(row[1]),
          }));
      if (values.some((point) => point.residue > inspection.request.translation.length))
        throw new Error('A residue lies beyond this protein sequence.');
      const finite = values.flatMap((point) => (point.value === null ? [] : [point.value]));
      if (!finite.length) throw new Error('Supply at least one measured value.');
      const min = Math.min(...finite),
        max = Math.max(...finite);
      const domain = [
        low ? Number(low) : min === max ? min - 0.5 : min,
        high ? Number(high) : min === max ? max + 0.5 : max,
      ];
      const measurement = residueMeasurementSchema.parse({
        id: crypto.randomUUID(),
        name,
        proteinSequenceSha256: sha256Hex(inspection.request.translation),
        source: {
          label: source,
          analysisId:
            inspection.request.variantContext?.trackId ?? inspection.request.entityId ?? 'import',
          revision: `sha256:${sha256Hex(text)}`,
        },
        units: counts ? 'log2 enrichment' : units,
        values,
        scale: {
          transform,
          domain,
          colors: customColors.trim()
            ? customColors.split(',').map((color) => color.trim())
            : MEASUREMENT_PALETTES[palette],
          missingColor: '#9ca3af',
        },
        ...(counts
          ? {
              derivation: {
                kind: 'log2-enrichment',
                normalization: 'table-total',
                pseudocount: Number(pseudocount),
                counts,
              },
            }
          : {}),
      });
      await apply(measurement);
    } catch (error) {
      setMessage(
        toUserMessage(error instanceof Error ? error.message : String(error), 'structure.failed')
      );
    }
  };
  return (
    <section className="border-b border-border px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        {hasMeasurements && (
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-fg-muted">Color by</span>
            <MolecularVariationPicker
              label="Saved measurements"
              activeId={activeId}
              variations={variations}
              disabled={busy || !ready}
              onSelect={(id) => void selectVariation(id)}
            />
          </label>
        )}
        <button
          type="button"
          aria-label={hasMeasurements ? 'Add measurement' : 'Color by measurement'}
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded border border-border px-2 py-1 text-fg-muted"
        >
          {hasMeasurements ? 'Add' : 'Color by measurement'}
        </button>
      </div>
      <div
        hidden={!open}
        id={formId}
        className="max-h-[40vh] overflow-y-auto"
        data-testid="inspection-measurements"
      >
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label>
            Name
            <input
              aria-label="Measurement name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="block w-full border border-border bg-bg p-1"
            />
          </label>
          <label>
            Source
            <input
              aria-label="Measurement source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="block w-full border border-border bg-bg p-1"
            />
          </label>
          <label>
            Input
            <select
              aria-label="Measurement input"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                if (event.target.value === 'enrichment') setPalette('diverging');
              }}
              className="block w-full bg-bg"
            >
              <option value="values">Residue values</option>
              <option value="enrichment">Before/after counts → enrichment</option>
            </select>
          </label>
          <label>
            {kind === 'enrichment' ? 'Pseudocount' : 'Units'}
            <input
              aria-label={kind === 'enrichment' ? 'Pseudocount' : 'Measurement units'}
              value={kind === 'enrichment' ? pseudocount : units}
              onChange={(event) =>
                kind === 'enrichment'
                  ? setPseudocount(event.target.value)
                  : setUnits(event.target.value)
              }
              className="block w-full border border-border bg-bg p-1"
            />
          </label>
        </div>
        <label className="mt-2 block">
          {kind === 'enrichment' ? 'residue,before,after' : 'residue,value'} (protein positions
          start at 1)
          <textarea
            aria-label="Residue measurements"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            className="block w-full border border-border bg-bg p-1 font-mono"
          />
        </label>
        <div className="my-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Measurement palette"
            value={palette}
            onChange={(event) => setPalette(event.target.value as typeof palette)}
            className="bg-bg"
          >
            {Object.keys(MEASUREMENT_PALETTES).map((key) => (
              <option key={key}>{key}</option>
            ))}
          </select>
          <select
            aria-label="Measurement scale"
            value={transform}
            onChange={(event) => setTransform(event.target.value as typeof transform)}
            className="bg-bg"
          >
            <option value="linear">Linear</option>
            <option value="log10">Log₁₀</option>
          </select>
          <input
            aria-label="Color minimum"
            placeholder="Auto min"
            value={low}
            onChange={(event) => setLow(event.target.value)}
            className="w-20 border border-border bg-bg p-1"
          />
          <input
            aria-label="Color maximum"
            placeholder="Auto max"
            value={high}
            onChange={(event) => setHigh(event.target.value)}
            className="w-20 border border-border bg-bg p-1"
          />
        </div>
        <label className="block">
          Custom palette (optional, comma-separated hex colors)
          <input
            aria-label="Custom measurement colors"
            value={customColors}
            onChange={(event) => setCustomColors(event.target.value)}
            placeholder="#2166ac,#f7f7f7,#b2182b"
            className="block w-full border border-border bg-bg p-1"
          />
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !ready}
          className="mt-2 rounded border border-border px-2 py-1"
        >
          {busy ? 'Applying…' : 'Apply measurement'}
        </button>
      </div>
      {message && (
        <div role="status" className="mt-2">
          {message}
        </div>
      )}
    </section>
  );
}
