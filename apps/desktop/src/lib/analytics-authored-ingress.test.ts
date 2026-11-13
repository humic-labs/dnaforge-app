import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RECORDING_CONFIG } from '@waypoint/analytics-policy';
import {
  TELEMETRY_BLOCKED_ATTRIBUTES,
  TELEMETRY_BLOCKED_CLASS,
} from '../components/TelemetryBlockedSurface';
import { describeDomEvent, installAnalyticsFirehose } from './analytics-firehose';

const routes = [
  'click',
  'auxclick',
  'contextmenu',
  'keydown',
  'wheel',
  'dragstart',
  'drop',
  'focusin',
] as const;
const markers = [
  'data-ph-mask',
  'data-analytics-block',
  'data-ph-no-capture',
  'ph-no-capture',
  'password',
] as const;
type Marker = (typeof markers)[number];
const dispose: Array<() => void> = [];

afterEach(() => {
  dispose
    .splice(0)
    .reverse()
    .forEach((release) => release());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function gesture(type: (typeof routes)[number]): Event {
  const options = { bubbles: true, composed: true };
  if (type === 'keydown') return new KeyboardEvent(type, { ...options, key: 'k', code: 'KeyK' });
  if (type === 'wheel') return new WheelEvent(type, { ...options, deltaY: 20 });
  if (type === 'click' || type === 'auxclick' || type === 'contextmenu') {
    return new MouseEvent(type, { ...options, clientX: 17, clientY: 29, button: 1 });
  }
  return new Event(type, options);
}
function mark(element: Element, marker: Marker): void {
  if (marker === 'ph-no-capture') element.classList.add(marker);
  else if (marker === 'password') element.setAttribute('type', 'password');
  else element.setAttribute(marker, '');
}
function privateTree(marker: Marker): { root: HTMLElement; child: HTMLElement } {
  const root = document.createElement(marker === 'password' ? 'input' : 'section');
  mark(root, marker);
  const child = marker === 'password' ? root : root.appendChild(document.createElement('span'));
  child.textContent = 'NONFUNCTIONAL_UNION_PRIVATE_SENTINEL';
  document.body.appendChild(root);
  return { root, child };
}
function trapMetadata(element: Element) {
  const read = vi.fn(() => {
    throw new Error('Controlled private metadata getter reached');
  });
  Object.defineProperty(element, 'textContent', { configurable: true, get: read });
  Object.defineProperty(element, 'ariaLabel', { configurable: true, get: read });
  return read;
}
function listen(isEnabled = () => true) {
  const capture = vi.fn();
  const now = vi.fn(() => 5000);
  dispose.push(installAnalyticsFirehose({ capture, now, isEnabled }));
  return { capture, now };
}
function direct(type: (typeof routes)[number], target: Node, path?: EventTarget[]): Event {
  const event = gesture(type);
  Object.defineProperty(event, 'target', { value: target });
  if (path) Object.defineProperty(event, 'composedPath', { value: () => path });
  return event;
}
function minimal(type: string) {
  return { feature_area: 'navigation', event_type: type, occurred_at_ms: 1234 };
}

describe('shared authored ingress union', () => {
  it.each(markers)(
    'drops aggregate-parent events before clock, metadata and capture (%s)',
    (marker) => {
      const { capture, now } = listen();
      const parent = document.createElement('section');
      const { root } = privateTree(marker);
      parent.appendChild(root);
      document.body.appendChild(parent);
      const read = trapMetadata(parent);
      for (const route of routes) parent.dispatchEvent(gesture(route));
      expect(read).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    }
  );

  it.each(markers)(
    'direct descriptors retain only the event shell for private targets (%s)',
    (marker) => {
      const { root, child } = privateTree(marker);
      const read = trapMetadata(child);
      for (const route of routes) {
        expect(
          describeDomEvent(
            direct(route, child, [child, root, document.body, document, window]),
            1234
          )
        ).toEqual(minimal(route));
      }
      expect(read).not.toHaveBeenCalled();
    }
  );

  it('direct descriptors refuse an unmarked aggregate target and a private retargeted shadow path', () => {
    const parent = document.createElement('section');
    const { root } = privateTree('data-ph-mask');
    parent.appendChild(root);
    document.body.appendChild(parent);
    expect(describeDomEvent(direct('click', parent), 1234)).toEqual(minimal('click'));
    const host = document.body.appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    const privateRoot = shadow.appendChild(document.createElement('section'));
    mark(privateRoot, 'data-ph-no-capture');
    const child = privateRoot.appendChild(document.createElement('button'));
    const read = trapMetadata(host);
    expect(
      describeDomEvent(
        direct('keydown', host, [
          child,
          privateRoot,
          shadow,
          host,
          document.body,
          document,
          window,
        ]),
        1234
      )
    ).toEqual(minimal('keydown'));
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['composedPath', 'closest', 'getRootNode', 'querySelector'] as const)(
    'fails closed for an unreadable boundary API (%s)',
    (method) => {
      const target = document.body.appendChild(document.createElement('button'));
      target.textContent = 'NONFUNCTIONAL_UNREADABLE_SENTINEL';
      const event = direct('click', target);
      const unavailable = () => {
        throw new Error('Controlled boundary API unavailable');
      };
      if (method === 'composedPath') Object.defineProperty(event, method, { value: unavailable });
      else Object.defineProperty(target, method, { configurable: true, value: unavailable });
      expect(describeDomEvent(event, 1234)).toEqual(minimal('click'));

      const { capture, now } = listen();
      const errors: ErrorEvent[] = [];
      const onError = (error: ErrorEvent) => {
        errors.push(error);
        error.preventDefault();
      };
      window.addEventListener('error', onError);
      dispose.push(() => window.removeEventListener('error', onError));
      const dispatched = gesture('click');
      if (method === 'composedPath')
        Object.defineProperty(dispatched, method, { value: unavailable });
      target.dispatchEvent(dispatched);
      expect(errors).toEqual([]);
      expect(capture).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    }
  );

  it('preserves concrete public controls beside a private Search-like surface, opt-out and cleanup', () => {
    let enabled = true;
    const { capture } = listen(() => enabled);
    privateTree('data-analytics-block');
    const button = document.body.appendChild(document.createElement('button'));
    button.dataset.testid = 'union-public-control';
    button.textContent = 'Open';
    const label = 'NONFUNCTIONAL_PUBLIC_LABEL_SENTINEL';
    button.setAttribute('aria-label', label);
    for (const route of routes) button.dispatchEvent(gesture(route));
    expect(capture).toHaveBeenCalledTimes(routes.length);
    expect(capture.mock.calls.map(([, properties]) => properties.event_type)).toEqual(routes);
    for (const [name, properties] of capture.mock.calls) {
      expect(name).toBe('interaction_observed');
      expect(properties).toMatchObject({
        feature_area: 'navigation',
        occurred_at_ms: 5000,
        target_tag: 'button',
        target_test_id: 'union-public-control',
      });
      expect(properties).not.toHaveProperty('target_text');
      expect(properties).not.toHaveProperty('target_label');
      expect(JSON.stringify(properties)).not.toContain('Open');
      expect(JSON.stringify(properties)).not.toContain(label);
    }
    enabled = false;
    button.dispatchEvent(gesture('click'));
    expect(capture).toHaveBeenCalledTimes(routes.length);
    dispose.splice(0).forEach((release) => release());
    enabled = true;
    button.dispatchEvent(gesture('click'));
    expect(capture).toHaveBeenCalledTimes(routes.length);
  });

  it('distinguishes a text mask from the explicit full-subtree replay block configuration', () => {
    const maskOnly = document.createElement('span');
    maskOnly.setAttribute('data-ph-mask', '');
    const fullBlock = document.createElement('section');
    fullBlock.className = TELEMETRY_BLOCKED_CLASS;
    for (const [attribute, value] of Object.entries(TELEMETRY_BLOCKED_ATTRIBUTES))
      fullBlock.setAttribute(attribute, value);
    expect(maskOnly.matches(SESSION_RECORDING_CONFIG.maskTextSelector)).toBe(true);
    expect(maskOnly.matches('[data-analytics-block], [data-ph-no-capture], .ph-no-capture')).toBe(
      false
    );
    const selector: unknown = Reflect.get(SESSION_RECORDING_CONFIG, 'blockSelector');
    expect(typeof selector).toBe('string');
    if (typeof selector !== 'string')
      throw new Error('Full-subtree replay selector is not configured');
    expect(fullBlock.matches(selector)).toBe(true);
    const classOnly = document.createElement('section');
    classOnly.className = TELEMETRY_BLOCKED_CLASS;
    expect(classOnly.matches(selector)).toBe(true);
    expect(maskOnly.matches(selector)).toBe(false);
    for (const attribute of Object.keys(TELEMETRY_BLOCKED_ATTRIBUTES)) {
      const attributeOnly = document.createElement('section');
      attributeOnly.setAttribute(attribute, '');
      expect(attributeOnly.matches(selector)).toBe(true);
    }
    expect(SESSION_RECORDING_CONFIG.maskInputOptions.password).toBe(true);
  });
});
