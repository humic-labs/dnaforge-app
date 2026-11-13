// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { presentDocument } from '../canvas/public/present-document';
import { beginWorkflowAction } from '../../lib/workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../shared/analytics-registry.generated';
import {
  beginImageOpenRequest,
  admitImageOpen,
  beginImageRead,
  resetImageViewLifecycleForTests,
} from './image-view-lifecycle';
import { beginTelemetryEpisode } from '../../lib/telemetry-correlation';

type Dependencies = NonNullable<Parameters<typeof beginWorkflowAction>[1]>;
type Track = NonNullable<Dependencies['track']>;
const path = '/synthetic/private-image.png';
function collector() {
  let id = 0;
  const track = vi.fn<Track>(() => true);
  const dependencies: Dependencies = {
    track,
    now: () => 1000,
    createId: () => `550e8400-e29b-41d4-a716-${(++id).toString().padStart(12, '0')}`,
    isIdentified: () => true,
    activityAuthority: () => ({
      actorKind: 'external',
      executionMode: 'interactive',
      impersonated: false,
    }),
  };
  const terminals = () =>
    track.mock.calls.filter(
      ([event, props]) =>
        event === 'workflow_action_observed' &&
        props.workflow === 'image' &&
        ['result', 'error', 'cancel'].includes(String(props.action_phase))
    );
  return { track, dependencies, terminals };
}
function present(filePath = path, sourceFileName?: string) {
  const result = presentDocument({
    type: 'image',
    entityId: filePath,
    label: 'Private local label',
    sourceFileName,
  });
  if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
  return result;
}
function decode(owner: ReturnType<typeof beginImageRead>) {
  owner.readStarted();
  owner.bytesReady();
  owner.decoded();
}
beforeEach(() => {
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
});
afterEach(() => {
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
  vi.restoreAllMocks();
});

describe('I1 actual image producer and admitted view-generation ownership', () => {
  it('joins accepted open/read/bytes/decode, settles once, and preserves one meaningful content view', () => {
    const { track, dependencies, terminals } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    admitImageOpen(request, result);
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    decode(owner);
    owner.decoded();
    owner.fail('decode_unknown');
    owner.dispose();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1]).toMatchObject({
      action_id: request?.id,
      workflow_status: 'ready',
      outcome_kind: 'image_decode_ready',
    });
    expect(
      track.mock.calls.filter(([event]) => event === 'meaningful_activity_completed')
    ).toHaveLength(1);
    const kinds = track.mock.calls.map(([, props]) => props.outcome_kind);
    expect(kinds).toContain('image_open_created');
    expect(kinds).toContain('image_read_started');
    expect(kinds).toContain('image_bytes_ready');
    expect(terminals()[0][1].operation_id).not.toBe(request?.id);
  });

  it('keeps restored/background reads unattributed and explicitly reuses an already decoded owner', () => {
    const { track, dependencies, terminals } = collector();
    const result = present();
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    decode(owner);
    expect(track).not.toHaveBeenCalled();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    admitImageOpen(request, present());
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_reuse_ready');
    expect(track.mock.calls.some(([, props]) => props.outcome_kind === 'image_read_started')).toBe(
      false
    );
  });

  it('cancels superseded loading intent, without inventing another read/decode generation on reuse', () => {
    const { dependencies, terminals } = collector();
    const first = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(first, result);
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    owner.readStarted();
    const second = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    admitImageOpen(second, present());
    owner.bytesReady();
    owner.decoded();
    expect(terminals()).toHaveLength(2);
    expect(terminals()[0][1]).toMatchObject({ action_id: first?.id, action_phase: 'cancel' });
    expect(terminals()[1][1]).toMatchObject({
      action_id: second?.id,
      outcome_kind: 'image_decode_ready',
    });
    expect(terminals()[0][1].operation_id).toBe(terminals()[1][1].operation_id);
  });

  it('settles a read exception and starts a distinct deliberate retry through the current owner', () => {
    const { track, dependencies, terminals } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    const old = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    old.readStarted();
    old.fail('read_unknown');
    old.dispose();
    const retry = beginImageRead(
      { tabId: result.tabId, filePath: path, retry: true },
      dependencies
    );
    decode(retry);
    old.bytesReady();
    old.decoded();
    old.dispose();
    expect(terminals()).toHaveLength(2);
    expect(terminals()[0][1]).toMatchObject({
      outcome_kind: 'image_read_failed',
      error_class: 'read_unknown',
    });
    expect(terminals()[1][1]).toMatchObject({
      workflow_action: 'run',
      outcome_kind: 'image_decode_ready',
    });
    expect(terminals()[0][1].operation_id).not.toBe(terminals()[1][1].operation_id);
    expect(
      track.mock.calls.filter(([, props]) => props.outcome_kind === 'image_retry')
    ).toHaveLength(1);
  });

  it.each(['close', 'retarget', 'inactive', 'abort'] as const)(
    'cancels %s and rejects stale decode/error completion',
    (change) => {
      const { dependencies, terminals } = collector();
      const abort = new AbortController();
      const request = beginImageOpenRequest({ filePath: path }, abort.signal, dependencies);
      const result = present();
      admitImageOpen(request, result);
      const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
      owner.readStarted();
      if (change === 'close') useCanvasStore.getState().closeTab(result.panelId, result.tabId);
      else if (change === 'retarget')
        useCanvasStore
          .getState()
          .updateTab(result.panelId, result.tabId, { entityId: '/synthetic/replacement.png' });
      else if (change === 'inactive') useCanvasStore.setState({ focusedPanelId: null });
      else abort.abort();
      owner.bytesReady();
      owner.decoded();
      owner.fail('decode_unknown');
      owner.dispose();
      expect(terminals()).toHaveLength(1);
      expect(terminals()[0][1].action_phase).toBe('cancel');
    }
  );

  it('retires A if synchronous presentation custody has become B before admission', () => {
    const { track, dependencies, terminals } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    useCanvasStore
      .getState()
      .updateTab(result.panelId, result.tabId, { entityId: '/synthetic/B.png' });
    admitImageOpen(request, result);
    decode(beginImageRead({ tabId: result.tabId, filePath: '/synthetic/B.png' }, dependencies));
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
    expect(track.mock.calls.some(([, props]) => props.workflow_status === 'ready')).toBe(false);
  });

  it('does not attach a late B owner or revive A after departure and return', () => {
    const { dependencies, terminals } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    useCanvasStore
      .getState()
      .updateTab(result.panelId, result.tabId, { entityId: '/synthetic/B.png' });
    decode(beginImageRead({ tabId: result.tabId, filePath: '/synthetic/B.png' }, dependencies));
    useCanvasStore.getState().updateTab(result.panelId, result.tabId, { entityId: path });
    decode(beginImageRead({ tabId: result.tabId, filePath: path }, dependencies));
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
  });

  it('rejects a reused MIME hint or viewer generation changed after request custody was captured', () => {
    const { dependencies, terminals } = collector();
    const result = present(path, 'original.png');
    const old = beginImageRead(
      { tabId: result.tabId, filePath: path, sourceFileName: 'original.png' },
      dependencies
    );
    decode(old);
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    old.dispose();
    const replacement = beginImageRead(
      { tabId: result.tabId, filePath: path, sourceFileName: 'original.png' },
      dependencies
    );
    decode(replacement);
    admitImageOpen(request, present(path, 'original.png'));
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
    const hintRequest = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    useCanvasStore
      .getState()
      .updateTab(result.panelId, result.tabId, { sourceFileName: 'replacement.svg' });
    admitImageOpen(hintRequest, present(path));
    expect(terminals()).toHaveLength(2);
    expect(terminals()[1][1].action_phase).toBe('cancel');
  });

  it('latches refused start across later collection recovery and contains a throwing sender', () => {
    const { track, dependencies, terminals } = collector();
    track.mockReturnValue(false);
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    track.mockReturnValue(true);
    decode(owner);
    expect(track).toHaveBeenCalledTimes(1);
    expect(terminals()).toHaveLength(0);
    owner.dispose();
    track.mockReset().mockImplementation(() => {
      throw new Error('sender unavailable');
    });
    const retry = beginImageRead(
      { tabId: result.tabId, filePath: path, retry: true },
      dependencies
    );
    expect(() => decode(retry)).not.toThrow();
    expect(retry.isCurrent()).toBe(true);
  });

  it('does not carry an accepted request across a new episode, but permits a fresh reuse', () => {
    const { track, dependencies, terminals } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    owner.readStarted();
    beginTelemetryEpisode();
    track.mockClear();
    owner.bytesReady();
    owner.decoded();
    expect(track).not.toHaveBeenCalled();
    expect(terminals()).toHaveLength(0);
    const later = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    admitImageOpen(later, present());
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_reuse_ready');
  });

  it('does not persist or emit meaningful qualification if authority changes inside content projection', () => {
    const { track, dependencies } = collector();
    const pending = vi.fn(async () => undefined);
    dependencies.storePending = pending;
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    const owner = beginImageRead({ tabId: result.tabId, filePath: path }, dependencies);
    track.mockImplementation((_event, properties) => {
      if (properties.workflow === 'content') beginTelemetryEpisode();
      return true;
    });
    decode(owner);
    expect(pending).not.toHaveBeenCalled();
    expect(
      track.mock.calls.filter(([event]) => event === 'meaningful_activity_completed')
    ).toHaveLength(0);
  });

  it('uses real producer/app/SDK policies without private image fields or duplicate meaningful qualification', () => {
    const { track, dependencies } = collector();
    const request = beginImageOpenRequest({ filePath: path }, undefined, dependencies);
    const result = present();
    admitImageOpen(request, result);
    decode(beginImageRead({ tabId: result.tabId, filePath: path }, dependencies));
    for (const [event, properties] of track.mock.calls) {
      const safe = sanitizeClosedBetaProperties(properties);
      expect(safe).toEqual(properties);
      const egress = sanitizeSdkEvent(
        { event, properties: safe },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(egress?.properties).toMatchObject(safe);
      const text = JSON.stringify(egress);
      for (const sentinel of [
        path,
        result.tabId,
        'Private local label',
        'src',
        'naturalWidth',
        'pixels',
      ])
        expect(text).not.toContain(sentinel);
    }
    expect(
      track.mock.calls.filter(([event]) => event === 'meaningful_activity_completed')
    ).toHaveLength(1);
  });
});
