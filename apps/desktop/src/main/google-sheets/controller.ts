import { createHash, randomUUID } from 'node:crypto';
import type {
  GoogleSheetsAccount,
  GoogleSheetsConnectState,
  GoogleSheetsStatus,
} from '../../shared/google-sheets';
import { GoogleSheetsReadError, type createGoogleSheetsReader } from './api';
import {
  GoogleSheetsCredentialError,
  type GoogleSheetsCredentialStore,
  type GoogleSheetsOwner,
} from './credential-store';
import { startGoogleSheetsLoopback } from './loopback';
import { createGoogleSheetsPkce, GoogleSheetsOAuthError, type GoogleSheetsOAuth } from './oauth';

export class GoogleSheetsConnectionError extends Error {
  constructor(
    public readonly reason:
      | 'unavailable'
      | 'reconnect-required'
      | 'account-context-unavailable'
      | 'forbidden',
    message: string
  ) {
    super(message);
    this.name = 'GoogleSheetsConnectionError';
  }
}
function sameOwner(first: GoogleSheetsOwner, second: GoogleSheetsOwner) {
  return first.kind === 'device'
    ? second.kind === 'device'
    : second.kind === 'account' && first.accountId === second.accountId;
}
function ownerKey(owner: GoogleSheetsOwner): string {
  return createHash('sha256')
    .update(owner.kind === 'device' ? 'device' : `account:${owner.accountId}`)
    .digest('hex');
}
function reconnect(): GoogleSheetsConnectionError {
  return new GoogleSheetsConnectionError(
    'reconnect-required',
    'Reconnect this Google account before reading the spreadsheet.'
  );
}
function publicMessage(error: unknown): string {
  return error instanceof GoogleSheetsConnectionError ||
    error instanceof GoogleSheetsCredentialError ||
    error instanceof GoogleSheetsOAuthError ||
    error instanceof GoogleSheetsReadError
    ? error.message
    : 'Google Sheets could not complete this operation. Try again.';
}
type Loopback = Awaited<ReturnType<typeof startGoogleSheetsLoopback>>;
type Flow = {
  id: string;
  windowId: number;
  owner: GoogleSheetsOwner;
  phase: 'authorizing' | 'saving';
  pkce: ReturnType<typeof createGoogleSheetsPkce>;
  abort: AbortController;
  listener: Promise<Loopback>;
};

export function createGoogleSheetsController(input: {
  oauth: GoogleSheetsOAuth | null;
  reader: ReturnType<typeof createGoogleSheetsReader>;
  store: GoogleSheetsCredentialStore;
  owner(): Promise<GoogleSheetsOwner>;
  openExternal(url: string): Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const listeners = new Set<() => void>();
  const tails = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  const forgetting = new Map<string, Promise<void>>();
  const forgotten = new Set<string>();
  const reads = new Map<AbortController, { grantId: string; owner: GoogleSheetsOwner }>();
  let disposed = false;
  let active: Flow | null = null;
  let view: {
    owner: GoogleSheetsOwner;
    value: Exclude<GoogleSheetsConnectState, { kind: 'idle' }>;
  } | null = null;
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }
  function assertLive() {
    if (disposed)
      throw new GoogleSheetsConnectionError('unavailable', 'Google Sheets is no longer active.');
  }
  async function assertOwner(owner: GoogleSheetsOwner) {
    assertLive();
    const current = await input.owner();
    assertLive();
    if (!sameOwner(owner, current))
      throw new GoogleSheetsConnectionError(
        'forbidden',
        'The selected DNAForge account changed. Retry in the current account.'
      );
  }
  function oauth() {
    assertLive();
    if (!input.oauth)
      throw new GoogleSheetsConnectionError(
        'unavailable',
        'Google Sheets is not available in this build.'
      );
    return input.oauth;
  }
  function tracked<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  }
  async function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(
      () => {},
      () => {}
    );
    tails.set(id, tail);
    try {
      return await current;
    } finally {
      if (tails.get(id) === tail) tails.delete(id);
    }
  }
  function cancelFlow(flow: Flow) {
    if (active !== flow) return;
    active = null;
    flow.abort.abort();
    void flow.listener.then((listener) => listener.cancel()).catch(() => {});
    view = null;
    notify();
  }
  async function ownerChanged(): Promise<void> {
    if (disposed) return;
    let owner: GoogleSheetsOwner | null = null;
    try {
      owner = await input.owner();
    } catch {}
    if (disposed) return;
    if (active && (!owner || !sameOwner(active.owner, owner))) cancelFlow(active);
    for (const [abort, read] of reads) if (!owner || !sameOwner(read.owner, owner)) abort.abort();
    notify();
  }
  async function status(): Promise<GoogleSheetsStatus> {
    assertLive();
    const owner = await input.owner();
    if (active && !sameOwner(active.owner, owner)) cancelFlow(active);
    const stored = await input.store.list();
    await assertOwner(owner);
    return {
      configured: input.oauth !== null,
      ownerKey: ownerKey(owner),
      accounts: stored.accounts
        .filter((entry) => sameOwner(entry.owner, owner) && !forgotten.has(entry.account.id))
        .map((entry) => ({
          account: entry.account,
          kind:
            entry.kind === 'connected' && entry.clientId === input.oauth?.clientId
              ? 'connected'
              : 'reconnect-required',
        })),
      unreadableAccounts: stored.unreadableAccounts,
      connection: view && sameOwner(view.owner, owner) ? view.value : { kind: 'idle' },
    };
  }
  async function assertFlow(flow: Flow) {
    await assertOwner(flow.owner);
    if (active !== flow || flow.abort.signal.aborted)
      throw new GoogleSheetsConnectionError('unavailable', 'Google connection was cancelled.');
  }
  async function runFlow(flow: Flow): Promise<void> {
    try {
      const client = oauth();
      const listener = await flow.listener;
      await assertFlow(flow);
      await input.openExternal(
        client.authorizationUrl({ redirectUri: listener.redirectUri, pkce: flow.pkce })
      );
      const callback = await listener.result;
      await assertFlow(flow);
      if (callback.kind !== 'code') {
        if (callback.kind === 'cancelled') {
          cancelFlow(flow);
          return;
        }
        throw new GoogleSheetsConnectionError(
          'unavailable',
          callback.kind === 'denied'
            ? 'Google Sheets access was not granted.'
            : 'Google connection did not complete. Try again.'
        );
      }
      const signal = AbortSignal.any([flow.abort.signal, AbortSignal.timeout(30000)]);
      const tokens = await client.exchange({
        code: callback.code,
        verifier: flow.pkce.verifier,
        redirectUri: listener.redirectUri,
        signal,
      });
      await assertFlow(flow);
      const identity = await client.identity({ accessToken: tokens.accessToken, signal });
      await assertFlow(flow);
      const stored = await input.store.list();
      const existing = stored.accounts.find(
        (entry) => sameOwner(entry.owner, flow.owner) && entry.account.subject === identity.subject
      );
      const account: GoogleSheetsAccount = {
        ...identity,
        id: existing?.account.id ?? randomUUID(),
      };
      await serialized(account.id, async () => {
        await assertFlow(flow);
        flow.phase = 'saving';
        view = { owner: flow.owner, value: { kind: 'saving', requestId: flow.id } };
        notify();
        forgotten.delete(account.id);
        await input.store.save({
          owner: flow.owner,
          materialVersion: randomUUID(),
          account,
          clientId: client.clientId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          scopes: tokens.scopes,
          expiresAt: now() + tokens.expiresInSeconds * 1000,
        });
      });
      await assertFlow(flow);
      view = { owner: flow.owner, value: { kind: 'connected', account } };
    } catch (error) {
      if (active === flow) {
        let current = false;
        try {
          current = sameOwner(flow.owner, await input.owner());
        } catch {}
        view =
          current && !flow.abort.signal.aborted
            ? { owner: flow.owner, value: { kind: 'error', message: publicMessage(error) } }
            : null;
      }
    } finally {
      void flow.listener.then((listener) => listener.cancel()).catch(() => {});
      if (active === flow) active = null;
      flow.abort.abort();
      notify();
    }
  }
  async function start(windowId: number): Promise<string> {
    oauth();
    const owner = await input.owner();
    assertLive();
    if (active && !sameOwner(active.owner, owner)) cancelFlow(active);
    if (active)
      throw new GoogleSheetsConnectionError(
        'unavailable',
        'A Google connection is already in progress.'
      );
    const pkce = createGoogleSheetsPkce();
    const flow: Flow = {
      id: randomUUID(),
      windowId,
      owner,
      pkce,
      phase: 'authorizing',
      abort: new AbortController(),
      listener: startGoogleSheetsLoopback({ state: pkce.state }),
    };
    active = flow;
    view = { owner, value: { kind: 'authorizing', requestId: flow.id } };
    notify();
    void tracked(runFlow(flow));
    return flow.id;
  }
  function cancel(id: string, windowId: number): boolean {
    if (!active) return true;
    if (active.id !== id || active.windowId !== windowId)
      throw new GoogleSheetsConnectionError(
        'forbidden',
        'This Google connection belongs to another window.'
      );
    if (active.phase === 'saving') return false;
    cancelFlow(active);
    return true;
  }
  async function grantToken(
    grantId: string,
    owner: GoogleSheetsOwner,
    signal: AbortSignal,
    previousVersion?: string
  ) {
    return serialized(grantId, async () => {
      await assertOwner(owner);
      if (signal.aborted || forgotten.has(grantId)) throw reconnect();
      const client = oauth();
      const metadata = await input.store.metadata(grantId);
      if (
        !metadata ||
        !sameOwner(metadata.owner, owner) ||
        metadata.kind !== 'connected' ||
        metadata.clientId !== client.clientId
      )
        throw reconnect();
      await assertOwner(owner);
      if (signal.aborted || forgotten.has(grantId)) throw reconnect();
      const grant = await input.store.read(grantId);
      await assertOwner(owner);
      if (!grant || signal.aborted || forgotten.has(grantId)) throw reconnect();
      if (
        grant.expiresAt > now() + 60000 &&
        (!previousVersion || grant.materialVersion !== previousVersion)
      )
        return { token: grant.accessToken, version: grant.materialVersion };
      try {
        const tokens = await client.refresh({ refreshToken: grant.refreshToken, signal });
        await assertOwner(owner);
        if (signal.aborted || forgotten.has(grantId)) throw reconnect();
        const next = {
          ...grant,
          materialVersion: randomUUID(),
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? grant.refreshToken,
          scopes: tokens.scopes ?? grant.scopes,
          expiresAt: now() + tokens.expiresInSeconds * 1000,
        };
        await input.store.save(next);
        return { token: next.accessToken, version: next.materialVersion };
      } catch (error) {
        if (
          error instanceof GoogleSheetsOAuthError &&
          (error.reason === 'invalid-grant' || error.reason === 'insufficient-scope')
        ) {
          await assertOwner(owner);
          if (!forgotten.has(grantId)) await input.store.requireReconnect(grantId);
          if (view?.value.kind === 'connected' && view.value.account.id === grantId) view = null;
          notify();
          throw reconnect();
        }
        throw error;
      }
    });
  }
  async function read<T>(
    grantId: string,
    operation: (accessToken: string, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    oauth();
    const owner = await input.owner();
    const abort = new AbortController();
    reads.set(abort, { grantId, owner });
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
    try {
      let receipt = await grantToken(grantId, owner, signal);
      let value: T;
      try {
        value = await operation(receipt.token, signal);
      } catch (error) {
        if (!(error instanceof GoogleSheetsReadError) || error.status !== 401) throw error;
        receipt = await grantToken(grantId, owner, signal, receipt.version);
        value = await operation(receipt.token, signal);
      }
      await assertOwner(owner);
      if (signal.aborted || forgotten.has(grantId)) throw reconnect();
      return value;
    } finally {
      reads.delete(abort);
      abort.abort();
    }
  }
  async function forget(grantId: string): Promise<void> {
    assertLive();
    const owner = await input.owner();
    if (active)
      throw new GoogleSheetsConnectionError(
        'unavailable',
        'Finish or cancel the Google connection before forgetting an account.'
      );
    const metadata = await input.store.metadata(grantId);
    if (metadata && !sameOwner(metadata.owner, owner))
      throw new GoogleSheetsConnectionError(
        'forbidden',
        'This Google connection belongs to a different DNAForge account.'
      );
    await assertOwner(owner);
    const existing = forgetting.get(grantId);
    if (existing) return existing;
    forgotten.add(grantId);
    for (const [abort, request] of reads) if (request.grantId === grantId) abort.abort();
    if (view?.value.kind === 'connected' && view.value.account.id === grantId) view = null;
    notify();
    const operation = serialized(grantId, async () => {
      await assertOwner(owner);
      await input.store.forget(grantId);
    });
    forgetting.set(grantId, operation);
    try {
      await operation;
    } catch (error) {
      forgotten.delete(grantId);
      throw error;
    } finally {
      forgetting.delete(grantId);
      notify();
    }
  }
  return {
    status,
    start,
    cancel,
    windowClosed(windowId: number) {
      if (active?.windowId === windowId && active.phase === 'authorizing') cancelFlow(active);
    },
    forget: (grantId: string) => tracked(forget(grantId)),
    ownerChanged,
    spreadsheet: (request: { grantId: string; spreadsheetId: string }) =>
      tracked(
        read(request.grantId, (accessToken, signal) =>
          input.reader.spreadsheet({ ...request, accessToken, signal })
        )
      ),
    worksheet: (request: { grantId: string; spreadsheetId: string; sheetId: number }) =>
      tracked(
        read(request.grantId, (accessToken, signal) =>
          input.reader.worksheet({ ...request, accessToken, signal })
        )
      ),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      if (active) cancelFlow(active);
      for (const abort of reads.keys()) abort.abort();
      listeners.clear();
      await Promise.allSettled([...pending, ...tails.values()]);
    },
  };
}
export type GoogleSheetsController = ReturnType<typeof createGoogleSheetsController>;
