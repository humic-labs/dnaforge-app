import { expect, it, vi } from 'vitest';
import { ScientificDesignSetupSession } from './scientific-design-setup-session';
const scope = { projectId: 'project', workspace: 'project', workspaceRoot: '/project' };
const head = `wv_${'a'.repeat(64)}`;
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const mutation = async <T>(_root: string, operation: (token?: string) => Promise<T>) => operation();
function fixture() {
  const client = {
    catalog: vi.fn().mockResolvedValue({ workspace: 'project', head: null, entries: [] }),
    submit: vi.fn(),
    reconcileProjections: vi.fn(),
  };
  const store = storage(),
    session = new ScientificDesignSetupSession(scope, client, store, mutation);
  return { client, store, session };
}
it('retains the exact setup request before submit and sends nothing when storage refuses', async () => {
  const client = fixture().client;
  const session = new ScientificDesignSetupSession(
    scope,
    client,
    {
      getItem: () => null,
      setItem: () => {
        throw Error('Storage unavailable');
      },
    },
    mutation
  );
  await session.setup();
  expect(client.submit).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe('unavailable');
  session.detach();
});
it('keeps a wrong-operation acknowledgement unknown and retries the original request', async () => {
  const { client, store, session } = fixture();
  client.submit.mockResolvedValue({
    operationId: 'another-operation',
    replayed: false,
    receipt: { outcome: 'changed', version: head },
    currentHead: head,
    delivery: { kind: 'complete' },
  });
  await session.setup();
  expect(session.getSnapshot().phase).toBe('unknown');
  const raw = store.getItem('dnaforge.scientific-design-setup.v1:project');
  const input = JSON.parse(raw!).input;
  expect(client.submit).toHaveBeenCalledWith(input);
  await session.retrySameSetup();
  expect(client.submit).toHaveBeenLastCalledWith(input);
  expect(store.getItem('dnaforge.scientific-design-setup.v1:project')).toBe(raw);
  session.detach();
});
it('does not treat a current catalog head as setup delivery or an automatic write', async () => {
  const { client, session } = fixture();
  client.catalog.mockResolvedValue({ workspace: 'project', head, entries: [] });
  await session.refresh();
  expect(session.getSnapshot().phase).toBe('accepted-unconfirmed');
  expect(client.submit).not.toHaveBeenCalled();
  expect(client.reconcileProjections).not.toHaveBeenCalled();
  client.reconcileProjections.mockResolvedValue({ head, projectedPaths: [], relationships: 0 });
  await session.reconcile();
  expect(session.getSnapshot().phase).toBe('ready');
  session.detach();
});
it('preserves accepted-but-pending knowledge when catalog readback fails after the receipt', async () => {
  const { client, session } = fixture();
  client.catalog
    .mockResolvedValueOnce({ workspace: 'project', head: null, entries: [] })
    .mockRejectedValueOnce(Error('Read unavailable'));
  client.submit.mockImplementation(async (input) => ({
    operationId: input.request.operationId,
    replayed: false,
    receipt: { outcome: 'changed', version: head },
    currentHead: head,
    delivery: { kind: 'blocked', versionId: head, error: 'External map appeared' },
  }));
  await session.setup();
  expect(session.getSnapshot()).toMatchObject({
    phase: 'accepted-pending',
    result: { receipt: { outcome: 'changed', version: head } },
  });
  session.detach();
});
it('fences an old project catalog response after detaching and rejects a relocated retained request', async () => {
  const { client, store, session } = fixture();
  let resolve!: (value: unknown) => void;
  client.catalog.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const reading = session.refresh();
  session.detach();
  resolve({ workspace: 'project', head, entries: [] });
  await reading;
  expect(session.getSnapshot().phase).toBe('inspecting');
  const original = session.proposedRequest();
  store.setItem(
    'dnaforge.scientific-design-setup.v1:project',
    JSON.stringify({ version: 1, input: original })
  );
  const moved = new ScientificDesignSetupSession(
    { ...scope, workspaceRoot: '/other' },
    client,
    store,
    mutation
  );
  await moved.retrySameSetup();
  expect(moved.getSnapshot().phase).toBe('unavailable');
  expect(client.submit).not.toHaveBeenCalled();
  moved.detach();
});
it('shows a definite refusal while its fresh catalog read is still pending', async () => {
  const { client, session } = fixture();
  let reject!: (cause: Error) => void;
  client.catalog
    .mockResolvedValueOnce({ workspace: 'project', head: null, entries: [] })
    .mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        })
    );
  client.submit.mockImplementation(async (input) => ({
    operationId: input.request.operationId,
    replayed: false,
    receipt: { outcome: 'conflict', conflicts: [{ kind: 'head-mismatch' }] },
    currentHead: head,
    delivery: null,
  }));
  const submission = session.setup();
  await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('refused'));
  expect(session.getSnapshot().result?.receipt.outcome).toBe('conflict');
  reject(Error('Catalog unavailable'));
  await submission;
  expect(session.getSnapshot().phase).toBe('refused');
  session.detach();
});
