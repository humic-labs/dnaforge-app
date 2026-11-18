import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  applyInventoryOrganizationAction,
  organizationInventoryActionSha256,
  organizationInventoryPlanDigest,
  organizationInventoryStateSha256,
  organizationInventoryRequestSha256,
  ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
  ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
  type InventoryOrganizationTarget,
} from '@waypoint/domain-services';
import { organizationBootstrap } from '../../../../../packages/core/domain-services/src/inventory-organization.fixtures';
import type { DesktopAuthState } from '../../shared/auth-types';
import type {
  InventoryOrganizationBinding,
  InventoryOrganizationPreviewRequest,
  InventoryOrganizationPreviewRead,
  InventoryOrganizationActionAttemptRead,
} from '../../shared/inventory-organization-client';

const h = vi.hoisted(() => ({
  auth: { status: 'signed-out' } as DesktopAuthState,
  listeners: new Set<() => void>(),
  listOrganizations: vi.fn(),
  directory: vi.fn(),
  snapshot: vi.fn(),
  preview: vi.fn(),
  cancel: vi.fn(),
  submit: vi.fn(),
  attempt: vi.fn(),
  recover: vi.fn(),
  execute: vi.fn(),
  projects: vi.fn(),
}));
vi.mock('../../stores/auth-store', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAuthStore: (select: (value: { state: DesktopAuthState }) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          h.listeners.add(listener);
          return () => {
            h.listeners.delete(listener);
          };
        },
        () => select({ state: h.auth })
      ),
  };
});
vi.mock('../../platform', () => ({
  platform: () => ({
    cloudSync: { listOrganizations: h.listOrganizations },
    inventory: {
      organizationDirectory: h.directory,
      organizationSnapshot: h.snapshot,
      organizationPreview: h.preview,
      organizationCancelPreview: h.cancel,
      organizationSubmit: h.submit,
      organizationAttempt: h.attempt,
      organizationRecover: h.recover,
      execute: h.execute,
      projects: h.projects,
    },
  }),
}));

import { InventoryOrganizationPanel } from './InventoryOrganizationPanel';

const accountId = '11111111-1111-4111-8111-111111111111';
const desktopSessionId = '22222222-2222-4222-8222-222222222222';
const orgId = '33333333-3333-4333-8333-333333333333';
const inventoryId = '44444444-4444-4444-8444-444444444444';
const secondId = '55555555-5555-4555-8555-555555555555';
const target = { kind: 'organization-inventory' as const, orgId, inventoryId };
const identity = { accountId, desktopSessionId, knownAccessTokenExpiresAt: Date.now() + 3600000 };
function fixture(selected: InventoryOrganizationTarget = target, vesselName = 'Shared tube') {
  if (organizationBootstrap.kind !== 'bootstrap') throw Error('Expected bootstrap fixture.');
  const action = {
    ...organizationBootstrap,
    vessels: organizationBootstrap.vessels.map((vessel) => ({ ...vessel, name: vesselName })),
  };
  const recorded = applyInventoryOrganizationAction(null, {
    target: selected,
    expectedRevision: 0,
    action,
    admittedMaterialIds: ['material'],
    context: {
      at: 1000,
      principal: { kind: 'organization-account', orgId, accountId },
      authority: { ...selected, accountId },
    },
  });
  if (!recorded.ok) throw Error(recorded.message);
  const state = recorded.state;
  const binding: InventoryOrganizationBinding = {
    ...identity,
    target: selected,
    accessGeneration: 'generation-a',
    bindingEpoch: `binding-${selected.inventoryId}`,
  };
  const header = {
    accountId,
    target: selected,
    permission: 'operate' as const,
    canBootstrap: false,
    accessGeneration: binding.accessGeneration,
    accessEpoch: 1,
    revision: state.revision,
    stateSha256: organizationInventoryStateSha256(state),
    asOf: 1000,
  };
  return {
    state,
    binding,
    header,
    read: {
      kind: 'current' as const,
      binding,
      snapshot: { kind: 'ready' as const, header, state },
    },
  };
}
const first = fixture();
const second = fixture({ ...target, inventoryId: secondId }, 'Second tube');
function previewRead(
  request: InventoryOrganizationPreviewRequest
): InventoryOrganizationPreviewRead {
  const source = request.binding.target.inventoryId === secondId ? second : first;
  const at = Date.now();
  const applied = applyInventoryOrganizationAction(source.state, {
    target: source.binding.target,
    expectedRevision: source.state.revision,
    action: request.request.action,
    admittedMaterialIds: [],
    context: {
      at,
      principal: { kind: 'organization-account', orgId, accountId },
      authority: { ...source.binding.target, accountId },
    },
  });
  if (!applied.ok) throw Error(applied.message);
  return {
    kind: 'ready',
    previewHandleId: `66666666-6666-4666-8666-${String(h.preview.mock.calls.length).padStart(12, '0')}`,
    binding: source.binding,
    preview: {
      kind: 'ready',
      header: source.header,
      actionSha256: organizationInventoryActionSha256(request.request),
      planDigest: organizationInventoryPlanDigest({
        ...request.request,
        beforeStateSha256: source.header.stateSha256,
        materialAdmission: [],
      }),
      evaluatedAt: at,
      readyUntilExclusive: at + 5000,
      nextBoundaryAt: null,
      proposed: {
        state: applied.state,
        stateSha256: organizationInventoryStateSha256(applied.state),
      },
    },
  };
}
async function choose(label: string, option: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: label }));
  });
  const selected = await screen.findByRole('option', { name: option });
  await act(async () => {
    fireEvent.click(selected);
  });
}
async function openInventory(name = 'Shared freezer') {
  await act(async () => {
    render(<InventoryOrganizationPanel />);
  });
  await waitFor(() => expect(h.listOrganizations).toHaveBeenCalled());
  await choose('Inventory organization', 'Example lab');
  await waitFor(() => expect(h.directory).toHaveBeenCalled());
  await choose('Organization inventory', name);
}
async function fillUse() {
  await screen.findByText('Shared tube', { selector: 'h3' });
  await choose('Stock to preview', 'Shared tube · 10 µL');
  fireEvent.change(screen.getByLabelText('Amount to use (µL)'), { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('Reason for use'), {
    target: { value: 'Preview an actual planned use' },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.auth = {
    status: 'signed-in',
    session: {
      accountId,
      desktopSessionId,
      email: 'operator@example.com',
      channel: 'dev',
      accessTokenExpiresAt: new Date(identity.knownAccessTokenExpiresAt).toISOString(),
    },
  };
  h.listOrganizations.mockResolvedValue({
    ok: true,
    organizations: [
      {
        orgId,
        displayName: 'Example lab',
        role: 'admin',
        slug: 'lab',
        isAdministrator: true,
        canCreateManagedProjects: true,
      },
    ],
  });
  h.directory.mockResolvedValue({
    kind: 'ready',
    session: identity,
    directory: {
      kind: 'ready',
      accountId,
      orgId,
      canCreate: false,
      asOf: 1000,
      entries: [
        { name: 'Shared freezer', header: first.header },
        { name: 'Second freezer', header: second.header },
      ],
    },
  });
  h.snapshot.mockImplementation(async (request) =>
    request.target.inventoryId === secondId ? second.read : first.read
  );
  h.preview.mockImplementation(async (request) => previewRead(request));
  h.attempt.mockImplementation(async (request) => ({
    kind: 'none',
    session: identity,
    target: request.target,
  }));
  h.cancel.mockImplementation(async (request) => ({
    kind: 'cancelled',
    session: identity,
    target: request.target,
    previewHandleId: request.previewHandleId,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.listeners.clear();
});

it('shows complete confirmed stock without a local project and keeps proposed use separate through edit and Close', async () => {
  await openInventory();
  await fillUse();
  expect(screen.getByText('Confirmed quantity: 10 µL')).toBeTruthy();
  expect(screen.getByText('Rack / A')).toBeTruthy();
  expect(screen.getByText('Confirmed history revision 1')).toBeTruthy();
  expect(screen.getByText('Permission: Operate inventory')).toBeTruthy();
  expect(screen.getByText('Account: operator@example.com')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  await screen.findByText('Proposed remaining quantity: 3 µL');
  expect(h.preview.mock.calls[0][0].request.action).toEqual({
    kind: 'consume',
    stockId: 'stock',
    quantity: { value: '7', unit: 'uL' },
    reason: 'Preview an actual planned use',
  });
  expect(screen.getByText('Confirmed quantity: 10 µL')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Amount to use (µL)'), { target: { value: '6' } });
  expect(screen.queryByTestId('organization-inventory-proposed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  await screen.findByText('Proposed remaining quantity: 4 µL');
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByTestId('organization-inventory-proposed')).toBeNull();
  expect(screen.getByText('Confirmed quantity: 10 µL')).toBeTruthy();
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.projects).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add lot' })).toBeNull();
});

it('hides the old account session immediately and ignores its late preview', async () => {
  let finish!: (read: InventoryOrganizationPreviewRead) => void;
  h.preview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await openInventory();
  await fillUse();
  fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  const oldRequest = h.preview.mock.calls[0][0];
  await act(async () => {
    if (h.auth.status !== 'signed-in') throw Error('Signed-in fixture required.');
    h.auth = { ...h.auth, session: { ...h.auth.session, desktopSessionId: secondId } };
    for (const listener of h.listeners) listener();
  });
  expect(screen.queryByText('Shared tube', { selector: 'h3' })).toBeNull();
  expect(screen.queryByLabelText('Reason for use')).toBeNull();
  await act(async () => {
    finish(previewRead(oldRequest));
  });
  expect(screen.queryByTestId('organization-inventory-proposed')).toBeNull();
  expect(h.execute).not.toHaveBeenCalled();
});

it('ignores a late snapshot after selecting a different inventory', async () => {
  let finish!: (read: typeof first.read) => void;
  h.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await openInventory();
  await waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(1));
  await choose('Organization inventory', 'Second freezer');
  await screen.findByText('Second tube', { selector: 'h3' });
  await act(async () => {
    finish(first.read);
  });
  expect(screen.queryByText('Shared tube', { selector: 'h3' })).toBeNull();
  expect(screen.getByText('Second tube', { selector: 'h3' })).toBeTruthy();
});

it.each(['offline', 'read-only'] as const)(
  'keeps %s inventory read only regardless of organization admin role',
  async (mode) => {
    h.snapshot.mockResolvedValueOnce(
      mode === 'offline'
        ? {
            ...first.read,
            kind: 'cached-offline',
            failure: {
              kind: 'unavailable',
              code: 'NETWORK',
              message: 'Connection unavailable.',
              retryable: true,
            },
          }
        : {
            ...first.read,
            snapshot: { ...first.read.snapshot, header: { ...first.header, permission: 'read' } },
          }
    );
    await openInventory();
    await screen.findByText('Shared tube', { selector: 'h3' });
    if (mode === 'offline') expect(screen.getByText(/Last confirmed inventory/)).toBeTruthy();
    else expect(screen.getByText('Permission: Read only')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview use' }).hasAttribute('disabled')).toBe(true);
    expect(h.preview).not.toHaveBeenCalled();
  }
);

it('removes the candidate at its pre-request monotonic deadline', async () => {
  await openInventory();
  await fillUse();
  let monotonic = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  });
  expect(screen.getByTestId('organization-inventory-proposed')).toBeTruthy();
  monotonic += 5001;
  act(() => {
    vi.advanceTimersByTime(5001);
  });
  expect(screen.queryByTestId('organization-inventory-proposed')).toBeNull();
  expect(screen.getByText(/This preview expired/)).toBeTruthy();
  expect(screen.getByText('Confirmed quantity: 10 µL')).toBeTruthy();
});

function recordedReport(input: InventoryOrganizationPreviewRequest) {
  const ready = previewRead(input);
  if (ready.kind !== 'ready') throw Error('Ready fixture required.');
  const request = {
    schema: ORGANIZATION_INVENTORY_REQUEST_SCHEMA as typeof ORGANIZATION_INVENTORY_REQUEST_SCHEMA,
    purpose: 'action' as const,
    body: {
      ...input.request,
      operationId: 'original-use',
      clientId: 'original-desktop',
      expectedPlanDigest: ready.preview.planDigest,
    },
  };
  const attempt = {
    target: input.request.target,
    operationId: request.body.operationId,
    requestSha256: organizationInventoryRequestSha256(request),
    originalDesktopSessionId: desktopSessionId,
    createdAt: ready.preview.evaluatedAt,
    request,
  };
  const disposition = {
    schema:
      ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA as typeof ORGANIZATION_INVENTORY_DISPOSITION_SCHEMA,
    kind: 'action-accepted' as const,
    target: attempt.target,
    operationId: attempt.operationId,
    requestSha256: attempt.requestSha256,
    submitterAccountId: accountId,
    originClientId: request.body.clientId,
    baseRevision: input.request.expectedRevision,
    revision: input.request.expectedRevision + 1,
    recordedAt: ready.preview.evaluatedAt,
    acceptedAt: ready.preview.evaluatedAt + 1,
    stateSha256: ready.preview.proposed.stateSha256,
    accessGenerationAtDecision: request.body.accessGeneration,
    planDigest: ready.preview.planDigest,
  };
  const accepted: Extract<InventoryOrganizationActionAttemptRead, { kind: 'accepted' }> = {
    kind: 'accepted',
    session: identity,
    attempt,
    disposition,
    delivery: { kind: 'current', confirmedRevision: disposition.revision },
  };
  const state = ready.preview.proposed.state;
  const next = {
    kind: 'current' as const,
    binding: { ...first.binding, bindingEpoch: 'after-original-use' },
    snapshot: {
      kind: 'ready' as const,
      header: {
        ...first.header,
        revision: state.revision,
        stateSha256: disposition.stateSha256,
        asOf: disposition.acceptedAt,
      },
      state,
    },
  };
  return { attempt, accepted, next };
}
const originalUse: InventoryOrganizationPreviewRequest = {
  binding: first.binding,
  request: {
    target,
    expectedRevision: 1,
    accessGeneration: first.binding.accessGeneration,
    action: {
      kind: 'consume',
      stockId: 'stock',
      quantity: { value: '7', unit: 'uL' },
      reason: 'Original completed use',
    },
  },
};

it('records once and keeps accepted status separate from a failed inventory refresh', async () => {
  let reported: ReturnType<typeof recordedReport>;
  h.submit.mockImplementationOnce(async () => {
    reported = recordedReport(h.preview.mock.calls[0][0]);
    h.snapshot.mockRejectedValueOnce(Error('Read unavailable.'));
    return { ...reported.accepted, delivery: { kind: 'pending', failure: null } };
  });
  await openInventory();
  await fillUse();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  });
  const handle = screen
    .getByTestId('organization-inventory-proposed')
    .getAttribute('data-preview-handle-id');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record use' }));
  });
  expect(screen.getByRole('heading', { name: 'Use recorded' })).toBeTruthy();
  expect(screen.getByText('Inventory refresh pending. Do not record this use again.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Record use' })).toBeNull();
  expect(h.submit).toHaveBeenCalledExactlyOnceWith({
    expectedAccountId: accountId,
    expectedDesktopSessionId: desktopSessionId,
    target,
    previewHandleId: handle,
  });
  h.recover.mockImplementationOnce(async () => {
    h.snapshot.mockResolvedValueOnce(reported.next);
    return reported.accepted;
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh inventory' }).at(-1)!);
  });
  await screen.findByText('Confirmed quantity: 3 µL');
  expect(h.recover.mock.calls[0][0]).toMatchObject({
    mode: 'inspect',
    operationId: 'original-use',
    requestSha256: reported!.attempt.requestSha256,
  });
  expect(h.submit).toHaveBeenCalledTimes(1);
  expect(h.execute).not.toHaveBeenCalled();
});

it('retains an uncertain submission after local none and retries only the original handle', async () => {
  h.submit.mockRejectedValueOnce(Error('Reply unavailable.'));
  await openInventory();
  await fillUse();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Preview use' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record use' }));
  });
  expect(screen.getByRole('heading', { name: 'Outcome not confirmed' })).toBeTruthy();
  const original = h.submit.mock.calls[0][0];
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  });
  expect(screen.getByRole('heading', { name: 'Outcome not confirmed' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Record use' })).toBeNull();
  h.submit.mockImplementationOnce(async () => {
    const reported = recordedReport(h.preview.mock.calls[0][0]);
    h.snapshot.mockResolvedValueOnce(reported.next);
    return reported.accepted;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
  });
  await screen.findByText('Confirmed quantity: 3 µL');
  expect(h.submit.mock.calls[1][0]).toEqual(original);
  expect(h.preview).toHaveBeenCalledTimes(1);
});

it('discovers an unknown report without sending and checks its exact hosted operation', async () => {
  const reported = recordedReport(originalUse);
  h.attempt.mockResolvedValueOnce({
    kind: 'sent-unknown',
    session: identity,
    attempt: reported.attempt,
    failure: null,
  });
  h.recover.mockResolvedValueOnce({
    kind: 'sent-unknown',
    session: identity,
    attempt: reported.attempt,
    failure: null,
  });
  await openInventory();
  await screen.findByRole('heading', { name: 'Outcome not confirmed' });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.recover).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  });
  expect(h.recover.mock.calls[0][0]).toEqual({
    expectedAccountId: accountId,
    expectedDesktopSessionId: desktopSessionId,
    target,
    operationId: reported.attempt.operationId,
    requestSha256: reported.attempt.requestSha256,
    mode: 'inspect',
  });
  expect(screen.getByRole('heading', { name: 'Outcome not confirmed' })).toBeTruthy();
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
});

it('requires explicit confirmation of a retained never-sent report', async () => {
  const reported = recordedReport(originalUse);
  h.attempt.mockResolvedValueOnce({
    kind: 'never-sent',
    session: identity,
    attempt: reported.attempt,
    failure: null,
  });
  await openInventory();
  await screen.findByRole('heading', { name: 'Original report saved on this desktop' });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.recover).not.toHaveBeenCalled();
  h.recover.mockImplementationOnce(async () => {
    h.snapshot.mockResolvedValueOnce(reported.next);
    return reported.accepted;
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm original report' }));
  });
  await screen.findByText('Confirmed quantity: 3 µL');
  expect(h.recover.mock.calls[0][0]).toMatchObject({
    operationId: reported.attempt.operationId,
    requestSha256: reported.attempt.requestSha256,
    mode: 'confirm-unsent',
  });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
});
