import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  AppServerSupervisor,
  AppServerSupervisorError,
  FORBIDDEN_SERVER_METHODS,
} from './app-server-supervisor';

function fixtureChild() {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const exit = new EventEmitter();
  const killed: string[] = [];
  const child = {
    stdin: { write: (chunk: string) => void written.push(chunk) } as {
      write: (chunk: string) => void;
    },
    stdout,
    on: (event: 'exit', listener: (code: number | null, signal: string | null) => void) =>
      void exit.on(event, listener),
    kill: (signal: NodeJS.Signals | number = 'SIGTERM') => void killed.push(String(signal)),
  };
  return {
    child,
    written,
    killed,
    send: (frame: unknown) => stdout.emit('data', `${JSON.stringify(frame)}\n`),
    sendRaw: (raw: string) => stdout.emit('data', raw),
    exitChild: () => exit.emit('exit', 1, null),
    sentRequests: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('AppServerSupervisor', () => {
  it('matches a response to the request that asked for it', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });

    const first = s.request('initialize', { client: 'dnaforge' });
    const second = s.request('thread/start');
    const [a, b] = f.sentRequests();
    expect(a?.method).toBe('initialize');
    expect(b?.method).toBe('thread/start');

    f.send({ jsonrpc: '2.0', id: b?.id, result: { threadId: 't-1' } });
    f.send({ jsonrpc: '2.0', id: a?.id, result: { protocol: 'v1' } });

    await expect(first).resolves.toEqual({ protocol: 'v1' });
    await expect(second).resolves.toEqual({ threadId: 't-1' });
  });

  it('discards a response whose id is not outstanding', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    const pending = s.request('initialize');

    f.send({ jsonrpc: '2.0', id: 9999, result: { wrong: true } });
    f.send({ jsonrpc: '2.0', id: f.sentRequests()[0]?.id, result: { right: true } });

    await expect(pending).resolves.toEqual({ right: true });
    expect(s.isTerminated).toBe(false);
  });

  it('settles every outstanding request when the child exits', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    const first = s.request('initialize');
    const second = s.request('thread/start');

    f.exitChild();

    await expect(first).rejects.toBeInstanceOf(AppServerSupervisorError);
    await expect(second).rejects.toThrow(/child exited/u);
    expect(s.isTerminated).toBe(true);
  });

  it('times out a request, retires its id, and stops the child', async () => {
    vi.useFakeTimers();
    try {
      const f = fixtureChild();
      const s = new AppServerSupervisor({ child: f.child, requestTimeoutMs: 1_000 });
      const pending = s.request('initialize');
      const rejection = expect(pending).rejects.toThrow(/did not answer within the bound/u);
      vi.advanceTimersByTime(1_001);
      await rejection;
      expect(s.isTerminated).toBe(true);
      expect(f.killed).toContain('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a native effect method even when it is on the allowed list', () => {
    for (const method of FORBIDDEN_SERVER_METHODS) {
      const f = fixtureChild();
      const s = new AppServerSupervisor({
        child: f.child,
        allowedNotifications: [method],
      });
      f.send({ jsonrpc: '2.0', method, params: {} });
      expect(s.isTerminated, `${method} must terminate the child`).toBe(true);
      expect(s.receivedNotifications(), `${method} must not be delivered`).toEqual([]);
      expect(f.killed).toContain('SIGTERM');
    }
  });

  it('stops on a native effect method sent as a request', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    f.send({ jsonrpc: '2.0', id: 1, method: 'shell/exec', params: { cmd: 'rm -rf ~' } });
    expect(s.isTerminated).toBe(true);
    expect(f.killed).toContain('SIGTERM');
  });

  it('answers a server request it was told to expect, instead of killing the child', () => {
    const f = fixtureChild();
    const answered: { method: string; params: unknown }[] = [];
    const s = new AppServerSupervisor({
      child: f.child,
      answerableRequests: ['item/tool/call'],
      onServerRequest: (request) => {
        answered.push({ method: request.method, params: request.params });
        request.respond({ ok: true });
      },
    });
    f.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'item/tool/call',
      params: { callId: 'c1', tool: 'read_thing', arguments: {}, threadId: 't', turnId: 'u' },
    });
    expect(s.isTerminated).toBe(false);
    expect(answered).toEqual([
      {
        method: 'item/tool/call',
        params: { callId: 'c1', tool: 'read_thing', arguments: {}, threadId: 't', turnId: 'u' },
      },
    ]);
    const reply = f.sentRequests().find((line) => line.id === 7);
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  });

  it('lets a handler refuse a request with an error rather than answering it', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      answerableRequests: ['item/tool/call'],
      onServerRequest: (request) => request.refuse('not_permitted'),
    });
    f.send({ jsonrpc: '2.0', id: 8, method: 'item/tool/call', params: {} });
    expect(s.isTerminated).toBe(false);
    const reply = f.sentRequests().find((line) => line.id === 8);
    expect(reply).toMatchObject({ id: 8, error: { message: 'not_permitted' } });
  });

  it('still terminates on a server request it was not told to expect', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      answerableRequests: ['item/tool/call'],
      onServerRequest: () => {
        throw new Error('must not be consulted for an unexpected request');
      },
    });
    f.send({ jsonrpc: '2.0', id: 9, method: 'execCommandApproval', params: {} });
    expect(s.isTerminated).toBe(true);
  });

  it('terminates on an answerable request when nothing is there to answer it', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, answerableRequests: ['item/tool/call'] });
    f.send({ jsonrpc: '2.0', id: 10, method: 'item/tool/call', params: {} });
    expect(s.isTerminated).toBe(true);
  });

  it('keeps the deny list above the answerable list', () => {
    for (const method of FORBIDDEN_SERVER_METHODS) {
      const f = fixtureChild();
      const s = new AppServerSupervisor({
        child: f.child,
        answerableRequests: [method],
        onServerRequest: () => {
          throw new Error('a forbidden method must never reach a handler');
        },
      });
      f.send({ jsonrpc: '2.0', id: 11, method, params: {} });
      expect(s.isTerminated, `${method} must terminate the child`).toBe(true);
    }
  });

  it('terminates on an unexpected server-initiated request', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    f.send({ jsonrpc: '2.0', id: 1, method: 'workspace/readFile', params: {} });
    expect(s.isTerminated).toBe(true);
  });

  it.each([1, 'req-1', 0, -3])(
    'terminates on a server-initiated request whatever shape its id takes (%p)',
    (id) => {
      const f = fixtureChild();
      const s = new AppServerSupervisor({ child: f.child, allowedNotifications: ['thread/event'] });
      f.send({ jsonrpc: '2.0', id, method: 'thread/event', params: {} });
      expect(s.isTerminated).toBe(true);
      expect(s.receivedNotifications()).toEqual([]);
      expect(f.killed).toContain('SIGTERM');
    }
  );

  it('refuses a response bearing an id this runtime never issues', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    f.send({ jsonrpc: '2.0', id: 'not-a-number', result: { ok: true } });
    expect(s.isTerminated).toBe(true);
  });

  it('delivers each notification to a consumer as it arrives', () => {
    const seen: { method: string; params: unknown }[] = [];
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      allowedNotifications: ['thread/event'],
      onNotification: (notification) => void seen.push(notification),
    });
    f.send({ jsonrpc: '2.0', method: 'thread/event', params: { n: 1 } });
    f.send({ jsonrpc: '2.0', method: 'thread/event', params: { n: 2 } });
    expect(seen).toEqual([
      { method: 'thread/event', params: { n: 1 } },
      { method: 'thread/event', params: { n: 2 } },
    ]);
    expect(s.isTerminated).toBe(false);
  });

  it('bounds what it retains, because a real child streams events for the whole turn', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      allowedNotifications: ['thread/event'],
      maxRetainedNotifications: 4,
    });
    for (let n = 0; n < 50; n += 1) {
      f.send({ jsonrpc: '2.0', method: 'thread/event', params: { n } });
    }
    const retained = s.receivedNotifications();
    expect(retained).toHaveLength(4);
    expect(retained.map((entry) => (entry.params as { n: number }).n)).toEqual([46, 47, 48, 49]);
  });

  it('retains the last notifications after the child is gone, for the post-mortem', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, allowedNotifications: ['thread/event'] });
    f.send({ jsonrpc: '2.0', method: 'thread/event', params: { n: 1 } });
    f.exitChild();
    expect(s.isTerminated).toBe(true);
    expect(s.receivedNotifications()).toEqual([{ method: 'thread/event', params: { n: 1 } }]);
  });

  it('terminates on a notification it was not told to expect', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      allowedNotifications: ['thread/event'],
    });
    f.send({ jsonrpc: '2.0', method: 'thread/event', params: { type: 'text' } });
    expect(s.receivedNotifications()).toEqual([
      { method: 'thread/event', params: { type: 'text' } },
    ]);
    expect(s.isTerminated).toBe(false);

    f.send({ jsonrpc: '2.0', method: 'something/new', params: {} });
    expect(s.isTerminated).toBe(true);
  });

  it('preserves notification order', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, allowedNotifications: ['e'] });
    for (const n of [1, 2, 3]) f.send({ jsonrpc: '2.0', method: 'e', params: { n } });
    expect(s.receivedNotifications().map((x) => (x.params as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it('reassembles a frame split across chunks', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, allowedNotifications: ['e'] });
    f.sendRaw('{"jsonrpc":"2.0","method":"e","par');
    expect(s.receivedNotifications()).toHaveLength(0);
    f.sendRaw('ams":{"n":1}}\n');
    expect(s.receivedNotifications()).toHaveLength(1);
  });

  it('terminates on a malformed frame instead of skipping it', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    f.sendRaw('this is not json\n');
    expect(s.isTerminated).toBe(true);
  });

  it('refuses an oversized frame rather than buffering it', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, maxFrameBytes: 128 });
    f.sendRaw('x'.repeat(200));
    expect(s.isTerminated).toBe(true);
    expect(f.killed).toContain('SIGTERM');
  });

  it('refuses to send a request once terminated', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    s.shutdown();
    expect(() => s.request('initialize')).toThrow(/no longer running/u);
  });

  it('settles outstanding work on interrupt and on shutdown', async () => {
    for (const stop of ['interrupt', 'shutdown'] as const) {
      const f = fixtureChild();
      const s = new AppServerSupervisor({ child: f.child });
      const pending = s.request('initialize');
      s[stop]();
      await expect(pending).rejects.toBeInstanceOf(AppServerSupervisorError);
      expect(f.killed).toContain('SIGTERM');
    }
  });

  it('waits for the exact child to exit during an orderly shutdown', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    let settled = false;

    const shutdown = s.shutdownAndWait(1_000, 1_000).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(f.killed).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    f.exitChild();
    await shutdown;
    expect(settled).toBe(true);
  });

  it('escalates to SIGKILL when the exact child ignores the shutdown grace period', async () => {
    vi.useFakeTimers();
    try {
      const f = fixtureChild();
      const s = new AppServerSupervisor({ child: f.child });
      const shutdown = s.shutdownAndWait(1_000, 1_000);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(f.killed).toEqual(['SIGTERM', 'SIGKILL']);

      f.exitChild();
      await shutdown;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reassembles a multibyte character split across stdout chunks', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child, allowedNotifications: ['e'] });
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'e', params: { text: 'café — 🧬' } })}\n`,
      'utf8'
    );
    const split = 59;
    f.child.stdout.emit('data', frame.subarray(0, split));
    f.child.stdout.emit('data', frame.subarray(split));

    expect(s.isTerminated).toBe(false);
    expect(s.receivedNotifications()).toEqual([{ method: 'e', params: { text: 'café — 🧬' } }]);
  });

  it('does not count complete frames toward the size bound', () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({
      child: f.child,
      allowedNotifications: ['e'],
      maxFrameBytes: 200,
    });
    for (let i = 0; i < 20; i += 1) f.send({ jsonrpc: '2.0', method: 'e', params: { i } });
    expect(s.isTerminated).toBe(false);
    expect(s.receivedNotifications()).toHaveLength(20);
  });

  it('settles a request the child never received', async () => {
    const f = fixtureChild();
    f.child.stdin.write = () => {
      throw new Error('EPIPE');
    };
    const s = new AppServerSupervisor({ child: f.child });
    await expect(s.request('initialize')).rejects.toThrow(/could not send initialize/u);
  });

  it('reports a child error reply as an error, not as the child exiting', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    const pending = s.request('initialize');
    f.send({
      jsonrpc: '2.0',
      id: f.sentRequests()[0]?.id,
      error: { code: -32601, message: 'method not found' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'child_error' });
    expect(s.isTerminated).toBe(false);
  });

  it('rejects with the child’s error message when it answers with one', async () => {
    const f = fixtureChild();
    const s = new AppServerSupervisor({ child: f.child });
    const pending = s.request('initialize');
    f.send({
      jsonrpc: '2.0',
      id: f.sentRequests()[0]?.id,
      error: { code: -32601, message: 'method not found' },
    });
    await expect(pending).rejects.toThrow(/method not found/u);
    expect(s.isTerminated).toBe(false);
  });

  describe('requests this build has decided against', () => {
    it('declines them instead of stopping the child', () => {
      const f = fixtureChild();
      const s = new AppServerSupervisor({
        child: f.child,
        answerableRequests: ['item/tool/call'],
        refusedRequests: { 'attestation/generate': 'attestation is not part of the contract' },
      });

      f.send({ jsonrpc: '2.0', id: 7, method: 'attestation/generate', params: {} });

      expect(s.isTerminated).toBe(false);
      const [reply] = f.sentRequests().filter((frame) => frame.id === 7);
      expect(reply).toBeDefined();
      expect(reply.error).toMatchObject({ message: 'attestation is not part of the contract' });
    });

    it('still stops the child for a method nobody has decided about', () => {
      const f = fixtureChild();
      const s = new AppServerSupervisor({
        child: f.child,
        answerableRequests: ['item/tool/call'],
        refusedRequests: { 'attestation/generate': 'attestation is not part of the contract' },
      });
      const handled: string[] = [];
      s.setServerRequestHandler((request) => {
        handled.push(request.method);
        request.refuse('should never be reached');
      });

      f.send({ jsonrpc: '2.0', id: 8, method: 'something/nobody/models', params: {} });

      expect(s.isTerminated).toBe(true);
      expect(handled, 'an undecided method reached the handler').toEqual([]);
    });
  });
});
