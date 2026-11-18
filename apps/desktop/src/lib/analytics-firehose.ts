import { CLICK_FIREHOSE_FLAG } from '@waypoint/analytics-policy';
import { STATIC_INTERACTION_CONTROLS } from '../shared/interaction-controls';

const LISTENED_EVENTS = [
  'click',
  'auxclick',
  'contextmenu',
  'keydown',
  'wheel',
  'dragstart',
  'drop',
  'focusin',
] as const;

const PRIVATE_INTERACTION_SELECTOR =
  '[data-ph-mask], [data-analytics-block], [data-ph-no-capture], .ph-no-capture, input[type="password"]';
const WHEEL_MIN_INTERVAL_MS = 250;
const KEY_REPEAT_MIN_INTERVAL_MS = 350;
const STATIC_CONTROL_IDS = new Set<string>(STATIC_INTERACTION_CONTROLS);
const CONTROL_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="combobox"]';

export interface AnalyticsFirehoseOptions {
  capture: (event: 'interaction_observed', properties: Record<string, unknown>) => void;
  isEnabled?: () => boolean;
  now?: () => number;
}

export function isClickFirehoseEnabled(
  getFlag: (key: string) => unknown,
  fallback = true
): boolean {
  const value = getFlag(CLICK_FIREHOSE_FLAG);
  if (value === false || value === 'false' || value === 0) return false;
  if (value === true || value === 'true' || value === 'on') return true;
  return fallback;
}

export function installAnalyticsFirehose(options: AnalyticsFirehoseOptions): () => void {
  if (typeof window === 'undefined') return () => {};
  const now = options.now ?? Date.now;
  const isEnabled = options.isEnabled ?? (() => true);
  let lastWheelAt = 0;
  let lastKeyAt = 0;

  const onEvent = (event: Event): void => {
    if (isPrivateInteraction(event)) return;
    if (!isEnabled()) return;
    const timestamp = now();
    if (event.type === 'wheel') {
      if (timestamp - lastWheelAt < WHEEL_MIN_INTERVAL_MS) return;
      lastWheelAt = timestamp;
    }
    if (event.type === 'keydown' && event instanceof KeyboardEvent && event.repeat) {
      if (timestamp - lastKeyAt < KEY_REPEAT_MIN_INTERVAL_MS) return;
    }
    if (event.type === 'keydown') lastKeyAt = timestamp;
    options.capture('interaction_observed', describeDomEvent(event, timestamp));
  };

  for (const type of LISTENED_EVENTS) {
    window.addEventListener(type, onEvent, { capture: true, passive: true });
  }
  return () => {
    for (const type of LISTENED_EVENTS) {
      window.removeEventListener(type, onEvent, { capture: true });
    }
  };
}

function isPrivateInteraction(event: Event): boolean {
  try {
    const target =
      event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
    if (target?.querySelector(PRIVATE_INTERACTION_SELECTOR)) return true;

    const path = [...event.composedPath(), ...(event.target ? [event.target] : [])];
    for (const entry of path) {
      let element =
        entry instanceof Element ? entry : entry instanceof Node ? entry.parentElement : null;
      while (element) {
        if (element.closest(PRIVATE_INTERACTION_SELECTOR)) return true;
        const root = element.getRootNode();
        element = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function describeDomEvent(event: Event, occurredAtMs: number): Record<string, unknown> {
  if (isPrivateInteraction(event)) {
    return { feature_area: 'navigation', event_type: event.type, occurred_at_ms: occurredAtMs };
  }
  const target = event.target instanceof Element ? event.target : null;
  const control = (
    target ?? (event.target instanceof Node ? event.target.parentElement : null)
  )?.closest(CONTROL_SELECTOR);
  const controlId = control?.getAttribute('data-testid');
  const properties: Record<string, unknown> = {
    feature_area: 'navigation',
    event_type: event.type,
    occurred_at_ms: occurredAtMs,
    target_tag: target?.tagName.toLowerCase() ?? 'unknown',
    target_test_id: structuralIdentifier(target?.getAttribute('data-testid')),
    target_id: structuralIdentifier(target?.id),
    target_role: target?.getAttribute('role') ?? undefined,
    target_name: target instanceof HTMLInputElement ? structuralIdentifier(target.name) : undefined,
    target_class: boundedText(target?.className?.toString?.()),
  };
  if (controlId && STATIC_CONTROL_IDS.has(controlId)) {
    properties.control_id = controlId;
    properties.control_relation = control === target ? 'direct' : 'ancestor';
  }
  if (
    (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent) ||
    event instanceof MouseEvent
  ) {
    properties.client_x = Math.round(event.clientX);
    properties.client_y = Math.round(event.clientY);
    properties.button = event.button;
    properties.pointer_type = 'pointerType' in event ? event.pointerType : 'mouse';
  }
  if (event instanceof WheelEvent) {
    properties.delta_x = event.deltaX;
    properties.delta_y = event.deltaY;
    properties.delta_z = event.deltaZ;
    properties.delta_mode = event.deltaMode;
  }
  if (event instanceof KeyboardEvent) {
    properties.repeat = event.repeat;
    properties.modifiers = modifiers(event);
  }
  if (typeof window !== 'undefined') {
    properties.viewport_width = window.innerWidth;
    properties.viewport_height = window.innerHeight;
  }
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== '')
  );
}

export function structuralIdentifier(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,120}$/.test(value) ? value : undefined;
}

function modifiers(event: KeyboardEvent): string | undefined {
  const parts = [
    event.metaKey ? 'meta' : '',
    event.ctrlKey ? 'ctrl' : '',
    event.altKey ? 'alt' : '',
    event.shiftKey ? 'shift' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('_') : undefined;
}

function boundedText(value: string | null | undefined, max = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length >= 24 && /^[acgtunrykswmbdhv\s]+$/i.test(trimmed)) return undefined;
  return trimmed.slice(0, max);
}
