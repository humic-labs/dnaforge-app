import { Buffer } from 'node:buffer';
import { DOMParser } from 'linkedom';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const MAX_SVG_BYTES = 1024 * 1024;
const STATIC_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'symbol',
  'use',
]);
const STYLE_PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'word-spacing',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'mask',
  'stop-color',
  'stop-opacity',
]);
const FRAGMENT = /^#[A-Za-z_][\w:.-]*$/u;
const SVG_ATTRIBUTE_CASE = new Map(
  [
    'viewBox',
    'preserveAspectRatio',
    'gradientUnits',
    'gradientTransform',
    'clipPathUnits',
    'maskUnits',
    'maskContentUnits',
    'patternUnits',
    'patternContentUnits',
    'patternTransform',
    'markerUnits',
    'markerWidth',
    'markerHeight',
    'refX',
    'refY',
    'textLength',
    'lengthAdjust',
    'startOffset',
    'pathLength',
    'spreadMethod',
  ].map((name) => [name.toLowerCase(), name])
);

export type StaticSvgImage =
  | { kind: 'image'; src: string }
  | { kind: 'unavailable'; reason: string };

type SvgElement = {
  localName: string;
  attributes: Iterable<{ name: string; value: string }>;
  querySelectorAll(selector: string): Iterable<SvgElement>;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  outerHTML: string;
};

function xmlWithHtmlEntities(source: string): string {
  const decoded = new Map<string, string>();
  return source.replace(/&[a-z][a-z0-9]+;/giu, (entity) => {
    const cached = decoded.get(entity);
    if (cached !== undefined) return cached;
    const text: string =
      new DOMParser().parseFromString(`<span>${entity}</span>`, 'text/html').documentElement
        .textContent ?? entity;
    const replacement = Array.from(text, (character) => `&#${character.codePointAt(0)};`).join('');
    decoded.set(entity, replacement);
    return replacement;
  });
}

export function staticSvgImage(source: string | undefined): StaticSvgImage {
  const unavailable = (reason: string): StaticSvgImage => ({ kind: 'unavailable', reason });
  if (!source || Buffer.byteLength(source, 'utf8') > MAX_SVG_BYTES) {
    return unavailable('The SVG is incomplete or exceeds the image size limit.');
  }
  if (/<!|<\?/u.test(source)) {
    return unavailable('The SVG contains document declarations that cannot be displayed.');
  }
  const document: { documentElement: SvgElement | null; children: ArrayLike<SvgElement> } =
    new DOMParser().parseFromString(xmlWithHtmlEntities(source), 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.localName !== 'svg' || document.children.length !== 1) {
    return unavailable('The SVG does not contain one complete figure.');
  }
  const nodes = [...root.querySelectorAll('*')];
  if (nodes.length > 10_000) return unavailable('The SVG exceeds the image complexity limit.');
  const ids = new Set<string>();
  const references = new Set<string>();
  let usesXlink = false;
  for (const element of [root, ...nodes]) {
    if (!STATIC_ELEMENTS.has(element.localName)) {
      return unavailable('The SVG requires unsupported content or external resources.');
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const canonicalName = SVG_ATTRIBUTE_CASE.get(name);
      if (canonicalName && canonicalName !== attribute.name) {
        element.removeAttribute(attribute.name);
        element.setAttribute(canonicalName, attribute.value);
      }
      if (name === 'id') ids.add(value);
      if (name.startsWith('data-') || name.startsWith('aria-') || name === 'tabindex') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        name.startsWith('on') ||
        name === 'xml:base' ||
        (name === 'xmlns' && value !== SVG_NAMESPACE) ||
        (name.startsWith('xmlns:') && !(name === 'xmlns:xlink' && value === XLINK_NAMESPACE)) ||
        (name.includes(':') &&
          name !== 'xmlns:xlink' &&
          name !== 'xlink:href' &&
          name !== 'xml:space')
      )
        return unavailable('The SVG contains active content or an unsupported namespace.');
      if ((name === 'href' || name === 'xlink:href') && !FRAGMENT.test(value)) {
        return unavailable('The SVG depends on an external resource that is not in this figure.');
      }
      if (name === 'href' || name === 'xlink:href') references.add(value.slice(1));
      if (name === 'xlink:href') usesXlink = true;
      if (/[\\@]|(?:javascript|https?|file|data):|expression\s*\(/iu.test(value)) {
        if (name !== 'xmlns' && name !== 'xmlns:xlink') {
          return unavailable('The SVG depends on active content or external styling.');
        }
      }
      const withoutLocalUrls = value.replace(
        /url\(\s*["']?(#[A-Za-z_][\w:.-]*)["']?\s*\)/giu,
        (_match, fragment: string) => {
          references.add(fragment.slice(1));
          return '';
        }
      );
      if (/url\s*\(/iu.test(withoutLocalUrls)) {
        return unavailable('The SVG depends on an external resource that is not in this figure.');
      }
      if (
        name === 'style' &&
        value.split(';').some((declaration) => {
          if (!declaration.trim()) return false;
          const colon = declaration.indexOf(':');
          return (
            colon < 0 || !STYLE_PROPERTIES.has(declaration.slice(0, colon).trim().toLowerCase())
          );
        })
      )
        return unavailable(
          'The SVG uses styling that is not supported by the static image preview.'
        );
    }
  }
  if ([...references].some((id) => !ids.has(id))) {
    return unavailable('The SVG has a missing internal drawing dependency.');
  }
  root.setAttribute('xmlns', SVG_NAMESPACE);
  if (usesXlink) root.setAttribute('xmlns:xlink', XLINK_NAMESPACE);
  return {
    kind: 'image',
    src: `data:image/svg+xml;base64,${Buffer.from(root.outerHTML, 'utf8').toString('base64')}`,
  };
}
