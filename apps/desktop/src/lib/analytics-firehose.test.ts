import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../shared/analytics-registry.generated';
import {
  describeDomEvent,
  installAnalyticsFirehose,
  isClickFirehoseEnabled,
} from './analytics-firehose';

describe('click firehose', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
  it('defaults on and can be disabled by the PostHog flag', () => {
    expect(isClickFirehoseEnabled(() => undefined)).toBe(true);
    expect(isClickFirehoseEnabled(() => true)).toBe(true);
    expect(isClickFirehoseEnabled(() => false)).toBe(false);
    expect(isClickFirehoseEnabled(() => 'false')).toBe(false);
  });

  it('describes a button click by structure, never by its text or label', () => {
    const button = document.createElement('button');
    button.dataset.testid = 'explorer-open';
    button.textContent = 'Open KRAS_G12C.gb';
    button.title = '/Users/alice/Lab/KRAS_G12C.gb';
    button.setAttribute('aria-label', 'Open KRAS_G12C.gb');
    button.id = 'open-btn';
    const event = new MouseEvent('click', { clientX: 12, clientY: 40, bubbles: true });
    Object.defineProperty(event, 'target', { value: button });
    const properties = describeDomEvent(event, 1_700_000_000_000);
    expect(properties.event_type).toBe('click');
    expect(properties.target_test_id).toBe('explorer-open');
    expect(properties.target_id).toBe('open-btn');
    expect(properties.client_x).toBe(12);
    expect(properties).not.toHaveProperty('target_text');
    expect(properties).not.toHaveProperty('target_label');
    expect(properties).not.toHaveProperty('target_name');
    expect(JSON.stringify(properties)).not.toContain('KRAS');
  });

  it('drops ids and test ids built from file names or paths', () => {
    const host = document.createElement('div');
    host.dataset.testid = 'tab-content-container-/Users/alice/Lab/a.gb';
    host.id = 'feature My Promoter';
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: host });
    const properties = describeDomEvent(event, 1);
    expect(properties).not.toHaveProperty('target_test_id');
    expect(properties).not.toHaveProperty('target_id');
  });

  it('counts key presses without recording which key', () => {
    const input = document.createElement('input');
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      repeat: false,
      bubbles: true,
    });
    Object.defineProperty(event, 'target', { value: input });
    const properties = describeDomEvent(event, 5);
    expect(properties.event_type).toBe('keydown');
    expect(properties.occurred_at_ms).toBe(5);
    expect(properties.modifiers).toBe('meta');
    expect(properties.repeat).toBe(false);
    expect(properties).not.toHaveProperty('key');
    expect(properties).not.toHaveProperty('code');
  });

  it.each(['click', 'focusin', 'wheel', 'keydown'])(
    'attributes nested %s to an approved static control without replacing the direct target',
    (type) => {
      const button = document.body.appendChild(document.createElement('button'));
      button.dataset.testid = 'assembly-drawer-toggle';
      button.id = 'PRIVATE_SCIENTIFIC_ID';
      button.innerHTML = '<svg><path /></svg>';
      button.setAttribute('aria-label', 'PRIVATE_SCIENTIFIC_LABEL');
      const target = button.querySelector('path')!;
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      const properties = describeDomEvent(event, 5);
      expect(properties).toMatchObject({
        event_type: type,
        target_tag: 'path',
        control_id: 'assembly-drawer-toggle',
        control_relation: 'ancestor',
      });
      expect(properties).not.toHaveProperty('target_id');
      expect(properties).not.toHaveProperty('target_test_id');
      expect(JSON.stringify(properties)).not.toContain('PRIVATE_SCIENTIFIC');
    }
  );

  it('adds direct control attribution while preserving direct structural identifiers', () => {
    const button = document.body.appendChild(document.createElement('button'));
    button.dataset.testid = 'assembly-drawer-toggle';
    button.id = 'open-btn';
    const event = new MouseEvent('click');
    Object.defineProperty(event, 'target', { value: button });
    expect(describeDomEvent(event, 5)).toMatchObject({
      target_tag: 'button',
      target_id: 'open-btn',
      target_test_id: 'assembly-drawer-toggle',
      control_id: 'assembly-drawer-toggle',
      control_relation: 'direct',
    });
  });

  it.each([
    'sample_KRAS_G12C',
    'assembly-drawer-toggle-private',
    '33850000-0000-4000-8000-000000000001',
  ])('rejects unapproved ancestor identifiers such as %s', (id) => {
    const outer = document.body.appendChild(document.createElement('button'));
    outer.dataset.testid = 'assembly-drawer-toggle';
    const inner = outer.appendChild(document.createElement('button'));
    inner.dataset.testid = id;
    inner.id = id;
    const target = inner.appendChild(document.createElement('span'));
    const event = new MouseEvent('click');
    Object.defineProperty(event, 'target', { value: target });
    const properties = describeDomEvent(event, 5);
    expect(properties).not.toHaveProperty('control_id');
    expect(properties).not.toHaveProperty('control_relation');
    expect(JSON.stringify(properties)).not.toContain(id);
  });

  it('sanitizes control attribution through the finite runtime vocabulary', () => {
    expect(
      sanitizeClosedBetaProperties({
        control_id: 'assembly-drawer-toggle',
        control_relation: 'ancestor',
      })
    ).toEqual({ control_id: 'assembly-drawer-toggle', control_relation: 'ancestor' });
    expect(
      sanitizeClosedBetaProperties({
        control_id: 'sample_KRAS_G12C',
        control_relation: 'PRIVATE_SCIENTIFIC_LABEL',
      })
    ).toEqual({});
  });

  it('retains static control attribution through the generated SDK egress policy', () => {
    const properties = sanitizeClosedBetaProperties({
      feature_area: 'navigation',
      event_type: 'click',
      target_tag: 'span',
      control_id: 'assembly-drawer-toggle',
      control_relation: 'ancestor',
    });
    const event = sanitizeSdkEvent(
      { event: 'interaction_observed', properties },
      'desktop',
      'test',
      CLOSED_BETA_EVENT_PROPERTIES,
      undefined,
      CLOSED_BETA_EVENT_VERSIONS
    );
    expect(event?.properties).toMatchObject(properties);
    expect(event?.properties.event_version).toBe(2);
  });

  it('throttles wheel events so a burst cannot starve later captures', () => {
    const capture = vi.fn();
    let now = 1_000;
    const uninstall = installAnalyticsFirehose({
      capture,
      now: () => now,
    });
    for (let i = 0; i < 20; i += 1) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
      now += 10;
    }
    expect(capture.mock.calls.length).toBeLessThanOrEqual(2);
    now += 300;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    expect(capture.mock.calls.at(-1)?.[0]).toBe('interaction_observed');
    uninstall();
  });
  it.each(['data-ph-mask', 'data-analytics-block', 'data-ph-no-capture', 'ph-no-capture'])(
    'honors the existing %s privacy boundary for descendant interactions',
    (marker) => {
      const container = document.createElement('div');
      if (marker === 'ph-no-capture') container.className = marker;
      else container.setAttribute(marker, '');
      const button = document.createElement('button');
      button.id = 'PRIVATE_RECORD_ID';
      button.setAttribute('aria-label', 'PRIVATE_RECORD_NAME');
      button.textContent = 'PRIVATE_RECORD_NAME';
      container.append(button);
      document.body.append(container);
      const capture = vi.fn();
      const uninstall = installAnalyticsFirehose({ capture, now: () => 1_000 });
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        button.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })
        );
        button.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true }));
        button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(capture).not.toHaveBeenCalled();
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true })
        );
        expect(capture).not.toHaveBeenCalled();
        container.remove();
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture.mock.calls[0][1]).toMatchObject({ event_type: 'click', target_tag: 'body' });
        expect(JSON.stringify(capture.mock.calls[0][1])).not.toContain('PRIVATE_RECORD_NAME');
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true })
        );
        expect(capture.mock.calls[1][1]).not.toHaveProperty('key');
        expect(capture.mock.calls[1][1]).not.toHaveProperty('code');
      } finally {
        uninstall();
        container.remove();
      }
    }
  );

  it('never records typing or focus in an unmarked password field', () => {
    const field = document.createElement('input');
    field.type = 'password';
    document.body.append(field);
    const capture = vi.fn();
    const uninstall = installAnalyticsFirehose({ capture });
    try {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(capture).not.toHaveBeenCalled();
    } finally {
      uninstall();
      field.remove();
    }
  });
});

describe('private manual interaction boundary', () => {
  const events = [
    'click',
    'auxclick',
    'contextmenu',
    'keydown',
    'wheel',
    'dragstart',
    'drop',
    'focusin',
  ];
  const markers = [
    'data-ph-mask',
    'data-analytics-block',
    'data-ph-no-capture',
    'ph-no-capture',
    'password',
  ];
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  function listen() {
    const capture = vi.fn();
    const now = vi.fn(() => 1000);
    cleanups.push(installAnalyticsFirehose({ capture, now }));
    return { capture, now };
  }
  function event(type: string): Event {
    return type === 'keydown'
      ? new KeyboardEvent(type, { key: 'z', code: 'KeyZ', bubbles: true, composed: true })
      : new Event(type, { bubbles: true, composed: true });
  }
  function mark(element: Element, marker: string): void {
    if (marker === 'ph-no-capture') element.classList.add(marker);
    else if (marker === 'password') element.setAttribute('type', 'password');
    else element.setAttribute(marker, 'true');
  }

  it.each(markers)(
    'rejects every route on/inside %s before description or clock access',
    (marker) => {
      const { capture, now } = listen();
      const root = document.createElement(marker === 'password' ? 'input' : 'section');
      mark(root, marker);
      const child = marker === 'password' ? root : root.appendChild(document.createElement('span'));
      document.body.append(root);
      Object.defineProperty(child, 'textContent', {
        get() {
          throw new Error('private description read');
        },
      });
      for (const type of events) child.dispatchEvent(event(type));
      expect(capture).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    }
  );

  it('rejects nested SVG and text-node targets', () => {
    const { capture } = listen();
    const root = document.createElement('section');
    root.setAttribute('data-analytics-block', 'true');
    root.innerHTML = '<button><svg><g><path /></g></svg></button><span>harmless decoy</span>';
    document.body.append(root);
    root.querySelector('path')!.dispatchEvent(event('click'));
    root.querySelector('span')!.firstChild!.dispatchEvent(event('focusin'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects private composed paths behind an unmarked open shadow host', () => {
    const { capture, now } = listen();
    const host = document.body.appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    const privateRoot = shadow.appendChild(document.createElement('section'));
    privateRoot.classList.add('ph-no-capture');
    const textarea = privateRoot.appendChild(document.createElement('textarea'));
    textarea.value = 'harmless private decoy';
    for (const type of events) textarea.dispatchEvent(event(type));
    expect(capture).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('rejects slotted descendants, marked closed hosts and marked portal roots', () => {
    const { capture } = listen();
    const host = document.body.appendChild(document.createElement('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section data-ph-no-capture><slot></slot></section>';
    const slotChild = host.appendChild(document.createElement('span'));
    const closed = document.body.appendChild(document.createElement('div'));
    closed.setAttribute('data-analytics-block', 'true');
    const closedChild = closed
      .attachShadow({ mode: 'closed' })
      .appendChild(document.createElement('button'));
    const portal = document.body.appendChild(document.createElement('aside'));
    portal.setAttribute('data-ph-no-capture', '');
    const portalChild = portal.appendChild(document.createElement('textarea'));
    for (const child of [slotChild, closedChild, portalChild])
      for (const type of events) child.dispatchEvent(event(type));
    expect(capture).not.toHaveBeenCalled();
  });

  it('refuses an aggregate target containing marked private text before capture or clock access', () => {
    const { capture, now } = listen();
    const parent = document.body.appendChild(document.createElement('button'));
    parent.innerHTML = 'Safe <span data-ph-mask>harmless hidden decoy</span>';
    parent.dispatchEvent(event('click'));
    expect(capture).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('keeps safe controls, opt-out and cleanup functional', () => {
    let enabled = false;
    const capture = vi.fn();
    const uninstall = installAnalyticsFirehose({ capture, isEnabled: () => enabled });
    cleanups.push(uninstall);
    const safe = document.body.appendChild(document.createElement('button'));
    safe.dataset.testid = 'safe-control';
    safe.textContent = 'Open';
    const label = 'NONFUNCTIONAL_PUBLIC_LABEL_SENTINEL';
    safe.setAttribute('aria-label', label);
    safe.dispatchEvent(event('click'));
    expect(capture).not.toHaveBeenCalled();
    enabled = true;
    safe.dispatchEvent(event('click'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toMatchObject({
      feature_area: 'navigation',
      event_type: 'click',
      occurred_at_ms: expect.any(Number),
      target_tag: 'button',
      target_test_id: 'safe-control',
    });
    expect(capture.mock.calls[0][1]).not.toHaveProperty('target_text');
    expect(capture.mock.calls[0][1]).not.toHaveProperty('target_label');
    expect(JSON.stringify(capture.mock.calls[0][1])).not.toContain('Open');
    expect(JSON.stringify(capture.mock.calls[0][1])).not.toContain(label);
    uninstall();
    safe.dispatchEvent(event('click'));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('F27 credential ingress regressions', () => {
  it.each(['data-ph-mask', 'data-analytics-block', 'data-ph-no-capture', 'class'])(
    'excludes credential ancestors, descendants and aggregate parents before private getters (%s)',
    (marker) => {
      const root = document.createElement('section');
      const privateRoot = document.createElement('div');
      privateRoot.setAttribute(marker, marker === 'class' ? 'ph-no-capture' : '');
      const key = document.createElement('code');
      const child = document.createElement('span');
      child.textContent = 'NONFUNCTIONAL_CREDENTIAL_SENTINEL';
      key.appendChild(child);
      privateRoot.appendChild(key);
      root.appendChild(privateRoot);
      document.body.appendChild(root);
      const captures = vi.fn();
      const descriptionRead = vi.fn(() => {
        throw new Error('private DOM was read');
      });
      for (const node of [root, privateRoot, key, child]) {
        Object.defineProperty(node, 'textContent', { get: descriptionRead });
        Object.defineProperty(node, 'ariaLabel', { get: descriptionRead });
      }
      const uninstall = installAnalyticsFirehose({ capture: captures, now: () => 5_000 });
      try {
        for (const node of [root, privateRoot, key, child]) {
          for (const type of [
            'click',
            'auxclick',
            'contextmenu',
            'focusin',
            'wheel',
            'dragstart',
            'drop',
          ]) {
            node.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
          }
          node.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'PRIVATE_KEY_SENTINEL',
              bubbles: true,
              composed: true,
            })
          );
          const event = new Event('click');
          Object.defineProperty(event, 'target', { value: node });
          expect(describeDomEvent(event, 1)).toEqual({
            feature_area: 'navigation',
            event_type: 'click',
            occurred_at_ms: 1,
          });
        }
        expect(descriptionRead).not.toHaveBeenCalled();
        expect(captures).not.toHaveBeenCalled();
        const safe = document.createElement('button');
        safe.dataset.testid = 'static-public-control';
        safe.textContent = 'Open';
        document.body.appendChild(safe);
        safe.click();
        expect(captures).toHaveBeenCalledExactlyOnceWith(
          'interaction_observed',
          expect.objectContaining({ target_test_id: 'static-public-control' })
        );
        safe.remove();
      } finally {
        uninstall();
        root.remove();
      }
    }
  );

  it('excludes private shadow paths and fails closed when the composed path is unavailable', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const privateRoot = document.createElement('div');
    privateRoot.dataset.analyticsBlock = '';
    const child = document.createElement('button');
    child.textContent = 'NONFUNCTIONAL_SHADOW_CREDENTIAL';
    privateRoot.appendChild(child);
    shadow.appendChild(privateRoot);
    const capture = vi.fn();
    const uninstall = installAnalyticsFirehose({ capture });
    try {
      child.click();
      const unreadable = new Event('click', { bubbles: true });
      Object.defineProperty(unreadable, 'composedPath', {
        value: () => {
          throw new Error('unreadable');
        },
      });
      host.dispatchEvent(unreadable);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      uninstall();
      host.remove();
    }
  });
});
