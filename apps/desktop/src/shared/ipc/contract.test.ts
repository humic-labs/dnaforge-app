// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  contractEntries,
  defineGroup,
  event,
  forwardGroup,
  invoke,
  reply,
  send,
  type ClientOf,
} from './contract';

const demo = defineGroup('demo', {
  query: invoke<[input: { readonly kind?: string }], string>().withDefault(0, {}),
  probe: invoke<[], string>().conditionallyExposed(),
  report: send<[dirty: boolean]>().channel('app:dirtyStateChanged'),
  respond: reply<[ok: boolean]>(),
  respondElsewhere: reply<[ok: boolean]>().prefix('agent-tools:response:'),
  onCancel: event<[payload: { readonly requestId: string }]>()
    .channel('agentConfirm:cancel')
    .projected((payload) => payload.requestId),
});

describe('defineGroup channel resolution', () => {
  it('defaults, overrides, reply prefixes and root mounts resolve once', () => {
    expect(
      contractEntries(demo).map(({ method, kind, channel, conditional }) => ({
        method,
        kind,
        channel,
        conditional,
      }))
    ).toEqual([
      { method: 'query', kind: 'invoke', channel: 'demo:query', conditional: false },
      { method: 'probe', kind: 'invoke', channel: 'demo:probe', conditional: true },
      { method: 'report', kind: 'send', channel: 'app:dirtyStateChanged', conditional: false },
      { method: 'respond', kind: 'reply', channel: 'demo:respond:', conditional: false },
      {
        method: 'respondElsewhere',
        kind: 'reply',
        channel: 'agent-tools:response:',
        conditional: false,
      },
      { method: 'onCancel', kind: 'event', channel: 'agentConfirm:cancel', conditional: false },
    ]);
    expect(contractEntries(demo)[0]?.defaultArgument).toEqual({ position: 0, value: {} });
    expect(contractEntries(demo)[5]?.project?.({ requestId: 'r-1' })).toBe('r-1');

    const root = defineGroup(
      'fs',
      { convertFileSrc: invoke<[path: string], string>() },
      { mount: 'root' }
    );
    expect(root.mount).toBe('root');
    expect(contractEntries(root)[0]?.channel).toBe('fs:convertFileSrc');
    expect(demo.mount).toBe('group');
  });

  it('rejects duplicate channels and descriptors not built by the builders', () => {
    expect(() =>
      defineGroup('dup', {
        a: invoke<[], void>().channel('dup:x'),
        b: invoke<[], void>().channel('dup:x'),
      })
    ).toThrow('dup declares channel dup:x twice');
    expect(() =>
      defineGroup('fake', {
        a: { kind: 'invoke', channelOverride: undefined, conditional: false },
      })
    ).toThrow('fake.a was not built by an IPC contract builder');
  });
});

describe('forwardGroup', () => {
  const pair = defineGroup('pair', {
    ping: invoke<[value: string], string>(),
    probe: invoke<[], string>().conditionallyExposed(),
  });

  it('reads the target on every call', async () => {
    let target: ClientOf<typeof pair> | undefined = { ping: async (value) => `first:${value}` };
    const forwarded = forwardGroup(pair, () => target);
    await expect(forwarded.ping('a')).resolves.toBe('first:a');
    target = { ping: async (value) => `second:${value}` };
    await expect(forwarded.ping('b')).resolves.toBe('second:b');
  });

  it('throws a named error when the target lacks a method', () => {
    const forwarded = forwardGroup(pair, () => undefined);
    expect(() => forwarded.ping('a')).toThrow('pair.ping is unavailable on this platform');
  });

  it('exposes conditional methods as getters that follow the target', async () => {
    let target: ClientOf<typeof pair> = { ping: async (value) => value };
    const forwarded = forwardGroup(pair, () => target);
    expect(forwarded.probe).toBeUndefined();
    const probe = vi.fn(async () => 'probed');
    target = { ...target, probe };
    expect(forwarded.probe).toBeTypeOf('function');
    await expect(forwarded.probe?.()).resolves.toBe('probed');
    expect(Object.keys(forwarded).sort()).toEqual(['ping', 'probe']);
  });
});

describe('defineGroup reply prefixes', () => {
  it('rejects a reply prefix that also matches another channel in the group', () => {
    expect(() =>
      defineGroup('overlap', {
        respond: reply<[ok: boolean]>().prefix('overlap:'),
        status: send<[]>(),
      })
    ).toThrow('overlap.respond reply prefix also matches overlap:status');
  });
});
