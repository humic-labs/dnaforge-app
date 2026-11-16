import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryStorageConditions } from './InventoryStorageConditions';
import { InventoryTemperatureForm } from './InventoryTemperatureForm';
import {
  inventoryObservationTime,
  inventoryTemperatureReasonLabel,
  type InventoryTemperatureDialog,
} from './inventory-temperature-view';

const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
const freezer = { kind: 'storage' as const, id: 'freezer' };
const tube = { kind: 'vessel' as const, id: 'tube' };
const range = (minimum: string, maximum: string) => ({
  minimum: { value: minimum, unit: 'C' as const },
  maximum: { value: maximum, unit: 'C' as const },
});
const fact = { observedAt: null, source: null, reason: 'Synthetic formulation evidence' };
const subject = { kind: 'installed' as const, item: freezer, configurationRevision: 0 };

function fixture(commands: InventoryCommand[] = [], pinned = false) {
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'freezer',
          name: 'Freezer',
          slots: ['A'],
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'tube',
          name: 'Tube',
          placement: { kind: 'located', storageId: 'freezer', slotId: 'A' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'tube',
          materialId: 'material',
          quality: 'usable',
          quantity: { kind: 'known', value: '10', unit: 'uL' },
        },
        ...commands,
      ],
    },
    { at: 100, principal, authority: principal }
  );
  if (!result.ok) throw new Error(result.message);
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Synthetic',
      path: '/synthetic',
      pinned,
    },
    state: result.state,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(result.state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: 'project',
      inventoryId: 'inventory',
      revision: result.state.revision,
      principal,
    },
  };
  const controller = new InventoryController(unavailableInventoryClient(), {
    read: () => [],
    write: () => {},
  });
  return { data, controller, status: { kind: 'ready' as const, data } };
}

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
}

function form(dialog: InventoryTemperatureDialog, commands: InventoryCommand[] = []) {
  const f = fixture(commands);
  const submit = vi.spyOn(f.controller, 'submit').mockResolvedValue(null);
  render(<InventoryTemperatureForm {...f} dialog={dialog} onClose={vi.fn()} />);
  return { ...f, submit };
}

describe('inventory storage temperature surface', () => {
  it('allows first facts on equipment with no temperature evidence', () => {
    const f = fixture();
    const onDialog = vi.fn();
    render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable
        onDialog={onDialog}
        onOpenItem={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Report setpoint' }));
    expect(onDialog).toHaveBeenCalledWith({ kind: 'temperature-setpoint', item: freezer });
    expect(screen.getByRole('button', { name: 'Record operating range' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record qualification' })).toBeEnabled();
    expect(screen.getByTestId('inventory-temperature-reported-target')).toHaveTextContent(
      'Unknown'
    );
  });

  it('renders three independent core assessments and retains incompatible stock without an action gate', () => {
    const f = fixture([
      { kind: 'record-thermal-context', item: freezer, value: { kind: 'self' }, ...fact },
      {
        kind: 'record-storage-requirement',
        target: { kind: 'stock', id: 'stock' },
        value: { kind: 'specified', range: range('-82', '-78') },
        ...fact,
      },
      {
        kind: 'record-equipment-setpoint',
        item: freezer,
        value: { kind: 'known', temperature: { value: '-80', unit: 'C' } },
        ...fact,
      },
      {
        kind: 'record-temperature-claim',
        id: 'specified',
        subject,
        assertion: { kind: 'specified-setpoint-range', range: range('-90', '-50') },
        ...fact,
      },
      {
        kind: 'record-temperature-claim',
        id: 'qualified',
        subject,
        assertion: {
          kind: 'qualified-envelope',
          scope: 'physical-and-thermal-arrangement',
          range: range('-85', '-75'),
          atSetpoint: { value: '-80', unit: 'C' },
          assumptions: 'Synthetic qualification only',
        },
        ...fact,
      },
    ]);
    const before = structuredClone(f.data.state);
    render(
      <InventoryStorageConditions
        {...f}
        item={tube}
        stockId="stock"
        editable
        onDialog={vi.fn()}
        onOpenItem={vi.fn()}
      />
    );
    expect(screen.getByTestId('inventory-temperature-assessment-capability')).toHaveAttribute(
      'data-assessment-state',
      'supported'
    );
    expect(screen.getByTestId('inventory-temperature-assessment-target')).toHaveAttribute(
      'data-assessment-state',
      'supported'
    );
    expect(screen.getByTestId('inventory-temperature-assessment-qualification')).toHaveAttribute(
      'data-assessment-state',
      'incompatible'
    );
    expect(screen.getByTestId('inventory-temperature-requirement')).toHaveTextContent(
      '-82 to -78 °C (inclusive)'
    );
    expect(screen.getByRole('button', { name: 'Record stock requirement' })).toBeEnabled();
    expect(f.data.state).toEqual(before);
    expect(f.data.state.stocks.stock.quality).toBe('usable');
    expect(f.data.state.stocks.stock.quantity).toEqual({ kind: 'known', value: '10', unit: 'uL' });
  });

  it('shows withdrawn evidence historically and disables mutations for read-only inspection', () => {
    const f = fixture(
      [
        {
          kind: 'record-temperature-claim',
          id: 'claim',
          subject,
          assertion: { kind: 'specified-setpoint-range', range: range('-90', '-50') },
          ...fact,
        },
        { kind: 'withdraw-temperature-claim', claimId: 'claim', reason: 'Source scope corrected' },
      ],
      true
    );
    const { container } = render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable={false}
        onDialog={vi.fn()}
        onOpenItem={vi.fn()}
      />
    );
    expect(container.querySelector('[data-claim-id="claim"]')).toHaveAttribute(
      'data-claim-lifecycle',
      'withdrawn'
    );
    expect(screen.getByText(/Source scope corrected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report setpoint' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Set temperature context' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Withdraw evidence' })).not.toBeInTheDocument();
  });

  it('does not infer its temperature relationship from evidence or a reported setpoint', () => {
    const f = fixture([
      {
        kind: 'record-equipment-setpoint',
        item: freezer,
        value: { kind: 'known', temperature: { value: '-80', unit: 'C' } },
        ...fact,
      },
      {
        kind: 'record-temperature-claim',
        id: 'claim',
        subject,
        assertion: { kind: 'specified-setpoint-range', range: range('-86', '-50') },
        ...fact,
      },
    ]);
    const onDialog = vi.fn();
    render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable
        onDialog={onDialog}
        onOpenItem={vi.fn()}
      />
    );
    expect(screen.getByTestId('inventory-temperature-context')).toHaveAttribute(
      'data-context-relationship',
      'inherit'
    );
    expect(screen.getByTestId('inventory-temperature-context')).toHaveTextContent(
      'Inherit surrounding conditions'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set temperature context' }));
    expect(onDialog).toHaveBeenCalledWith({ kind: 'temperature-context', item: freezer });
    expect(f.data.state.thermalContexts).toEqual({});
  });

  it('retains an explicitly controlled item after its only evidence is withdrawn', () => {
    const f = fixture([
      { kind: 'record-thermal-context', item: freezer, value: { kind: 'self' }, ...fact },
      {
        kind: 'record-temperature-claim',
        id: 'claim',
        subject,
        assertion: { kind: 'specified-setpoint-range', range: range('-86', '-50') },
        ...fact,
      },
      { kind: 'withdraw-temperature-claim', claimId: 'claim', reason: 'Source withdrawn' },
    ]);
    render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable
        onDialog={vi.fn()}
        onOpenItem={vi.fn()}
      />
    );
    expect(screen.getByTestId('inventory-temperature-context')).toHaveAttribute(
      'data-context-relationship',
      'self'
    );
    expect(screen.getByTestId('inventory-temperature-context')).toHaveTextContent(
      'Has its own temperature control'
    );
    expect(f.data.storageConditions.stocks.stock.environment).toEqual({
      kind: 'known',
      item: freezer,
    });
    expect(f.data.storageConditions.stocks.stock.capability.state).toBe('unknown');
  });

  it('explains a retained qualification with an unrecorded original temperature relationship', () => {
    const f = fixture([
      {
        kind: 'record-temperature-claim',
        id: 'legacy-qualification',
        subject,
        assertion: {
          kind: 'qualified-envelope',
          range: range('-81', '-79'),
          atSetpoint: { value: '-80', unit: 'C' },
          assumptions: 'Retained original qualification',
        },
        ...fact,
      },
    ]);
    render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable
        onDialog={vi.fn()}
        onOpenItem={vi.fn()}
      />
    );
    expect(
      screen.getByText(/temperature relationship was not recorded with this qualification/)
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Unrecorded in the original qualification/)).toHaveLength(2);
    expect(f.data.state.temperatureClaims['legacy-qualification'].assertion).not.toHaveProperty(
      'scope'
    );
  });

  it.each([
    ['Has its own temperature control', 'self'],
    ['Relationship unknown', 'unknown'],
    ['Inherit surrounding conditions', 'inherit'],
  ] as const)('records %s independently from temperature facts', (label, kind) => {
    const f = form({ kind: 'temperature-context', item: freezer });
    choose('Thermal relationship', label);
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Explicit control relationship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature context' }));
    expect(f.submit).toHaveBeenCalledWith(
      [
        {
          kind: 'record-thermal-context',
          item: freezer,
          value: { kind },
          observedAt: null,
          source: null,
          reason: 'Explicit control relationship',
        },
      ],
      'Record temperature context'
    );
    expect(f.data.state.equipmentSetpoints).toEqual({});
    expect(f.data.state.temperatureClaims).toEqual({});
  });

  it('keeps the saved relationship observation time when replacing that relationship', () => {
    const f = form({ kind: 'temperature-context', item: freezer }, [
      {
        kind: 'record-thermal-context',
        item: freezer,
        value: { kind: 'self' },
        ...fact,
        observedAt: 80,
      },
    ]);
    expect(screen.getByLabelText('Observation time (UTC)')).toHaveValue('1970-01-01T00:00:00.080Z');
    choose('Thermal relationship', 'Relationship unknown');
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Relationship correction' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature context' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      value: { kind: 'unknown' },
      observedAt: 80,
    });
  });

  it('uses an explicitly chosen age policy and makes no default live claim', () => {
    const f = fixture();
    const setPolicy = vi.spyOn(f.controller, 'setStorageFreshnessPolicy').mockResolvedValue();
    render(
      <InventoryStorageConditions
        {...f}
        item={freezer}
        editable
        onDialog={vi.fn()}
        onOpenItem={vi.fn()}
      />
    );
    expect(screen.getByTestId('inventory-temperature-freshness-policy')).toHaveTextContent(
      'none selected'
    );
    fireEvent.change(screen.getByLabelText('Maximum observation age (milliseconds)'), {
      target: { value: '60000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply age policy' }));
    expect(setPolicy).toHaveBeenLastCalledWith(60000);
    fireEvent.change(screen.getByLabelText('Maximum observation age (milliseconds)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply age policy' }));
    expect(setPolicy).toHaveBeenLastCalledWith(null);
  });

  it('records signed exact requirement text with an explicit unknown observation time', () => {
    const f = form({ kind: 'temperature-requirement', target: { kind: 'stock', id: 'stock' } });
    choose('Requirement setting', 'Specified temperature range');
    fireEvent.change(screen.getByLabelText('Minimum temperature (°C)'), {
      target: { value: '-82.2500' },
    });
    fireEvent.change(screen.getByLabelText('Maximum temperature (°C)'), {
      target: { value: '-78.1250' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Actual formulation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature requirement' }));
    expect(f.submit).toHaveBeenCalledWith(
      [
        {
          kind: 'record-storage-requirement',
          target: { kind: 'stock', id: 'stock' },
          value: { kind: 'specified', range: range('-82.2500', '-78.1250') },
          observedAt: null,
          source: null,
          reason: 'Actual formulation',
        },
      ],
      'Record temperature requirement'
    );
  });

  it('separates stock inheritance from an explicit unknown override', () => {
    const f = form({ kind: 'temperature-requirement', target: { kind: 'stock', id: 'stock' } });
    choose('Requirement setting', 'Explicitly unknown');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Not established' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature requirement' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      value: { kind: 'unknown' },
      observedAt: null,
    });
  });

  it('names the lot target explicitly and offers no inheritance setting for a lot', () => {
    const f = form({ kind: 'temperature-requirement', target: { kind: 'lot', id: 'lot' } }, [
      {
        kind: 'create-lot',
        id: 'lot',
        name: 'Actual preparation',
        materialId: 'material',
        origin: { kind: 'received', supplier: 'Synthetic supplier', lotNumber: '001' },
      },
    ]);
    expect(screen.getByText('Lot: Actual preparation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Requirement setting' }));
    expect(
      screen.queryByRole('option', { name: 'Inherit lot requirement' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Explicitly unknown' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'No accepted requirement' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature requirement' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      target: { kind: 'lot', id: 'lot' },
      value: { kind: 'unknown' },
      observedAt: null,
    });
  });

  it('records operating-range evidence with exact installed scope and source details', () => {
    const f = form({
      kind: 'temperature-claim',
      item: freezer,
      assertion: 'specified-setpoint-range',
    });
    fireEvent.change(screen.getByLabelText('Minimum temperature (°C)'), {
      target: { value: '-86.0' },
    });
    fireEvent.change(screen.getByLabelText('Maximum temperature (°C)'), {
      target: { value: '-50.0' },
    });
    fireEvent.change(screen.getByLabelText('Source title'), {
      target: { value: 'Exact model specification' },
    });
    fireEvent.change(screen.getByLabelText('Source URL'), {
      target: { value: 'https://example.org/model.pdf' },
    });
    fireEvent.change(screen.getByLabelText('Source page or section'), {
      target: { value: 'US model A, page 4' },
    });
    fireEvent.change(screen.getByLabelText('Source read date'), {
      target: { value: '2026-11-16' },
    });
    fireEvent.change(screen.getByLabelText('Source document revision'), {
      target: { value: 'Rev B' },
    });
    fireEvent.change(screen.getByLabelText('Source SHA-256 (optional)'), {
      target: { value: 'a'.repeat(64) },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Exact source scope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record specified operating range' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      kind: 'record-temperature-claim',
      subject,
      assertion: { kind: 'specified-setpoint-range', range: range('-86.0', '-50.0') },
      observedAt: null,
      source: {
        title: 'Exact model specification',
        locator: 'US model A, page 4',
        documentRevision: 'Rev B',
        sha256: 'a'.repeat(64),
      },
    });
  });

  it('withdraws a named immutable claim with a reason and no invented observation time', () => {
    const f = form({ kind: 'temperature-withdraw', claimId: 'claim' }, [
      {
        kind: 'record-temperature-claim',
        id: 'claim',
        subject,
        assertion: { kind: 'specified-setpoint-range', range: range('-90', '-50') },
        ...fact,
      },
    ]);
    expect(screen.getByTestId('inventory-temperature-withdrawal-subject')).toHaveTextContent(
      'Evidence ID: claim'
    );
    expect(
      screen.queryByRole('combobox', { name: 'Observation time knowledge' })
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Incorrect region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw temperature evidence' }));
    expect(f.submit).toHaveBeenCalledWith(
      [{ kind: 'withdraw-temperature-claim', claimId: 'claim', reason: 'Incorrect region' }],
      'Withdraw temperature evidence'
    );
  });

  it('uses the strict domain decoder to refuse reversed bounds before submitting', () => {
    const f = form({ kind: 'temperature-requirement', target: { kind: 'stock', id: 'stock' } });
    choose('Requirement setting', 'Specified temperature range');
    fireEvent.change(screen.getByLabelText('Minimum temperature (°C)'), {
      target: { value: '-70' },
    });
    fireEvent.change(screen.getByLabelText('Maximum temperature (°C)'), {
      target: { value: '-80' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Synthetic invalid range' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record temperature requirement' }));
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.getByText(/minimum cannot exceed/i)).toBeInTheDocument();
  });

  it('requires an explicit valid UTC observation time and never substitutes read time', () => {
    const f = form({ kind: 'temperature-setpoint', item: freezer });
    choose('Reported target knowledge', 'Known reported setpoint');
    fireEvent.change(screen.getByLabelText('Reported setpoint (°C)'), {
      target: { value: '-80.00' },
    });
    choose('Observation time knowledge', 'Known UTC timestamp');
    fireEvent.change(screen.getByLabelText('Observation time (UTC)'), {
      target: { value: '2026-02-30T12:00:00.000Z' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Operator report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report equipment setpoint' }));
    expect(f.submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Observation time (UTC)'), {
      target: { value: '2026-11-16T12:00:00.000Z' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Report equipment setpoint' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      observedAt: 1794830400000,
      value: { kind: 'known', temperature: { value: '-80.00', unit: 'C' } },
    });
  });

  it('pins an installed qualification and records assumptions separately from the reported target', () => {
    const f = form({ kind: 'temperature-claim', item: freezer, assertion: 'qualified-envelope' });
    expect(
      screen.queryByRole('combobox', { name: 'Evidence subject scope' })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('inventory-temperature-configuration')).toHaveTextContent(
      'Configuration revision 0'
    );
    fireEvent.click(screen.getByLabelText('Add a source reference'));
    fireEvent.change(screen.getByLabelText('Minimum temperature (°C)'), {
      target: { value: '-81' },
    });
    fireEvent.change(screen.getByLabelText('Maximum temperature (°C)'), {
      target: { value: '-79' },
    });
    fireEvent.change(screen.getByLabelText('Qualification setpoint (°C)'), {
      target: { value: '-80' },
    });
    fireEvent.change(screen.getByLabelText('Qualification assumptions'), {
      target: { value: 'Current installed rack arrangement' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Recorded physical qualification' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record installed qualification' }));
    expect(f.submit.mock.calls[0][0][0]).toMatchObject({
      kind: 'record-temperature-claim',
      subject,
      assertion: {
        kind: 'qualified-envelope',
        scope: 'physical-and-thermal-arrangement',
        range: range('-81', '-79'),
        atSetpoint: { value: '-80', unit: 'C' },
        assumptions: 'Current installed rack arrangement',
      },
      observedAt: null,
    });
  });
});

it('keeps observation time unknown independently of native snapshot time', () => {
  expect(inventoryObservationTime('unknown', '2026-11-16T12:00:00.000Z')).toBeNull();
  expect(() => inventoryObservationTime('known', '2026-02-30T12:00:00.000Z')).toThrow(
    'UTC observation time'
  );
});

it('explains report age and unknown relationship reasons in plain language', () => {
  expect(inventoryTemperatureReasonLabel('REPORT_NO_POLICY')).toBe(
    'No observation age policy selected'
  );
  expect(inventoryTemperatureReasonLabel('REPORT_TIME_UNKNOWN')).toBe(
    'Report observation time is unknown'
  );
  expect(inventoryTemperatureReasonLabel('REPORT_FUTURE_OBSERVATION')).toBe(
    'Report observation time is after this snapshot'
  );
  expect(inventoryTemperatureReasonLabel('REPORT_EXCEEDS_POLICY')).toBe(
    'Report is older than the selected observation age policy'
  );
  expect(inventoryTemperatureReasonLabel('ENVIRONMENT_THERMAL_CONTEXT_UNKNOWN')).toBe(
    'The temperature relationship is unknown'
  );
});
