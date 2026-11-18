import type { IconProps, PinIconProps } from './types';
import { entityColorFamily } from '../../shared/entity-color-family';

export function SparklesIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m10 4 2.4 5.6L18 12l-5.6 2.4L10 20l-2.4-5.6L2 12l5.6-2.4L10 4Z" />
      <path d="M19 2v6m-3-3h6" />
    </svg>
  );
}

export function SendIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function SettingsIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-icon="settings-gear"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
    </svg>
  );
}

export function SlidersIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M4 12h2" />
      <path d="M10 12h10" />
      <path d="M4 18h10" />
      <path d="M18 18h2" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </svg>
  );
}

export function SunIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function HistoryIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function SearchIcon({
  size = 14,
  strokeWidth = 2,
  className,
}: IconProps & { strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function SidebarIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M6 8h.01" />
      <path d="M6 12h.01" />
      <path d="M6 16h.01" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function TrashIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function PinIcon({ size = 12, filled, className }: PinIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.76Z" />
    </svg>
  );
}

export function PaperclipIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function XIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function RefreshIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

export function StopIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

export function EditIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function OpenExternalIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14 3h7v7" />
      <path d="M21 3l-9 9" />
      <path d="M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </svg>
  );
}

export function MoveToTabIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 4v5M7 14h10m-3-3 3 3-3 3" />
    </svg>
  );
}

export function TargetIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 1v3" />
      <path d="M12 20v3" />
      <path d="M1 12h3" />
      <path d="M20 12h3" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

const BIOLOGY_FILE_ICON_PATHS = [
  'M9.8125 15.8125 11.5 17.5',
  'm14.1875 8.1875-1.6875-1.6875',
  'M15 2c-1.798 1.998-2.518 3.995-2.807 5.993',
  'm16.3125 10.3125 1.1875 1.1875',
  'm17.225 6.225-3.116-3.116',
  'M2 15c6.667-6 13.333 0 20-6',
  'm19.775 8.775 1.116 1.116',
  'M3.109 14.109 4.225 15.225',
  'm6.5 12.5 1.1875 1.1875',
  'm6.775 17.775 3.116 3.116',
  'M9 22c1.798-1.998 2.518-3.995 2.807-5.993',
] as const;

export function BiologyFileIcon({
  colorFamily,
  size,
  className = 'w-4 h-4 flex-shrink-0',
}: IconProps) {
  return (
    <svg
      {...(size ? { width: size, height: size } : {})}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-entity-color-family={colorFamily ?? 'dna'}
      data-icon="biology-file"
    >
      {BIOLOGY_FILE_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function createBiologyFileIconElement(sizePx = 14): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('data-entity-color-family', 'dna');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of BIOLOGY_FILE_ICON_PATHS) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function FolderIcon({
  colorFamily,
  expanded,
  className = 'w-4 h-4 text-fg-subtle flex-shrink-0',
}: IconProps & { expanded?: boolean }) {
  return (
    <svg
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      {expanded ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
        />
      ) : (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
        />
      )}
    </svg>
  );
}

export function ProjectRootIcon({
  colorFamily,
  className = 'w-4 h-4 flex-shrink-0 text-accent',
}: IconProps) {
  return (
    <svg
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M8 4v16" />
      <path d="M8 8h8" />
      <path d="M8 12h6" />
      <path d="M8 16h4" />
    </svg>
  );
}

export function GenericFileIcon({
  colorFamily,
  className = 'w-4 h-4 flex-shrink-0 text-fg-subtle',
}: IconProps) {
  return (
    <svg
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
      />
    </svg>
  );
}

const FILE_ICON_BASE = 'w-4 h-4 flex-shrink-0 text-fg-subtle';
const STRUCTURE_GLYPH_PATH =
  'M2.8 4.375Q4 4.375 4 5.575V18.5A2 1.5 0 0 0 8 18.5V5.5A2 1.5 0 0 1 12 5.5V18.5A2 1.5 0 0 0 16 18.5V5.5A2 1.5 0 0 1 20 5.5V17.92Q20 19.12 21.2 19.12';

export function StructureFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="structure"
      className={className}
      data-entity-color-family={colorFamily ?? 'protein'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={STRUCTURE_GLYPH_PATH} />
    </svg>
  );
}

export const ProteinIcon = StructureFileIcon;

export function MolecularDocumentIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="molecular-document"
      className={className}
      data-entity-color-family={colorFamily ?? 'protein'}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="3" />
      <g transform="translate(3.12 3.12) scale(.74)">
        <path d={STRUCTURE_GLYPH_PATH} />
      </g>
    </svg>
  );
}

export function ImageFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="image"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

export function WebFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="web"
      className={className}
      data-entity-color-family={colorFamily ?? 'code'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z" />
    </svg>
  );
}

export function PdfFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="pdf"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <rect x="8" y="13" width="8" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ArchiveFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="archive"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
      <path d="M10 16h4" />
    </svg>
  );
}

export function SpreadsheetFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="spreadsheet"
      className={className}
      data-entity-color-family={colorFamily ?? 'data'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M3 15h18" />
      <path d="M9 4v16" />
      <path d="M15 4v16" />
    </svg>
  );
}

export function createSpreadsheetFileIconElement(sizePx = 14): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('data-entity-color-family', 'data');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '3');
  rect.setAttribute('y', '4');
  rect.setAttribute('width', '18');
  rect.setAttribute('height', '16');
  rect.setAttribute('rx', '2');
  svg.appendChild(rect);

  for (const d of ['M3 10h18', 'M3 15h18', 'M9 4v16', 'M15 4v16']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}

export function CodeFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="code"
      className={className}
      data-entity-color-family={colorFamily ?? 'code'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M8 7l-5 5 5 5" />
      <path d="M16 7l5 5-5 5" />
      <path d="M13.5 5l-3 14" />
    </svg>
  );
}

export function TextFileIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-file-type-icon="text"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </svg>
  );
}

const CHAT_TAB_ICON_PATHS = [
  'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
] as const;

export function ChatTabIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-tab-type-icon="chat"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {CHAT_TAB_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const NOTEBOOK_TAB_ICON_PATHS = [
  'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  'M9 7h6',
  'M9 11h4',
  'M3 7h4',
  'M3 12h4',
  'M3 17h4',
] as const;

export function NotebookTabIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-tab-type-icon="page"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {NOTEBOOK_TAB_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const ASSEMBLY_TAB_ICON_PATHS = [
  'M12 3a9 9 0 0 1 7.8 4.5',
  'M21 12a9 9 0 0 1-4.5 7.8',
  'M12 21a9 9 0 0 1-7.8-4.5',
  'M3 12a9 9 0 0 1 4.5-7.8',
] as const;

export function AssemblyTabIcon({ colorFamily, className = FILE_ICON_BASE }: IconProps) {
  return (
    <svg
      data-tab-type-icon="design"
      className={className}
      data-entity-color-family={colorFamily ?? 'dna'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {ASSEMBLY_TAB_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

type SvgShapeSpec =
  | { tag: 'path'; d: string }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { tag: 'circle'; cx: number; cy: number; r: number }
  | { tag: 'line'; x1: number; y1: number; x2: number; y2: number; strokeWidth?: number }
  | { tag: 'polygon'; points: string; fill?: string };

const OLIGO_ICON_BACKBONE = { x1: 2.5, y1: 13.5, x2: 16, y2: 13.5 } as const;
const OLIGO_ICON_ARROW_POINTS = '12,8 21,13.5 12,13.5';

const TAB_TYPE_ICON_SHAPES: Record<
  'file' | 'text' | 'image' | 'html' | 'chat' | 'page' | 'structure' | 'design' | 'primer',
  readonly SvgShapeSpec[]
> = {
  chat: CHAT_TAB_ICON_PATHS.map((d) => ({ tag: 'path', d })),
  page: NOTEBOOK_TAB_ICON_PATHS.map((d) => ({ tag: 'path', d })),
  design: ASSEMBLY_TAB_ICON_PATHS.map((d) => ({ tag: 'path', d })),
  primer: [
    { tag: 'line', ...OLIGO_ICON_BACKBONE, strokeWidth: 3.4 },
    { tag: 'polygon', points: OLIGO_ICON_ARROW_POINTS, fill: 'currentColor' },
  ],
  file: [
    {
      tag: 'path',
      d: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
    },
  ],
  text: [
    { tag: 'path', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' },
    { tag: 'path', d: 'M14 3v5h5' },
    { tag: 'path', d: 'M9 13h6' },
    { tag: 'path', d: 'M9 17h6' },
  ],
  image: [
    { tag: 'rect', x: 3, y: 3, width: 18, height: 18, rx: 2 },
    { tag: 'circle', cx: 8.5, cy: 8.5, r: 1.5 },
    { tag: 'path', d: 'M21 15l-5-5L5 21' },
  ],
  html: [
    { tag: 'circle', cx: 12, cy: 12, r: 9 },
    { tag: 'path', d: 'M3 12h18' },
    {
      tag: 'path',
      d: 'M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z',
    },
  ],
  structure: [
    {
      tag: 'path',
      d: 'M2.8 4.375Q4 4.375 4 5.575V18.5A2 1.5 0 0 0 8 18.5V5.5A2 1.5 0 0 1 12 5.5V18.5A2 1.5 0 0 0 16 18.5V5.5A2 1.5 0 0 1 20 5.5V17.92Q20 19.12 21.2 19.12',
    },
  ],
};

export function createTabTypeIconElement(tabType: string, sizePx = 14): SVGSVGElement | null {
  const shapes = (TAB_TYPE_ICON_SHAPES as Record<string, readonly SvgShapeSpec[] | undefined>)[
    tabType
  ];
  if (!shapes) return null;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('data-entity-color-family', entityColorFamily({ kind: tabType }));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const shape of shapes) {
    const el = document.createElementNS(NS, shape.tag);
    if (shape.tag === 'path') {
      el.setAttribute('d', shape.d);
    } else if (shape.tag === 'rect') {
      el.setAttribute('x', String(shape.x));
      el.setAttribute('y', String(shape.y));
      el.setAttribute('width', String(shape.width));
      el.setAttribute('height', String(shape.height));
      if (shape.rx != null) el.setAttribute('rx', String(shape.rx));
    } else if (shape.tag === 'circle') {
      el.setAttribute('cx', String(shape.cx));
      el.setAttribute('cy', String(shape.cy));
      el.setAttribute('r', String(shape.r));
    } else if (shape.tag === 'line') {
      el.setAttribute('x1', String(shape.x1));
      el.setAttribute('y1', String(shape.y1));
      el.setAttribute('x2', String(shape.x2));
      el.setAttribute('y2', String(shape.y2));
      if (shape.strokeWidth != null) el.setAttribute('stroke-width', String(shape.strokeWidth));
    } else {
      el.setAttribute('points', shape.points);
      if (shape.fill) el.setAttribute('fill', shape.fill);
    }
    svg.appendChild(el);
  }
  return svg;
}

export function FilePlusIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14 3v6h5" />
      <path d="M10 15h6" />
      <path d="M13 12v6" />
    </svg>
  );
}

export function FolderOpenIcon({ colorFamily, className = 'w-4 h-4' }: IconProps) {
  return (
    <svg
      className={className}
      data-entity-color-family={colorFamily}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M3 8V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2" />
      <path d="M3 19l2.2-8h15.6l-2.2 8H3z" />
    </svg>
  );
}

export function ChevronRotatableIcon({ expanded, className }: IconProps & { expanded?: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-fg-subtle transition-transform duration-fast ${expanded ? 'rotate-90' : ''} ${className ?? ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function SpinnerIcon({ className = 'w-3 h-3' }: IconProps) {
  return (
    <div
      className={`${className} border border-fg-subtle border-t-transparent rounded-full animate-spin`}
    />
  );
}

export function PlusIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

export function ImportIcon({ size = 16, className = 'w-4 h-4' }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 1.75v7.5" />
      <path d="m5.25 6.5 2.75 2.75 2.75-2.75" />
      <path d="M2.25 9.75v2.5c0 1.1.9 2 2 2h7.5c1.1 0 2-.9 2-2v-2.5" />
    </svg>
  );
}

export function ExclamationCircleIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      data-icon="exclamation-circle"
    >
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v5" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16h.01" />
    </svg>
  );
}

export function EllipsisIcon({
  className = 'w-4 h-4',
  strokeWidth = 2,
}: IconProps & { strokeWidth?: number }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        d="M5 12h.01M12 12h.01M19 12h.01"
      />
    </svg>
  );
}

function pinchedChromosomePath(cy: number, xc: number): string {
  const Lx = 2.6;
  const Rx = 21.4;
  const H = 2.4;
  const h = 0.55;
  return [
    `M ${Lx} ${cy - H}`,
    `Q ${(Lx + xc) / 2} ${cy - H} ${xc} ${cy - h}`,
    `Q ${(xc + Rx) / 2} ${cy - H} ${Rx} ${cy - H}`,
    `A ${H} ${H} 0 0 1 ${Rx} ${cy + H}`,
    `Q ${(xc + Rx) / 2} ${cy + H} ${xc} ${cy + h}`,
    `Q ${(Lx + xc) / 2} ${cy + H} ${Lx} ${cy + H}`,
    `A ${H} ${H} 0 0 1 ${Lx} ${cy - H}`,
    'Z',
  ].join(' ');
}

export function GenomeAssemblyIcon({
  colorFamily,
  size,
  className = 'w-4 h-4 flex-shrink-0',
}: IconProps) {
  return (
    <svg
      {...(size ? { width: size, height: size } : {})}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      data-entity-color-family={colorFamily ?? 'dna'}
      data-icon="genome-assembly"
    >
      <path d={pinchedChromosomePath(5, 9)} />
      <path d={pinchedChromosomePath(12, 13)} />
      <path d={pinchedChromosomePath(19, 10.5)} />
    </svg>
  );
}

export function OligoIcon({ colorFamily, size, className = 'w-4 h-4 flex-shrink-0' }: IconProps) {
  return (
    <svg
      {...(size ? { width: size, height: size } : {})}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
      data-entity-color-family={colorFamily ?? 'dna'}
    >
      <line {...OLIGO_ICON_BACKBONE} strokeWidth={3.4} strokeLinecap="round" />
      {}
      <polygon points={OLIGO_ICON_ARROW_POINTS} fill="currentColor" stroke="none" />
    </svg>
  );
}

export function MetadataIcon({ size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5.5 2.75h6.25l2.75 2.75v11.75h-9z" />
      <path d="M11.75 2.75V5.5h2.75M7.5 8h5M7.5 10.75h5M7.5 13.5h3.25" />
    </svg>
  );
}

export function StrainIcon({ colorFamily, size, className = 'w-4 h-4 flex-shrink-0' }: IconProps) {
  return (
    <svg
      {...(size ? { width: size, height: size } : {})}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-entity-color-family={colorFamily ?? 'neutral'}
    >
      <ellipse cx="10" cy="12" rx="7.7" ry="6" />
      {}
      <path d="M17.5 12 q1.5 -1.8 3 0 q1.5 1.8 3 0" fill="none" />
      {}
      <circle cx="7.6" cy="10.8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="11.4" cy="13.6" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}
