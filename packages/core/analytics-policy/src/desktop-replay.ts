export const DESKTOP_REPLAY_BLOCK_ATTRIBUTE = 'data-replay-block';

export const DESKTOP_SESSION_RECORDING_CONFIG = {
  maskAllInputs: true,
  maskTextSelector: '*',
  blockSelector: `[${DESKTOP_REPLAY_BLOCK_ATTRIBUTE}], [data-ph-no-capture], [data-analytics-block], .ph-no-capture, .rr-block`,
  captureCanvas: { recordCanvas: false },
  recordHeaders: false,
  recordBody: false,
  recordCrossOriginIframes: false,
  collectFonts: false,
  compress_events: false,
} as const;

const EVENT_DOM_CONTENT_LOADED = 0;
const EVENT_LOAD = 1;
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const EVENT_META = 4;
const EVENT_CUSTOM = 5;
const EVENT_PLUGIN = 6;

const SOURCE_MUTATION = 0;
const SOURCE_INPUT = 5;
const SOURCE_STYLE_DECLARATION = 13;
const STYLESHEET_SOURCES = new Set([8, SOURCE_STYLE_DECLARATION, 15]);
const POINTER_SCROLL_VIEWPORT_AND_MEDIA_SOURCES = new Set([1, 2, 3, 4, 6, 7, 12, 14, 16]);

const NODE_ELEMENT = 2;
const NODE_TEXT = 3;
const NODE_DOCUMENT = 0;
const NODE_DOCUMENT_TYPE = 1;
const NODE_CDATA = 4;
const NODE_COMMENT = 5;

const LOCATION_CUSTOM_TAGS = new Set(['$pageview', '$url_changed']);
const RECORDER_LIFECYCLE_CUSTOM_TAGS = new Set([
  '$session_id_change',
  '$session_ending',
  '$session_starting',
  '$recording_started',
  'sessionIdle',
  'sessionNoLongerIdle',
  'samplingDecisionMade',
  'recording paused',
  'recording resumed',
  'browser offline',
  'browser online',
]);
const ID_OR_ENUM_TOKEN = /^[\w.:-]{1,64}$/;

const CSS_STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const CSS_QUOTED_STRING = new RegExp(CSS_STRING, 'g');
const CSS_URL = new RegExp(String.raw`url\(\s*(?:${CSS_STRING}|(?:[^)\\]|\\.)*)\s*\)`, 'gi');
const CSS_TEXT_BEARING_DECLARATION = new RegExp(
  String.raw`(--[\w-]+|\bcontent|\bquotes)(\s*:\s*)((?:${CSS_STRING}|[^;}"'])*)`,
  'gi'
);

const NETWORK_PLUGIN = 'rrweb/network@1';
const NETWORK_TIMING_KEYS = new Set([
  'method',
  'status',
  'initiatorType',
  'entryType',
  'timestamp',
  'startTime',
  'endTime',
  'duration',
  'transferSize',
  'encodedBodySize',
  'decodedBodySize',
  'responseStatus',
  'isInitial',
]);

const LAYOUT_STATE_AND_SVG_GEOMETRY_ATTRIBUTES = new Set([
  'class',
  'role',
  'tabindex',
  'hidden',
  'dir',
  'draggable',
  'contenteditable',
  'disabled',
  'checked',
  'selected',
  'multiple',
  'readonly',
  'required',
  'open',
  'type',
  'rel',
  'media',
  'colspan',
  'rowspan',
  'width',
  'height',
  'rr_width',
  'rr_height',
  'rr_left',
  'rr_top',
  'rr_scrollLeft',
  'rr_scrollTop',
  'rr_mediaState',
  'rr_mediaCurrentTime',
  'rr_mediaPlaybackRate',
  'rr_mediaMuted',
  'rr_mediaLoop',
  'rr_mediaVolume',
  'aria-hidden',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-pressed',
  'aria-disabled',
  'aria-current',
  'aria-orientation',
  'aria-level',
  'aria-haspopup',
  'aria-modal',
  'aria-busy',
  'aria-invalid',
  'aria-sort',
  'aria-valuemin',
  'aria-valuemax',
  'aria-valuenow',
  'viewBox',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'transform',
  'xmlns',
  'xmlns:xlink',
  'version',
  'preserveAspectRatio',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'stop-color',
  'stop-opacity',
  'text-anchor',
  'dominant-baseline',
  'font-size',
  'font-weight',
  'pathLength',
  'vector-effect',
  'shape-rendering',
]);

const WIDGET_STATE_ATTRIBUTES = new Set([
  'data-state',
  'data-side',
  'data-align',
  'data-orientation',
  'data-disabled',
  'data-highlighted',
  'data-placeholder',
]);
const SHORT_ENUM_VALUE = /^[a-z-]{0,24}$/;

const SVG_ID = /^[A-Za-z][\w-]{0,63}$/;
const SVG_REFERENCE_ATTRIBUTES = new Set([
  'clip-path',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
]);
const LOCAL_SVG_REFERENCE = /^url\(#[\w-]{1,64}\)$/;

const DROP = Symbol('drop');
type Sanitized = unknown | typeof DROP;

export function sanitizeDesktopReplayData(data: unknown, safeHref: string): unknown | null {
  if (Array.isArray(data)) {
    const events = data.map((event) => sanitizeEvent(event, safeHref)).filter(isKept);
    return events.length > 0 ? events : null;
  }
  const event = sanitizeEvent(data, safeHref);
  return isKept(event) ? event : null;
}

function isKept(value: Sanitized): value is unknown {
  return value !== DROP;
}

function sanitizeEvent(event: unknown, safeHref: string): Sanitized {
  if (!isRecord(event) || !Number.isInteger(event.type)) return DROP;
  if (isCompressedPostHogEvent(event)) return DROP;
  const data = event.data;
  switch (event.type) {
    case EVENT_DOM_CONTENT_LOADED:
    case EVENT_LOAD:
      return { ...event, data: {} };
    case EVENT_FULL_SNAPSHOT: {
      if (!isRecord(data)) return DROP;
      const node = sanitizeNode(data.node);
      return node === DROP ? DROP : { ...event, data: { ...data, node } };
    }
    case EVENT_INCREMENTAL:
      return isRecord(data) ? withData(event, sanitizeIncremental(data)) : DROP;
    case EVENT_META:
      if (!isRecord(data)) return DROP;
      return {
        ...event,
        data: {
          href: safeHref,
          width: finiteOrZero(data.width),
          height: finiteOrZero(data.height),
        },
      };
    case EVENT_CUSTOM:
      if (!isRecord(data) || typeof data.tag !== 'string') return DROP;
      if (LOCATION_CUSTOM_TAGS.has(data.tag)) {
        return { ...event, data: { tag: data.tag, payload: { href: safeHref } } };
      }
      if (RECORDER_LIFECYCLE_CUSTOM_TAGS.has(data.tag)) {
        return {
          ...event,
          data: { tag: data.tag, payload: idsNumbersAndFlags(data.payload) ?? {} },
        };
      }
      return DROP;
    case EVENT_PLUGIN:
      return isRecord(data) ? withData(event, sanitizePlugin(data)) : DROP;
    default:
      return DROP;
  }
}

function isCompressedPostHogEvent(event: Record<string, unknown>): boolean {
  return 'cv' in event;
}

function withData(event: Record<string, unknown>, data: Sanitized): Sanitized {
  return data === DROP ? DROP : { ...event, data };
}

function sanitizeIncremental(data: Record<string, unknown>): Sanitized {
  const source = data.source;
  if (source === SOURCE_MUTATION) {
    return {
      ...data,
      texts: arrayOf(data.texts).flatMap((text) =>
        isRecord(text) ? [{ ...text, value: maskText(text.value) }] : []
      ),
      attributes: arrayOf(data.attributes).flatMap((change) =>
        isRecord(change) && isRecord(change.attributes)
          ? [{ ...change, attributes: sanitizeAttributes(change.attributes, false, true) }]
          : []
      ),
      adds: arrayOf(data.adds).flatMap((add) => {
        if (!isRecord(add)) return [];
        const node = sanitizeNode(add.node);
        return node === DROP ? [] : [{ ...add, node }];
      }),
      removes: arrayOf(data.removes),
    };
  }
  if (source === SOURCE_INPUT) return { ...data, text: maskText(data.text) };
  if (typeof source !== 'number') return DROP;
  if (source === SOURCE_STYLE_DECLARATION && isRecord(data.set)) {
    const { property, value } = data.set;
    return { ...data, set: { ...data.set, value: sanitizeCssDeclaration(property, value) } };
  }
  if (STYLESHEET_SOURCES.has(source)) return sanitizeCssStrings(data);
  return POINTER_SCROLL_VIEWPORT_AND_MEDIA_SOURCES.has(source) ? data : DROP;
}

function sanitizeNode(node: unknown): Sanitized {
  if (!isRecord(node) || !Number.isInteger(node.type)) return DROP;
  const next: Record<string, unknown> = { ...node };
  if (node.type === NODE_TEXT) {
    next.textContent =
      node.isStyle === true ? sanitizeCssText(node.textContent) : maskText(node.textContent);
  } else if (node.type === NODE_COMMENT || node.type === NODE_CDATA) {
    next.textContent = '';
  } else if (
    node.type !== NODE_DOCUMENT &&
    node.type !== NODE_DOCUMENT_TYPE &&
    node.type !== NODE_ELEMENT
  ) {
    return DROP;
  } else if (node.type === NODE_ELEMENT) {
    next.attributes = isRecord(node.attributes)
      ? sanitizeAttributes(node.attributes, node.isSVG === true, false)
      : {};
  }
  if (Array.isArray(node.childNodes)) {
    next.childNodes = node.childNodes.map(sanitizeNode).filter(isKept);
  }
  return next;
}

function sanitizeAttributes(
  attributes: Record<string, unknown>,
  isSvg: boolean,
  isMutation: boolean
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const isAttributeRemoval = isMutation && value === null;
    if (isAttributeRemoval) {
      kept[name] = null;
    } else if (name === 'style') {
      kept[name] = sanitizeStyle(value);
    } else if (name === '_cssText') {
      kept[name] = sanitizeCssText(value);
    } else if (LAYOUT_STATE_AND_SVG_GEOMETRY_ATTRIBUTES.has(name)) {
      kept[name] = value;
    } else if (WIDGET_STATE_ATTRIBUTES.has(name)) {
      if (typeof value === 'string' && SHORT_ENUM_VALUE.test(value)) kept[name] = value;
    } else if (name === 'id') {
      if (isSvg && typeof value === 'string' && SVG_ID.test(value)) kept[name] = value;
    } else if (SVG_REFERENCE_ATTRIBUTES.has(name)) {
      if (typeof value === 'string' && LOCAL_SVG_REFERENCE.test(value)) kept[name] = value;
    } else if (name === 'href' || name === 'xlink:href') {
      if (isSvg && typeof value === 'string' && /^#[\w-]{1,64}$/.test(value)) kept[name] = value;
    }
  }
  return kept;
}

function sanitizeStyle(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeCssText(value);
  if (!isRecord(value)) return '';
  return Object.fromEntries(
    Object.entries(value).map(([property, entry]) => [
      property,
      Array.isArray(entry)
        ? [sanitizeCssDeclaration(property, entry[0]), entry[1]]
        : sanitizeCssDeclaration(property, entry),
    ])
  );
}

function sanitizeCssText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(CSS_URL, 'none')
    .replace(
      CSS_TEXT_BEARING_DECLARATION,
      (_declaration, property: string, separator: string, declared: string) =>
        `${property}${separator}${declared.replace(CSS_QUOTED_STRING, '""')}`
    );
}

function sanitizeCssDeclaration(property: unknown, value: unknown): unknown {
  if (typeof property !== 'string' || typeof value !== 'string') return value;
  const declaration = sanitizeCssText(`${property}:${value}`) as string;
  return declaration.slice(property.length + 1);
}

function sanitizeCssStrings(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeCssText(value);
  if (Array.isArray(value)) return value.map(sanitizeCssStrings);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeCssStrings(entry)])
  );
}

function sanitizePlugin(data: Record<string, unknown>): Sanitized {
  if (data.plugin !== NETWORK_PLUGIN || !isRecord(data.payload)) return DROP;
  const requests = arrayOf(data.payload.requests).flatMap((request) => {
    if (!isRecord(request)) return [];
    const timing: Record<string, unknown> = { name: urlOrigin(request.name) };
    for (const [key, value] of Object.entries(request)) {
      if (NETWORK_TIMING_KEYS.has(key) && isScalar(value)) timing[key] = value;
    }
    return [timing];
  });
  return { plugin: NETWORK_PLUGIN, payload: { requests } };
}

function idsNumbersAndFlags(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return ID_OR_ENUM_TOKEN.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map(idsNumbersAndFlags).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, idsNumbersAndFlags(entry)])
      .filter(([, entry]) => entry !== undefined)
  );
}

function urlOrigin(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
  } catch {
    return 'unknown';
  }
}

function maskText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\S/g, '*') : value;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
