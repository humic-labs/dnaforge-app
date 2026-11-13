import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef } from 'react';

const TOOLTIP_W = 200;
const TOOLTIP_H = 64;
const CURSOR_OFFSET = 12;

const TOOLTIP_STYLE: React.CSSProperties = {
  position: 'fixed',
  backgroundColor: 'hsl(var(--color-bg-subtle))',
  color: 'hsl(var(--color-fg))',
  border: '1px solid hsl(var(--color-border))',
  padding: '6px 10px',
  borderRadius: '4px',
  fontSize: '11px',
  pointerEvents: 'none',
  zIndex: 1000,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  maxWidth: TOOLTIP_W,
};

const SUBTEXT_STYLE: React.CSSProperties = {
  color: 'hsl(var(--color-fg-subtle))',
  fontSize: '10px',
};

interface FeatureHoverTooltipProps {
  title: string;
  lines: string[];
  clientX: number;
  clientY: number;
  testId?: string;
}

export function FeatureHoverTooltip({
  title,
  lines,
  clientX,
  clientY,
  testId,
}: FeatureHoverTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    tooltip.style.left = `${
      clientX + CURSOR_OFFSET + width > window.innerWidth - 4
        ? Math.max(4, clientX - CURSOR_OFFSET - width)
        : clientX + CURSOR_OFFSET
    }px`;
    tooltip.style.top = `${
      clientY + CURSOR_OFFSET + height > window.innerHeight - 4
        ? Math.max(4, clientY - CURSOR_OFFSET - height)
        : clientY + CURSOR_OFFSET
    }px`;
  }, [clientX, clientY, title, lines]);
  if (typeof document === 'undefined') return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tooltipHeight = TOOLTIP_H + Math.max(0, lines.length - 2) * 18;
  let left = clientX + CURSOR_OFFSET;
  if (left + TOOLTIP_W > vw - 4) left = Math.max(4, clientX - CURSOR_OFFSET - TOOLTIP_W);
  let top = clientY + CURSOR_OFFSET;
  if (top + tooltipHeight > vh - 4) top = Math.max(4, clientY - CURSOR_OFFSET - tooltipHeight);

  return createPortal(
    <div
      ref={tooltipRef}
      data-testid={testId ?? 'feature-hover-tooltip'}
      style={{ ...TOOLTIP_STYLE, left, top }}
    >
      <div
        style={{
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </div>
      {lines.map((line, i) => (
        <div key={i} style={SUBTEXT_STYLE}>
          {line}
        </div>
      ))}
    </div>,
    document.body
  );
}
