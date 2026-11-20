import type { NotebookLayoutChoice } from '../editor/extensions/notebook-layout';

const DIVIDERS: Readonly<Record<NotebookLayoutChoice, readonly number[]>> = {
  'single-column': [],
  'two-columns': [12],
  'wide-left': [15],
  'wide-right': [9],
  'three-columns': [9, 15],
};

export function NotebookLayoutIcon({
  layout,
  size = 16,
}: {
  size?: number;
  layout: NotebookLayoutChoice;
}) {
  return (
    <svg
      width={size}
      height={size}
      data-layout-icon={layout}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {DIVIDERS[layout].map((x) => (
        <line key={x} x1={x} y1="4" x2={x} y2="20" />
      ))}
    </svg>
  );
}
