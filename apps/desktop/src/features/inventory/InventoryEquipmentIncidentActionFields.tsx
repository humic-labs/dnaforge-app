import type { ReactNode } from 'react';
import { Button, Notice, TextArea, TextField, UI_FIELD_CLASS } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import { destinationPositions, locationPath } from './inventory-view';
import type { EquipmentIncidentFollowUpDraft } from './inventory-equipment-incident-action-draft';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export function InventoryEquipmentIncidentActionFields({
  draft,
  onChange,
  data,
}: {
  draft: EquipmentIncidentFollowUpDraft;
  onChange(draft: EquipmentIncidentFollowUpDraft): void;
  data?: InventoryData;
}) {
  switch (draft.kind) {
    case 'manual-temperature':
      return (
        <>
          <Notice>
            Record a manual observation. It does not establish a sensor feed, current chamber
            temperature or sample suitability. The installed arrangement is retained at recording
            time.
          </Notice>
          {draft.supersedes ? (
            <p>
              This action explicitly replaces the selected earlier reading. Its original record
              remains retained.
            </p>
          ) : (
            <p>This is an independent observation. Other observations remain separate.</p>
          )}
          {draft.readingKind === 'withdrawn' ? (
            <p>
              The selected manual reading will be withdrawn. No replacement temperature is asserted.
            </p>
          ) : (
            <>
              <Field label="Measured temperature (°C)">
                <TextField
                  aria-label="Measured temperature (°C)"
                  value={draft.temperature}
                  onChange={(e) => onChange({ ...draft, temperature: e.target.value })}
                />
              </Field>
              <Field label="Temperature observed at (UTC)">
                <TextField
                  aria-label="Temperature observed at (UTC)"
                  placeholder="2026-11-18T12:34:56.000Z"
                  value={draft.observedTime}
                  onChange={(e) => onChange({ ...draft, observedTime: e.target.value })}
                />
              </Field>
              <Field label="Measurement point">
                <TextField
                  aria-label="Measurement point"
                  value={draft.pointLabel}
                  onChange={(e) => onChange({ ...draft, pointLabel: e.target.value })}
                />
              </Field>
            </>
          )}
        </>
      );
    case 'completed-relocation': {
      const holders = data
        ? [
            ...Object.values(data.state.storage)
              .filter((x) => x.lifecycle === 'active')
              .map((x) => ({ item: { kind: 'storage' as const, id: x.id }, name: x.name })),
            ...Object.values(data.state.vessels)
              .filter((x) => x.lifecycle === 'active' && x.kind === 'movable')
              .map((x) => ({ item: { kind: 'vessel' as const, id: x.id }, name: x.name })),
          ]
        : [];
      return (
        <>
          <Notice>
            Report only whole holders whose relocation has already been completed. Every selected
            move is recorded together. Partial or uncertain physical work needs custody or
            reconciliation instead. Normal custody, fit, reservation and stacking rules still apply.
          </Notice>
          {!data ? (
            <Notice>
              Current holder and destination choices are unavailable. Original records remain
              readable.
            </Notice>
          ) : null}
          {draft.corrects ? (
            <p>
              This explicitly corrects the selected relocation fact; it records the actual completed
              moves below.
            </p>
          ) : null}
          {draft.moves.map((move, index) => {
            const label = `Relocation ${index + 1}`;
            const replace = (value: typeof move) =>
              onChange({
                ...draft,
                moves: draft.moves.map((old, i) => (i === index ? value : old)),
              });
            const destinations = data
              ? Object.values(data.state.storage).filter(
                  (x) =>
                    x.lifecycle === 'active' &&
                    x.id !== move.item?.id &&
                    x.layout.kind !== 'fixed-well'
                )
              : [];
            const selected =
              move.destination?.kind === 'located'
                ? move.destination.storageId
                : move.destination?.kind === 'stack-top'
                  ? move.destination.stackId
                  : move.destination
                    ? '__outside__'
                    : '';
            const storage = data?.state.storage[selected];
            const positions =
              data && storage ? destinationPositions(data.state, storage, move.item?.id) : [];
            return (
              <fieldset
                className="space-y-3 rounded border border-border p-3"
                key={index}
                data-testid="equipment-incident-relocation"
                data-move-index={index}
              >
                <legend>{label}</legend>
                <Field label={`${label} whole holder`}>
                  <select
                    className={UI_FIELD_CLASS}
                    aria-label={`${label} whole holder`}
                    value={move.item ? JSON.stringify(move.item) : ''}
                    onChange={(e) =>
                      replace({
                        item: e.target.value ? JSON.parse(e.target.value) : null,
                        destination: null,
                      })
                    }
                  >
                    <option value="">Choose a whole holder</option>
                    {holders.map((x) => (
                      <option key={JSON.stringify(x.item)} value={JSON.stringify(x.item)}>
                        {x.name} · {x.item.kind === 'storage' ? 'storage holder' : 'movable vessel'}
                        {data ? ` · ${locationPath(data.state, x.item.id)}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`${label} completed destination`}>
                  <select
                    className={UI_FIELD_CLASS}
                    aria-label={`${label} completed destination`}
                    disabled={!move.item}
                    value={selected}
                    onChange={(e) => {
                      const id = e.target.value,
                        target = data?.state.storage[id];
                      replace({
                        ...move,
                        destination:
                          id === '__outside__'
                            ? move.item?.kind === 'storage'
                              ? { kind: 'root' }
                              : { kind: 'unplaced' }
                            : target
                              ? target.layout.kind === 'stack'
                                ? { kind: 'stack-top', stackId: id }
                                : { kind: 'located', storageId: id, slotId: '' }
                              : null,
                      });
                    }}
                  >
                    <option value="">Choose the completed destination</option>
                    <option value="__outside__">
                      {move.item?.kind === 'storage' ? 'Top-level location' : 'Unplaced vessel'}
                    </option>
                    {destinations.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {move.destination?.kind === 'located' ? (
                  <Field label={`${label} completed position`}>
                    <select
                      className={UI_FIELD_CLASS}
                      aria-label={`${label} completed position`}
                      value={move.destination.slotId}
                      onChange={(e) =>
                        replace({
                          ...move,
                          destination: {
                            kind: 'located',
                            storageId:
                              move.destination?.kind === 'located'
                                ? move.destination.storageId
                                : '',
                            slotId: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="">Choose a position</option>
                      {positions.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <Button
                  disabled={draft.moves.length === 1}
                  onClick={() =>
                    onChange({ ...draft, moves: draft.moves.filter((_, i) => i !== index) })
                  }
                >
                  Remove relocation {index + 1}
                </Button>
              </fieldset>
            );
          })}
          <Button
            disabled={draft.moves.length >= 256}
            onClick={() =>
              onChange({ ...draft, moves: [...draft.moves, { item: null, destination: null }] })
            }
          >
            Add whole-holder relocation
          </Button>
        </>
      );
    }
    case 'impact-review':
      return (
        <>
          <p>
            {draft.subjects.length} exact review obligation{draft.subjects.length === 1 ? '' : 's'}{' '}
            selected. Previous review decisions remain retained; this review supersedes only the
            selected current decisions.
          </p>
          <Notice>
            Choose the decision for THIS incident restriction. Removing it does not release stock
            quality, batch assessment, validity or any other restriction. Later decisions also apply
            to material carrying these obligations.
          </Notice>
          <Field label="Incident restriction decision">
            <select
              className={UI_FIELD_CLASS}
              aria-label="Incident restriction decision"
              value={draft.disposition}
              onChange={(e) =>
                onChange({ ...draft, disposition: e.target.value as typeof draft.disposition })
              }
            >
              <option value="">Choose a decision</option>
              <option value="keep-incident-restriction">Keep this incident restriction</option>
              <option value="remove-incident-restriction">Remove this incident restriction</option>
            </select>
          </Field>
          <Field label="Basis for impact review">
            <TextArea
              aria-label="Basis for impact review"
              value={draft.basis}
              onChange={(e) => onChange({ ...draft, basis: e.target.value })}
            />
          </Field>
        </>
      );
    case 'resolve':
      return (
        <>
          <Notice>
            Resolving the equipment occurrence does not remove subject restrictions or release stock
            quality or batch assessment. Review decisions and manual follow-ups remain available
            afterward.
          </Notice>
          <Field label="Equipment resolution">
            <select
              className={UI_FIELD_CLASS}
              aria-label="Equipment resolution"
              value={draft.resolution}
              onChange={(e) =>
                onChange({ ...draft, resolution: e.target.value as typeof draft.resolution })
              }
            >
              <option value="">Choose the reported resolution</option>
              <option value="reported-resolved">Equipment reported resolved</option>
              <option value="reported-in-error">Original outage reported in error</option>
            </select>
          </Field>
        </>
      );
  }
}
