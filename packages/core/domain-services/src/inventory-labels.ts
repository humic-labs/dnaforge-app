import { create as createQrCode } from 'qrcode';
import { inventoryLabelFont } from './inventory-label-font';
import {
  INVENTORY_LABEL_ENCODER,
  INVENTORY_LABEL_FONT,
  INVENTORY_LABEL_MEDIA_PROFILE_IDS,
  INVENTORY_LABEL_TEMPLATE,
  type InventoryLabelMedia,
  type InventoryLabelMediaProfileId,
  type InventoryLabelRenderResult,
  type InventoryLabelSpec,
  type InventoryRenderedLabel,
} from './inventory-label-types';

export type * from './inventory-label-types';

const profiles: Record<InventoryLabelMediaProfileId, readonly [number, number]> = {
  'qr-50x30-300dpi': [50, 30],
  'qr-80x50-300dpi': [80, 50],
};
const edge = 12;
const gap = 12;
const quiet = 16;
const fontSize = 33;
const lineHeight = 40;
const fieldGap = 12;
const namespacePattern = /^[a-z][a-z0-9._:-]{0,63}$(?![\s\S])/;

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function identifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !value.includes('\0')
  );
}

function validSpec(value: unknown): value is InventoryLabelSpec {
  if (!record(value, ['scope', 'sourceRevision', 'binding', 'mediaProfileId'])) return false;
  const { scope, sourceRevision, binding, mediaProfileId } = value;
  return (
    record(scope, ['projectId', 'inventoryId']) &&
    identifier(scope.projectId, 1_024) &&
    identifier(scope.inventoryId, 512) &&
    Number.isSafeInteger(sourceRevision) &&
    (sourceRevision as number) >= 0 &&
    record(binding, ['id', 'namespace', 'value', 'item']) &&
    identifier(binding.id, 512) &&
    typeof binding.namespace === 'string' &&
    namespacePattern.test(binding.namespace) &&
    typeof binding.value === 'string' &&
    binding.value.length > 0 &&
    binding.value.length <= 512 &&
    /\S/.test(binding.value) &&
    record(binding.item, ['kind', 'id']) &&
    (binding.item.kind === 'storage' || binding.item.kind === 'vessel') &&
    identifier(binding.item.id, 1_024) &&
    INVENTORY_LABEL_MEDIA_PROFILE_IDS.includes(mediaProfileId as InventoryLabelMediaProfileId)
  );
}

function refuse(
  code: Extract<InventoryLabelRenderResult, { kind: 'refused' }>['code'],
  message: string
): InventoryLabelRenderResult {
  return { kind: 'refused', code, message };
}

export function renderInventoryItemLabel(input: InventoryLabelSpec): InventoryLabelRenderResult {
  if (!validSpec(input)) return refuse('INVALID_SPEC', 'The label specification is invalid.');
  if (!/^[\x20-\x7e]+$(?![\s\S])/.test(input.binding.value)) {
    return refuse('UNSUPPORTED_TEXT', 'This label template supports printable ASCII code values.');
  }
  if (!/^[\x20-\x7e]+$(?![\s\S])/.test(input.binding.item.id)) {
    return refuse(
      'UNSUPPORTED_TEXT',
      'This label template supports printable ASCII item identifiers.'
    );
  }
  const spec: InventoryLabelSpec = Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    sourceRevision: input.sourceRevision,
    binding: Object.freeze({ ...input.binding, item: Object.freeze({ ...input.binding.item }) }),
    mediaProfileId: input.mediaProfileId,
  });
  const [widthMm, heightMm] = profiles[spec.mediaProfileId];
  const media: InventoryLabelMedia = Object.freeze({
    profileId: spec.mediaProfileId,
    widthMm,
    heightMm,
    dpi: 300,
    widthDots: (widthMm * 300) / 25.4,
    heightDots: (heightMm * 300) / 25.4,
  });
  try {
    const qr = createQrCode(
      [
        {
          mode: 'byte',
          data: Uint8Array.from(spec.binding.value, (character) => character.charCodeAt(0)),
        },
      ],
      { errorCorrectionLevel: 'M' }
    );
    const modules = qr.modules.size;
    if (
      !Number.isInteger(modules) ||
      modules < 21 ||
      modules > 177 ||
      (modules - 21) % 4 !== 0 ||
      qr.modules.data.length !== modules * modules
    ) {
      return refuse('ENCODER_FAILED', 'The encoder returned unsupported QR geometry.');
    }
    const sizeDots = modules * 4;
    let qrPath = '';
    for (let row = 0; row < modules; row += 1) {
      for (let column = 0; column < modules; ) {
        if (!qr.modules.data[row * modules + column]) {
          column += 1;
          continue;
        }
        const first = column;
        while (column < modules && qr.modules.data[row * modules + column]) column += 1;
        const width = (column - first) * 4;
        qrPath += `M${first * 4} ${row * 4}h${width}v4h-${width}Z`;
      }
    }
    const xDots = edge + quiet;
    const yDots = edge + quiet;
    const textX = xDots + sizeDots + quiet + gap;
    const textWidth = Math.floor(media.widthDots) - edge - textX;
    if (yDots + sizeDots + quiet + edge > Math.floor(media.heightDots) || textWidth < fontSize) {
      return refuse(
        'LAYOUT_OVERFLOW',
        'The QR symbol and quiet zone do not fit this media profile.'
      );
    }
    const textPaths: string[] = [];
    const measure = (text: string) => {
      let width = 0;
      for (const character of text)
        width += inventoryLabelFont.glyphs[character.charCodeAt(0) - 32].advance;
      return Math.round(width * 1_000) / 1_000;
    };
    const fields = [
      {
        role: 'namespace' as const,
        text: spec.binding.namespace,
        display: `Namespace: ${spec.binding.namespace}`,
      },
      {
        role: 'code' as const,
        text: spec.binding.value,
        display: `Code: ${JSON.stringify(spec.binding.value)}`,
      },
      {
        role: 'target' as const,
        text: `${spec.binding.item.kind}:${spec.binding.item.id}`,
        display: `Target: ${spec.binding.item.kind}:${spec.binding.item.id}`,
      },
    ];
    const humanText: InventoryRenderedLabel['humanText'][number][] = [];
    let top = edge;
    for (const field of fields) {
      const lines: InventoryRenderedLabel['humanText'][number]['lines'][number][] = [];
      let remaining = field.display;
      while (remaining.length) {
        let count = 0;
        while (count < remaining.length && measure(remaining.slice(0, count + 1)) <= textWidth) {
          count += 1;
        }
        if (count === 0 || top + lineHeight > Math.floor(media.heightDots) - edge) {
          return refuse(
            'LAYOUT_OVERFLOW',
            'The complete code, namespace and item identifier do not fit this media profile.'
          );
        }
        const text = remaining.slice(0, count);
        const baselineDots = top + inventoryLabelFont.ascentDots;
        let characterX = textX;
        for (const character of text) {
          const glyph = inventoryLabelFont.glyphs[character.charCodeAt(0) - 32];
          if (glyph.d)
            textPaths.push(
              `<path d="${glyph.d}" transform="translate(${Math.round(characterX * 1_000) / 1_000} ${baselineDots})" fill="#000000"/>`
            );
          characterX += glyph.advance;
        }
        lines.push(
          Object.freeze({
            text,
            xDots: textX,
            baselineDots,
            widthDots: measure(text),
            heightDots: lineHeight,
          })
        );
        remaining = remaining.slice(count);
        top += lineHeight;
      }
      humanText.push(
        Object.freeze({ role: field.role, text: field.text, lines: Object.freeze(lines) })
      );
      top += fieldGap;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${media.widthDots} ${media.heightDots}">\n<rect width="100%" height="100%" fill="#FFFFFF"/>\n${textPaths.join('\n')}\n<path d="${qrPath}" transform="translate(${xDots} ${yDots})" fill="#000000" shape-rendering="crispEdges"/>\n</svg>\n`;
    return {
      kind: 'rendered',
      artifact: Object.freeze({
        spec,
        template: INVENTORY_LABEL_TEMPLATE,
        encoder: Object.freeze({ ...INVENTORY_LABEL_ENCODER }),
        font: Object.freeze({
          ...INVENTORY_LABEL_FONT,
          generator: Object.freeze({ ...INVENTORY_LABEL_FONT.generator }),
        }),
        media,
        symbol: Object.freeze({
          symbology: 'qrcode',
          errorCorrection: 'M',
          modules,
          dotsPerModule: 4,
          quietZoneModules: 4,
          xDots,
          yDots,
          sizeDots,
        }),
        humanText: Object.freeze(humanText),
        svg,
      }),
    };
  } catch {
    return refuse('ENCODER_FAILED', 'The label encoder could not render this specification.');
  }
}
