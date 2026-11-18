import { inventoryStoragePositions } from './inventory-layout';
import { parseInventoryPlatePlanDefinition } from './inventory-plate-plan-definition';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
} from './inventory-plate-plan-identity';
import { inventoryTableSha256 } from './inventory-table-binding';
import type {
  InventoryPlatePlanVersion,
  InventoryPlatePlanDiagramResult,
} from './inventory-plate-plan-types';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!
  );
function xmlText(value: string): void {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (
      !(
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
    )
      throw new TypeError('The definition contains text unsupported by XML.');
  }
}
function lines(value: string, width: number): string[] {
  xmlText(value);
  const chars = Array.from(value),
    result: string[] = [];
  for (let index = 0; index < chars.length; index += width)
    result.push(chars.slice(index, index + width).join(''));
  return result.length ? result : [''];
}
export function renderInventoryPlatePlanDiagram(
  version: InventoryPlatePlanVersion
): InventoryPlatePlanDiagramResult {
  try {
    const definition = parseInventoryPlatePlanDefinition(version.definition),
      sha256 = inventoryPlatePlanDefinitionSha256(definition);
    if (
      sha256 !== version.definitionSha256 ||
      inventoryPlatePlanVersionId(version.identity, sha256) !== version.id
    )
      return {
        kind: 'refused',
        code: 'INVALID_VERSION',
        message: 'The plan version and complete definition pin do not match.',
      };
    const cellWidth = 158,
      cellHeight = 104,
      margin = 24,
      axis = 48,
      width = margin * 2 + axis + definition.layout.columns * cellWidth;
    if (width > 30000)
      return {
        kind: 'refused',
        code: 'LAYOUT_OVERFLOW',
        message: 'This grid is too wide for the printable diagram.',
      };
    const max = Math.max(24, Math.floor((width - margin * 2) / 7.3)),
      elements: string[] = [];
    let y = margin + 18;
    const text = (value: string, size = 13, weight = 'normal') => {
      for (const line of lines(value, max)) {
        elements.push(
          `<text x="${margin}" y="${y}" font-size="${size}" font-weight="${weight}" xml:space="preserve">${escape(line)}</text>`
        );
        y += 19;
      }
    };
    text(definition.title, 19, 'bold');
    text('Reusable plate plan · Intended transfers · Not to physical scale');
    text(`Family: ${version.identity.namespace} / ${version.identity.planId}`);
    text(`Version: ${version.id}`);
    text(`Definition: ${sha256}`);
    y += 14;
    const gridTop = y + 26,
      gridLeft = margin + axis;
    for (let column = 1; column <= definition.layout.columns; column++)
      elements.push(
        `<text x="${gridLeft + (column - 0.5) * cellWidth}" y="${y + 8}" text-anchor="middle" font-size="14" font-weight="bold">${column}</text>`
      );
    const byPosition = new Map(
      definition.transfers.map((row, index) => [
        row.destinationPosition,
        { transfer: row, ordinal: index + 1 },
      ])
    );
    const roles = new Map(definition.sourceSlots.map((row) => [row.key, row.label]));
    for (const [index, position] of inventoryStoragePositions({
      layout: definition.layout,
    }).entries()) {
      const row = Math.floor(index / definition.layout.columns),
        column = index % definition.layout.columns,
        x = gridLeft + column * cellWidth,
        top = gridTop + row * cellHeight;
      if (column === 0)
        elements.push(
          `<text x="${margin + axis / 2}" y="${top + cellHeight / 2}" text-anchor="middle" font-size="14" font-weight="bold">${escape(position.replace(/\d+$/u, ''))}</text>`
        );
      const planned = byPosition.get(position),
        label = planned
          ? `${planned.ordinal} · ${roles.get(planned.transfer.sourceSlotKey)!}`
          : 'Unplanned',
        chunks = lines(label, 19);
      if (chunks.length > 3)
        return {
          kind: 'refused',
          code: 'LAYOUT_OVERFLOW',
          message:
            'A source-role label does not fit the printable well. Use the complete saved definition or shorten a new version explicitly.',
        };
      elements.push(
        `<g><title>${escape(position + ': ' + label)}</title><rect x="${x}" y="${top}" width="${cellWidth}" height="${cellHeight}" fill="${planned ? '#edf4ff' : '#ffffff'}" stroke="#64748b"/><text x="${x + 9}" y="${top + 18}" font-size="12" font-weight="bold">${escape(position)}</text>`
      );
      chunks.forEach((line, lineIndex) =>
        elements.push(
          `<text x="${x + 9}" y="${top + 39 + lineIndex * 16}" font-size="12" xml:space="preserve">${escape(line)}</text>`
        )
      );
      if (planned)
        elements.push(
          `<text x="${x + 9}" y="${top + 94}" font-size="13" font-weight="bold">${escape(planned.transfer.quantity.value)} µL</text>`
        );
      elements.push('</g>');
    }
    y = gridTop + definition.layout.rows * cellHeight + 30;
    text('Logical source roles', 15, 'bold');
    for (const row of definition.sourceSlots) text(`${row.key}: ${row.label}`);
    y += 8;
    text('Declared instruction order', 15, 'bold');
    definition.transfers.forEach((row, index) => {
      text(
        `${index + 1}. ${roles.get(row.sourceSlotKey)} → ${row.destinationPosition} · ${row.quantity.value} µL · ${row.label}`
      );
      text(`Action: ${row.actionId} · Source role: ${row.sourceSlotKey}`);
    });
    text(
      'Unplanned cells have no intended transfer. This definition is not a reservation or a record of completed work.'
    );
    if (y > 30000)
      return {
        kind: 'refused',
        code: 'LAYOUT_OVERFLOW',
        message: 'The complete grid and labels exceed the printable diagram height.',
      };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + margin}" viewBox="0 0 ${width} ${y + margin}" role="img" aria-label="${escape(definition.title)}"><rect width="100%" height="100%" fill="white"/><g fill="#0f172a" font-family="ui-monospace,monospace">${elements.join('')}</g></svg>`;
    return {
      kind: 'rendered',
      artifact: {
        versionId: version.id,
        definitionSha256: sha256,
        mediaType: 'image/svg+xml',
        fileName: `plate-plan-${version.id.slice('plate-plan-version:'.length)}.svg`,
        svg,
        sha256: inventoryTableSha256(svg),
      },
    };
  } catch (error) {
    return {
      kind: 'refused',
      code: 'UNSUPPORTED_TEXT',
      message:
        error instanceof Error ? error.message : 'The complete definition cannot be rendered.',
    };
  }
}
