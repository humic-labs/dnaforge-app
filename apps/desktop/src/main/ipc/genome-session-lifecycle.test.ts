import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_ACTIVE_GENOME_REQUESTS,
  MAX_ACTIVE_GENOME_REQUESTS_PER_SESSION,
  MAX_ACTIVE_GENOME_SESSIONS,
  MAX_GENOME_SESSIONS_PER_RENDERER,
  GenomeSessionAdmission,
  beginGenomeSessionRequest,
  bindGenomeSessionRequestToPhysicalLifecycle,
  cancelGenomeSessionRequest,
  closeGenomeSessionOwner,
  closeGenomeSessionsForRenderer,
  finishGenomeSessionRequest,
  genomeSessionOwnedByRenderer,
  replaceGenomeSessionIfOwned,
} from './genome-session-lifecycle';

describe('genome session lifecycle ownership', () => {
  it('never overwrites or prematurely releases a duplicate active request owner', () => {
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    const original = beginGenomeSessionRequest(stores, 'session-1', 'tile-1');

    expect(() => beginGenomeSessionRequest(stores, 'session-1', 'tile-1')).toThrow(
      'Duplicate active request id'
    );
    expect(finishGenomeSessionRequest(stores, 'session-1', 'tile-1', new AbortController())).toBe(
      false
    );
    expect(stores.activeRequests.get('session-1:tile-1')).toBe(original);
    expect(cancelGenomeSessionRequest(stores, 'session-1', 'tile-1')).toBe(true);
    expect(original.signal.aborted).toBe(true);
    expect(cancelGenomeSessionRequest(stores, 'session-1', 'tile-1')).toBe(false);
    expect(stores.activeRequests.get('session-1:tile-1')).toBe(original);
    expect(finishGenomeSessionRequest(stores, 'session-1', 'tile-1', original)).toBe(true);
    expect(stores.activeRequests).toEqual(new Map());
  });

  it('bounds session shells before insertion and releases capacity on close', () => {
    const admission = new GenomeSessionAdmission();
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    for (let index = 0; index < MAX_GENOME_SESSIONS_PER_RENDERER; index += 1) {
      const sessionId = `owned-${index}`;
      stores.sessions.set(sessionId, {});
      stores.owners.set(sessionId, 11);
    }

    expect(() => admission.begin(stores, 11)).toThrow('Renderer genome session capacity is full');
    closeGenomeSessionOwner(stores, 'owned-0');
    const release = admission.begin(stores, 11);
    release();

    for (let index = stores.sessions.size; index < MAX_ACTIVE_GENOME_SESSIONS; index += 1) {
      const sessionId = `global-${index}`;
      stores.sessions.set(sessionId, {});
      stores.owners.set(sessionId, index + 100);
    }
    expect(() => admission.begin(stores, 99_999)).toThrow('Active genome session capacity is full');
  });

  it('bounds concurrent session-open reservations and releases failed admissions', () => {
    const admission = new GenomeSessionAdmission(2, 3);
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    const first = admission.begin(stores, 11);
    const second = admission.begin(stores, 11);
    expect(() => admission.begin(stores, 11)).toThrow('Renderer genome session capacity is full');
    const third = admission.begin(stores, 22);
    expect(() => admission.begin(stores, 33)).toThrow('Active genome session capacity is full');

    first();
    const replacement = admission.begin(stores, 11);
    second();
    third();
    replacement();
    const finalAdmission = admission.begin(stores, 11);
    finalAdmission();
  });

  it('bounds active requests per session and globally, then re-admits released work', () => {
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    const controllers = Array.from({ length: MAX_ACTIVE_GENOME_REQUESTS_PER_SESSION }, (_, index) =>
      beginGenomeSessionRequest(stores, 'session-1', `tile-${index}`)
    );

    expect(() => beginGenomeSessionRequest(stores, 'session-1', 'overflow')).toThrow(
      'Genome session request capacity is full'
    );
    expect(finishGenomeSessionRequest(stores, 'session-1', 'tile-0', controllers[0]!)).toBe(true);
    expect(() => beginGenomeSessionRequest(stores, 'session-1', 'replacement')).not.toThrow();

    stores.activeRequests.clear();
    for (let index = 0; index < MAX_ACTIVE_GENOME_REQUESTS; index += 1) {
      stores.activeRequests.set(`session-${index}:request`, new AbortController());
    }
    expect(() => beginGenomeSessionRequest(stores, 'new-session', 'request')).toThrow(
      'Active genome request capacity is full'
    );
  });

  it('keeps cancelled physical work admitted until its request settles', () => {
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    const controllers = Array.from({ length: MAX_ACTIVE_GENOME_REQUESTS_PER_SESSION }, (_, index) =>
      beginGenomeSessionRequest(stores, 'session-1', `tile-${index}`)
    );

    for (let index = 0; index < controllers.length; index += 1) {
      expect(cancelGenomeSessionRequest(stores, 'session-1', `tile-${index}`)).toBe(true);
    }
    expect(() => beginGenomeSessionRequest(stores, 'session-1', 'replacement')).toThrow(
      'Genome session request capacity is full'
    );

    expect(finishGenomeSessionRequest(stores, 'session-1', 'tile-0', controllers[0]!)).toBe(true);
    expect(() => beginGenomeSessionRequest(stores, 'session-1', 'replacement')).not.toThrow();
  });

  it('releases request admission only after logical and physical settlement', () => {
    const stores = {
      sessions: new Map<string, object>(),
      diagnostics: new Map<string, object>(),
      owners: new Map<string, number>(),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };
    const controller = beginGenomeSessionRequest(stores, 'session-1', 'physical-a');
    const binding = bindGenomeSessionRequestToPhysicalLifecycle(
      stores,
      'session-1',
      'physical-a',
      controller
    );

    binding.physicalLifecycle.started();
    controller.abort();
    binding.finishLogical();
    expect(stores.activeRequests.size).toBe(1);

    binding.physicalLifecycle.settled();
    expect(stores.activeRequests.size).toBe(0);
  });

  it('returns session data only to the renderer that owns it', () => {
    const owned = { id: 'session-1', sourcePath: '/private/reference.fa' };
    const stores = {
      sessions: new Map([['session-1', owned]]),
      diagnostics: new Map<string, object>(),
      owners: new Map([['session-1', 11]]),
      activeRequests: new Map<string, AbortController>(),
      preparations: new Map<string, AbortController>(),
    };

    expect(genomeSessionOwnedByRenderer(stores, 'session-1', 11)).toBe(owned);
    expect(genomeSessionOwnedByRenderer(stores, 'session-1', 22)).toBeNull();
    expect(genomeSessionOwnedByRenderer(stores, 'missing', 11)).toBeNull();
  });

  it('authenticates every session-id read and cancellation handler before dispatch', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    for (const channel of [
      'genome:getTrackTile',
      'genome:getAnnotationTile',
      'genome:getDebugSnapshot',
      'genome:getSession',
      'genome:cancelRequest',
      'genome:getFeatureDetails',
      'genome:getSequenceWindow',
    ]) {
      const start = source.indexOf(`'${channel}'`);
      const end = source.indexOf('mainIpc.handle(', start + channel.length);
      expect(start, channel).toBeGreaterThan(-1);
      expect(source.slice(start, end < 0 ? source.length : end), channel).toContain(
        'requireOwnedGenomeSession(_event.sender, sessionId)'
      );
    }
  });

  it('refreshes live worker ownership before publishing a debug snapshot', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const start = source.indexOf("'genome:getDebugSnapshot'");
    const end = source.indexOf('mainIpc.handle(', start + 1);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('createDebugSnapshot(session, getOrCreateDiagnostics(session)');
    expect(handler).not.toContain('sessionDiagnostics.get(sessionId)');
  });

  it('settles lifecycle shutdown before retrying failed-initialization owners', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const start = source.indexOf('export async function closeGenomeDataSourcesForTests');
    const body = source.slice(start);
    const lifecycleBarrier = body.indexOf('const lifecycleCleanup = await Promise.allSettled');
    const factoryRetry = body.indexOf(
      'const factoryCleanup = await Promise.allSettled([closeFailedGenomeDataWorkerThreadSources()])'
    );

    expect(start).toBeGreaterThan(-1);
    expect(lifecycleBarrier).toBeGreaterThan(-1);
    expect(factoryRetry).toBeGreaterThan(lifecycleBarrier);
    expect(body.slice(lifecycleBarrier, factoryRetry)).toContain(
      'assemblySequenceSearchSourceLifecycle.closeAll()'
    );
  });

  it('rejects duplicate request ownership before recording a pending debug trace', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    for (const [functionName, traceFieldsCall] of [
      [
        'getGenomeTrackTile',
        'traceFieldsForTileRequest(session, request, requestId, route.traceKind)',
      ],
      ['getGenomeSequenceWindow', 'traceFieldsForSequenceRequest(session, request, requestId)'],
      [
        'getGenomeFeatureDetails',
        'traceFieldsForFeatureDetailsRequest(session, request, requestId)',
      ],
    ]) {
      const start = source.indexOf(`async function ${functionName}`);
      const end = source.indexOf('\nasync function ', start + functionName.length);
      const body = source.slice(start, end < 0 ? source.length : end);
      expect(start, functionName).toBeGreaterThan(-1);
      expect(body.indexOf('beginGenomeSessionRequest('), functionName).toBeGreaterThan(-1);
      expect(body.indexOf('beginGenomeSessionRequest('), functionName).toBeLessThan(
        body.indexOf(traceFieldsCall)
      );
    }
  });

  it('releases the shell, diagnostics, and every request owned by one closed session', () => {
    const ownedController = new AbortController();
    const otherController = new AbortController();
    const ownedPreparation = new AbortController();
    const otherPreparation = new AbortController();
    const stores = {
      sessions: new Map([
        ['session-1', { id: 'session-1' }],
        ['session-2', { id: 'session-2' }],
      ]),
      diagnostics: new Map([
        ['session-1', { requests: 2 }],
        ['session-2', { requests: 1 }],
      ]),
      owners: new Map([
        ['session-1', 11],
        ['session-2', 22],
      ]),
      activeRequests: new Map([
        ['session-1:tile-1', ownedController],
        ['session-1:tile-2', new AbortController()],
        ['session-2:tile-1', otherController],
      ]),
      preparations: new Map([
        ['session-1', ownedPreparation],
        ['session-2', otherPreparation],
      ]),
    };
    const abortSpy = vi.spyOn(ownedController, 'abort');

    expect(closeGenomeSessionOwner(stores, 'session-1')).toEqual({
      sessionRemoved: true,
      activeSessionCount: 1,
      requestsCancelled: 2,
    });
    expect(stores.sessions.has('session-1')).toBe(false);
    expect(stores.diagnostics.has('session-1')).toBe(false);
    expect(stores.owners.has('session-1')).toBe(false);
    expect(stores.activeRequests.has('session-1:tile-1')).toBe(true);
    expect(stores.activeRequests.has('session-1:tile-2')).toBe(true);
    expect(stores.preparations.has('session-1')).toBe(false);
    expect(ownedPreparation.signal.aborted).toBe(true);
    expect(abortSpy).toHaveBeenCalledOnce();
    expect(stores.sessions.has('session-2')).toBe(true);
    expect(stores.diagnostics.has('session-2')).toBe(true);
    expect(stores.activeRequests.has('session-2:tile-1')).toBe(true);
    expect(otherController.signal.aborted).toBe(false);
    expect(otherPreparation.signal.aborted).toBe(false);
  });

  it('releases every session and runtime owner abandoned by one renderer', () => {
    const firstPreparation = new AbortController();
    const secondPreparation = new AbortController();
    const firstRequest = new AbortController();
    const secondRequest = new AbortController();
    const otherRequest = new AbortController();
    const stores = {
      sessions: new Map([
        ['session-1', { id: 'session-1' }],
        ['session-2', { id: 'session-2' }],
        ['session-3', { id: 'session-3' }],
      ]),
      diagnostics: new Map([
        ['session-1', { requests: 1 }],
        ['session-2', { requests: 1 }],
        ['session-3', { requests: 1 }],
      ]),
      owners: new Map([
        ['session-1', 11],
        ['session-2', 11],
        ['session-3', 22],
      ]),
      activeRequests: new Map([
        ['session-1:tile-1', firstRequest],
        ['session-2:tile-1', secondRequest],
        ['session-3:tile-1', otherRequest],
      ]),
      preparations: new Map([
        ['session-1', firstPreparation],
        ['session-2', secondPreparation],
      ]),
    };

    expect(closeGenomeSessionsForRenderer(stores, 11)).toEqual({
      sessionRemoved: true,
      activeSessionCount: 1,
      requestsCancelled: 2,
    });
    expect([...stores.sessions.keys()]).toEqual(['session-3']);
    expect([...stores.diagnostics.keys()]).toEqual(['session-3']);
    expect([...stores.owners.entries()]).toEqual([['session-3', 22]]);
    expect([...stores.activeRequests.keys()]).toEqual([
      'session-1:tile-1',
      'session-2:tile-1',
      'session-3:tile-1',
    ]);
    expect(stores.preparations.size).toBe(0);
    expect(firstPreparation.signal.aborted).toBe(true);
    expect(secondPreparation.signal.aborted).toBe(true);
    expect(firstRequest.signal.aborted).toBe(true);
    expect(secondRequest.signal.aborted).toBe(true);
    expect(otherRequest.signal.aborted).toBe(false);
  });

  it('does not resurrect a session after its owner has closed', () => {
    const sessions = new Map<string, { version: number }>([['session-1', { version: 1 }]]);

    expect(replaceGenomeSessionIfOwned(sessions, 'session-1', { version: 2 })).toBe(true);
    expect(sessions.get('session-1')).toEqual({ version: 2 });

    sessions.delete('session-1');
    expect(replaceGenomeSessionIfOwned(sessions, 'session-1', { version: 3 })).toBe(false);
    expect(sessions.has('session-1')).toBe(false);
  });
});
