import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  INVENTORY_CONCENTRATION_UNITS,
  type InventoryCompositionInput,
  type InventoryConcentration,
  type InventoryConcentrationInput,
  type InventoryConcentrationUnit,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import {
  PresentationScopeContext,
  usePresentationListener,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import type { InventoryClient, InventoryMaterial } from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { inventoryConcentrationLabel, inventoryConcentrationUnitLabel } from './inventory-view';
import { InventoryStatusNotice } from './InventoryStatusNotice';

export type InventoryCompositionDialog = { kind: 'composition'; stockId: string };

type Measurement =
  | { kind: 'preserved'; value: InventoryConcentration }
  | { kind: 'unknown' }
  | { kind: 'known'; value: string; unit: InventoryConcentrationUnit };

interface AnalyteRow {
  id: string;
  materialId: string;
  measurement: Measurement;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function InventoryCompositionForm({
  dialog,
  data,
  controller,
  status,
  client,
  materialNames,
  onMaterial,
  onClose,
}: {
  dialog: InventoryCompositionDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  client: InventoryClient;
  materialNames: Readonly<Record<string, string>>;
  onMaterial(id: string, name: string): void;
  onClose(): void;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const stock = data.state.stocks[dialog.stockId];
  const [kind, setKind] = useState<'unknown' | 'homogeneous'>(stock.composition.kind);
  const [rows, setRows] = useState<readonly AnalyteRow[]>(() =>
    stock.composition.kind === 'homogeneous'
      ? Object.entries(stock.composition.analytes).map(([materialId, value]) => ({
          id: crypto.randomUUID(),
          materialId,
          measurement: { kind: 'preserved', value },
        }))
      : [{ id: crypto.randomUUID(), materialId: '', measurement: { kind: 'unknown' } }]
  );
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [materialsError, setMaterialsError] = useState(false);
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const busy = status.kind === 'submitting';
  const editable = inventoryCanEdit(status);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    events.add(document, 'keydown', key);
    return () => events.remove(document, 'keydown', key);
  }, [events, busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (cancelled) return;
          setMaterials(page.items);
          setMaterialsError(false);
        })
        .catch(() => {
          if (!cancelled) setMaterialsError(true);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);

  function updateRow(id: string, update: Partial<AnalyteRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...update } : row)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (!editable) return;
    try {
      const analytes: Record<string, InventoryConcentrationInput> = Object.create(null);
      if (kind === 'homogeneous') {
        for (const row of rows) {
          if (!row.materialId) throw new Error('Choose a registered material for every analyte.');
          if (Object.hasOwn(analytes, row.materialId))
            throw new Error('Each analyte can appear only once.');
          analytes[row.materialId] =
            row.measurement.kind === 'preserved' ? row.measurement.value : row.measurement;
        }
      }
      const composition: InventoryCompositionInput =
        kind === 'unknown' ? { kind: 'unknown' } : { kind: 'homogeneous', analytes };
      if (
        await controller.submit(
          [{ kind: 'record-composition', stockId: stock.id, composition, reason: reason.trim() }],
          'Record composition'
        )
      )
        onClose();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Check the composition values.');
    }
  }

  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-composition-form-title"
          className="flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <div className="border-b border-border px-5 py-4">
            <h2 id="inventory-composition-form-title" className="text-lg font-semibold text-fg">
              Record composition
            </h2>
            <p className="mt-1 text-xs text-fg-muted">{data.state.vessels[stock.vesselId].name}</p>
          </div>
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {validation ? <Notice tone="error">{validation}</Notice> : null}
              <Field label="Composition">
                <Select
                  ariaLabel="Composition"
                  value={kind}
                  options={[
                    { value: 'unknown', label: 'Unknown' },
                    { value: 'homogeneous', label: 'Homogeneous' },
                  ]}
                  onValueChange={(value) => setKind(value as 'unknown' | 'homogeneous')}
                />
              </Field>
              {kind === 'unknown' ? (
                <Notice>
                  The whole composition is unknown. No analyte concentration is assumed.
                </Notice>
              ) : (
                <>
                  <Notice>
                    Record concentrations for evenly mixed contents. An unmeasured or omitted
                    analyte is unknown. Record an explicit zero for an absent analyte, including DNA
                    in water.
                  </Notice>
                  <Field label="Find analyte material">
                    <TextField
                      aria-label="Find analyte material"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </Field>
                  {materialsError ? (
                    <Notice tone="error">
                      Materials could not be loaded. Change the search to try again.
                    </Notice>
                  ) : null}
                  {rows.map((row, index) => (
                    <div key={row.id} className="space-y-3 rounded border border-border p-3">
                      <Field label={`Analyte ${index + 1}`}>
                        <Select
                          ariaLabel={`Analyte ${index + 1}`}
                          value={row.materialId}
                          options={[
                            { value: '', label: 'Choose a registered material' },
                            ...(row.materialId &&
                            !materials.some((item) => item.id === row.materialId)
                              ? [
                                  {
                                    value: row.materialId,
                                    label: materialNames[row.materialId] ?? row.materialId,
                                  },
                                ]
                              : []),
                            ...materials.map((item) => ({
                              value: item.id,
                              label: item.name,
                              description: item.registryId ?? item.kind,
                            })),
                          ]}
                          onValueChange={(materialId) => {
                            const material = materials.find((item) => item.id === materialId);
                            if (material) onMaterial(material.id, material.name);
                            updateRow(row.id, {
                              materialId,
                              measurement: { kind: 'unknown' },
                            });
                          }}
                        />
                      </Field>
                      {row.measurement.kind === 'preserved' ? (
                        <>
                          <p className="break-words text-sm tabular-nums">
                            {inventoryConcentrationLabel(row.measurement.value)}
                          </p>
                          <p className="text-xs text-fg-muted">
                            The recorded value will be preserved exactly.
                          </p>
                          <Button
                            onClick={() => updateRow(row.id, { measurement: { kind: 'unknown' } })}
                          >
                            Replace measurement {index + 1}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Field label={`Concentration status ${index + 1}`}>
                            <Select
                              ariaLabel={`Concentration status ${index + 1}`}
                              value={row.measurement.kind}
                              options={[
                                { value: 'unknown', label: 'Unmeasured' },
                                { value: 'known', label: 'Measured' },
                              ]}
                              onValueChange={(value) =>
                                updateRow(row.id, {
                                  measurement:
                                    value === 'known'
                                      ? { kind: 'known', value: '', unit: 'ng/uL' }
                                      : { kind: 'unknown' },
                                })
                              }
                            />
                          </Field>
                          {row.measurement.kind === 'known' ? (
                            <div className="grid grid-cols-2 gap-3">
                              <Field label={`Concentration ${index + 1}`}>
                                <TextField
                                  aria-label={`Concentration ${index + 1}`}
                                  inputMode="decimal"
                                  value={row.measurement.value}
                                  onChange={(event) => {
                                    if (row.measurement.kind === 'known')
                                      updateRow(row.id, {
                                        measurement: {
                                          ...row.measurement,
                                          value: event.target.value,
                                        },
                                      });
                                  }}
                                  required
                                />
                              </Field>
                              <Field label={`Concentration unit ${index + 1}`}>
                                <Select
                                  ariaLabel={`Concentration unit ${index + 1}`}
                                  value={row.measurement.unit}
                                  options={INVENTORY_CONCENTRATION_UNITS.map((unit) => ({
                                    value: unit,
                                    label: inventoryConcentrationUnitLabel(unit),
                                  }))}
                                  onValueChange={(unit) => {
                                    if (row.measurement.kind === 'known')
                                      updateRow(row.id, {
                                        measurement: {
                                          ...row.measurement,
                                          unit: unit as InventoryConcentrationUnit,
                                        },
                                      });
                                  }}
                                />
                              </Field>
                            </div>
                          ) : null}
                        </>
                      )}
                      <Button
                        onClick={() =>
                          setRows((current) => current.filter((item) => item.id !== row.id))
                        }
                      >
                        Remove analyte {index + 1}
                      </Button>
                    </div>
                  ))}
                  <Button
                    disabled={rows.length >= 256}
                    onClick={() =>
                      setRows((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          materialId: '',
                          measurement: { kind: 'unknown' },
                        },
                      ])
                    }
                  >
                    Add analyte
                  </Button>
                </>
              )}
              <Field label="Reason">
                <TextArea
                  aria-label="Reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!editable}>
                {busy ? 'Saving…' : 'Record composition'}
              </Button>
            </div>
          </form>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
