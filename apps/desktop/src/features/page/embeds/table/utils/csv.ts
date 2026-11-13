import type { Cell, CellFormat } from '../types';
import { cellsToCSV } from './csv-data';
export * from './csv-data';

export function parseHTMLTable(html: string): Cell[][] | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const table = doc.querySelector('table');
  if (!table) return null;

  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return null;

  const result: Cell[][] = [];

  rows.forEach((row) => {
    const cells: Cell[] = [];
    const cellElements = row.querySelectorAll('td, th');

    cellElements.forEach((cell) => {
      const value = cell.textContent?.trim() ?? '';
      const format = extractFormatFromElement(cell as HTMLElement);

      cells.push({
        value,
        type: 'text',
        format: Object.keys(format).length > 0 ? format : undefined,
      });
    });

    if (cells.length > 0) {
      result.push(cells);
    }
  });

  return result.length > 0 ? result : null;
}

function extractFormatFromElement(element: HTMLElement): CellFormat {
  const format: CellFormat = {};
  const style = element.style;
  const computedStyle = element.ownerDocument?.defaultView?.getComputedStyle(element);

  const fontWeight = style.fontWeight || computedStyle?.fontWeight || '';
  if (fontWeight === 'bold' || fontWeight === '700' || parseInt(fontWeight) >= 700) {
    format.bold = true;
  }
  if (element.querySelector('b, strong') || element.closest('b, strong')) {
    format.bold = true;
  }

  const fontStyle = style.fontStyle || computedStyle?.fontStyle || '';
  if (fontStyle === 'italic') {
    format.italic = true;
  }
  if (element.querySelector('i, em') || element.closest('i, em')) {
    format.italic = true;
  }

  const textDecoration =
    style.textDecoration ||
    style.textDecorationLine ||
    computedStyle?.textDecoration ||
    computedStyle?.textDecorationLine ||
    '';
  if (textDecoration.includes('underline')) {
    format.underline = true;
  }
  if (element.querySelector('u') || element.closest('u')) {
    format.underline = true;
  }

  if (textDecoration.includes('line-through')) {
    format.strikethrough = true;
  }
  if (element.querySelector('s, strike, del') || element.closest('s, strike, del')) {
    format.strikethrough = true;
  }

  const textAlign = style.textAlign || computedStyle?.textAlign || '';
  if (textAlign === 'center' || textAlign === 'right') {
    format.align = textAlign as 'center' | 'right';
  }

  const color = style.color || '';
  if (color && color !== 'rgb(0, 0, 0)' && color !== '#000000' && color !== 'black') {
    format.textColor = normalizeColor(color);
  }

  const bgColor = style.backgroundColor || '';
  if (
    bgColor &&
    bgColor !== 'transparent' &&
    bgColor !== 'rgba(0, 0, 0, 0)' &&
    bgColor !== 'rgb(255, 255, 255)' &&
    bgColor !== '#ffffff' &&
    bgColor !== 'white'
  ) {
    format.bgColor = normalizeColor(bgColor);
  }

  return format;
}

function normalizeColor(color: string): string {
  if (color.startsWith('#')) {
    return color;
  }

  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  return color;
}

export function downloadCSV(cells: Cell[][], filename = 'table.csv'): void {
  const csv = cellsToCSV(cells);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
