import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
} from '@waypoint/domain-services';
import {
  unavailableInventoryClient,
  type InventoryAvailabilitySnapshot,
} from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryOpeningForm, InventoryValidityForm } from './InventoryValidityForms';
import { InventoryValidityPanel, useInventoryValidityRefresh } from './InventoryValidityPanel';
import { InventoryForm } from './InventoryForm';
import { InventoryReservationForm } from './InventoryReservationForm';
import { inventoryElapsedMilliseconds, inventoryValidityInstant } from './inventory-validity-view';
import { inventoryStockAction } from './inventory-view';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const at = 100000;
const policy: InventoryCommand = {
  kind: 'record-validity-decision',
  id: 'rule',
  owner: { kind: 'stock', stockId: 'stock' },
  rule: { kind: 'after-opening', openingStockId: 'stock', elapsedMs: 60000 },
  sourceText: 'Use within one elapsed minute of opening',
  sourcePrecision: 'elapsed-duration',
  source: null,
  reason: 'Explicit local interpretation',
};
const sealed: InventoryCommand = {
  kind: 'record-stock-opening',
  id: 'sealed',
  stockId: 'stock',
  value: 'sealed',
  observedAt: 90000,
  source: null,
  reason: 'Observed physically sealed',
};
function fixture(extra: readonly InventoryCommand[] = [], pinned = false) {
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-vessel',
          id: 'tube',
          name: 'Validity tube',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'tube',
          materialId: 'material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
        ...extra,
      ],
    },
    { at, principal, authority: principal }
  );
  if (!result.ok) throw new Error(result.message);
  const state = result.state;
  const scope = {
    projectId: 'project',
    inventoryId: 'inventory:project',
    revision: state.revision,
    principal,
  };
  const availability = {
    ...inventoryAvailability(state, principal, at),
    projectId: scope.projectId,
    inventoryId: scope.inventoryId,
    revision: state.revision,
    asOf: at,
    principal,
  } satisfies InventoryAvailabilitySnapshot;
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: scope.inventoryId,
      name: 'Owned project',
      path: '/synthetic',
      pinned,
    },
    state,
    history: [],
    availability,
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: at, freshnessMaxAgeMs: null }),
      ...scope,
    },
  };
  const client = unavailableInventoryClient();
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return {
    props: { data, status: { kind: 'ready' as const, data }, controller, client, onClose: vi.fn() },
    submit,
  };
}
const fill = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name, exact: true }), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
function choose(name: string, value: string) {
  fireEvent.click(screen.getByRole('combobox', { name, exact: true }));
  fireEvent.click(screen.getByRole('option', { name: value, exact: true }));
}
afterEach(() => vi.useRealTimers());

it('keeps printed month precision separate from the explicitly chosen UTC cutoff', async () => {
  const f = fixture();
  render(
    <InventoryValidityForm
      {...f.props}
      dialog={{ kind: 'validity', owner: { kind: 'stock', stockId: 'stock' } }}
    />
  );
  choose('Validity decision', 'Explicit cutoff instant');
  fill('Cutoff at (UTC)', '2026-11-30T18:30:00.000Z');
  fill('Original source text', 'EXP 2026-11');
  choose('Source precision', 'month');
  fill('Interpretation reason', 'Explicit supplier timezone interpretation');
  click('Record validity decision');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'record-validity-decision',
      rule: { kind: 'absolute', deadlineAt: Date.parse('2026-11-30T18:30:00.000Z') },
      sourceText: 'EXP 2026-11',
      sourcePrecision: 'month',
    }),
  ]);
});

it('parses whole elapsed days exactly and never offers calendar months or years', async () => {
  const f = fixture();
  render(
    <InventoryValidityForm
      {...f.props}
      dialog={{ kind: 'validity', owner: { kind: 'stock', stockId: 'stock' } }}
    />
  );
  choose('Validity decision', 'Elapsed time after first opening');
  fill('Elapsed duration', '2');
  fireEvent.click(screen.getByRole('combobox', { name: 'Elapsed unit' }));
  expect(screen.queryByRole('option', { name: /Months|Years/ })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Days (24 hours each)' }));
  fill('Interpretation reason', 'Two exact elapsed days');
  click('Record validity decision');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      rule: { kind: 'after-opening', openingStockId: 'stock', elapsedMs: 172800000 },
    }),
  ]);
});

it('distinguishes an observed opening with unknown time from unobserved opening status', async () => {
  const f = fixture();
  render(<InventoryOpeningForm {...f.props} dialog={{ kind: 'opening', stockId: 'stock' }} />);
  choose('Opening observation', 'Observed opened');
  fill('Reason', 'Already open; first-opening time unestablished');
  click('Record opening');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({ kind: 'record-stock-opening', value: 'opened', observedAt: null }),
  ]);
});

it('corrects to unknown status with the exact predecessor and never permits resealing', async () => {
  const f = fixture([sealed]);
  render(
    <InventoryOpeningForm
      {...f.props}
      dialog={{ kind: 'opening', stockId: 'stock', supersedesId: 'sealed' }}
    />
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Opening observation' }));
  expect(screen.queryByRole('option', { name: 'Observed sealed' })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Opening status is unknown' }));
  expect(screen.queryByRole('combobox', { name: 'Observation time' })).toBeNull();
  fill('Reason', 'Previous status report was unreliable');
  click('Correct opening');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'correct-stock-opening',
      supersedesId: 'sealed',
      value: 'unobserved',
      observedAt: null,
    }),
  ]);
});

it('uses native reserve and withdraw admissions separately for sealed relative-policy stock', () => {
  const f = fixture([policy, sealed]);
  const reservation = render(
    <InventoryReservationForm
      {...f.props}
      dialog={{ kind: 'reserve-quantity', stockId: 'stock' }}
    />
  );
  expect(screen.getByRole('button', { name: 'Reserve quantity', exact: true })).toBeEnabled();
  reservation.unmount();
  render(
    <InventoryForm {...f.props} dialog={{ kind: 'use', stockId: 'stock' }} onMaterial={vi.fn()} />
  );
  expect(screen.getByRole('button', { name: 'Use stock', exact: true })).toBeDisabled();
  expect(screen.getByText('Record first opening before withdrawing this stock')).toBeVisible();
});

it('refuses stale or different-project native action snapshots', () => {
  const f = fixture([policy, sealed]);
  expect(inventoryStockAction(f.props.data, 'stock', 'reserve')?.kind).toBe('allowed');
  const snapshot = f.props.data.availability!;
  f.props.data.availability = { ...snapshot, revision: snapshot.revision - 1 };
  expect(inventoryStockAction(f.props.data, 'stock', 'reserve')).toBeUndefined();
  f.props.data.availability = { ...snapshot, projectId: 'other-project' };
  expect(inventoryStockAction(f.props.data, 'stock', 'reserve')).toBeUndefined();
});

it('pins a policy correction to the exact current head and retains original source evidence', async () => {
  const f = fixture([policy]);
  render(<InventoryValidityForm {...f.props} dialog={{ kind: 'validity', headId: 'rule' }} />);
  expect(screen.getByRole('textbox', { name: 'Original source text' })).toHaveValue(
    'Use within one elapsed minute of opening'
  );
  choose('Validity decision', 'Unresolved interpretation');
  fill('Interpretation reason', 'Interpretation is no longer supported');
  click('Correct validity rule');
  await waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(f.submit.mock.calls[0][0]).toEqual([
    expect.objectContaining({
      kind: 'correct-validity-decision',
      supersedesId: 'rule',
      rule: { kind: 'unresolved' },
      sourcePrecision: 'elapsed-duration',
    }),
  ]);
});

it('permits read-only owner inspection without decision controls', () => {
  const f = fixture([policy], true);
  render(
    <InventoryValidityForm
      {...f.props}
      dialog={{ kind: 'validity', owner: { kind: 'stock', stockId: 'stock' } }}
    />
  );
  expect(screen.getByText('Existing rule families (1)')).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Validity decision' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Record validity decision', exact: true })
  ).toBeNull();
});

it('displays corrected unknown status with its retained observation id and native asOf', () => {
  const f = fixture([
    sealed,
    {
      kind: 'correct-stock-opening',
      id: 'corrected',
      stockId: 'stock',
      supersedesId: 'sealed',
      value: 'unobserved',
      observedAt: null,
      source: null,
      reason: 'Retracted status claim',
    },
  ]);
  render(
    <InventoryValidityPanel
      data={f.props.data}
      controller={f.props.controller}
      stockId="stock"
      editable={false}
      onDialog={vi.fn()}
    />
  );
  expect(screen.getByText('Opening status unknown after correction')).toBeVisible();
  expect(screen.getByText('Opening observation: corrected')).toBeVisible();
  expect(screen.getByText('Native observation time: 1970-01-01T00:01:40.000Z')).toBeVisible();
});

it('schedules only a native refresh from nextBoundaryAt minus native asOf', async () => {
  const f = fixture([
    {
      kind: 'record-validity-decision',
      id: 'cutoff',
      owner: { kind: 'stock', stockId: 'stock' },
      rule: { kind: 'absolute', deadlineAt: at + 1000 },
      sourceText: '',
      sourcePrecision: 'instant',
      source: null,
      reason: 'Exact local cutoff',
    },
  ]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
  const refresh = vi.spyOn(f.props.controller, 'refresh').mockResolvedValue();
  function Timer() {
    useInventoryValidityRefresh(f.props.data, f.props.controller);
    return null;
  }
  const view = render(<Timer />);
  await act(async () => {
    vi.advanceTimersByTime(999);
  });
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(f.submit).not.toHaveBeenCalled();
  view.unmount();
});

it('bounds exact duration and UTC input without calendar or floating point coercion', () => {
  expect(inventoryElapsedMilliseconds('9007199254740991', 'millisecond')).toBe(9007199254740991);
  for (const value of ['0', '1.5', '1e3', '-1', '9007199254740992'])
    expect(() => inventoryElapsedMilliseconds(value, 'second')).toThrow();
  expect(() => inventoryValidityInstant('2026-11')).toThrow();
  expect(() => inventoryValidityInstant('2026-11-16')).toThrow();
});
