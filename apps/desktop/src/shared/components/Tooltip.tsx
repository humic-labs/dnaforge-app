'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export interface TooltipProps {
  id?: string;
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  delay?: number;
  className?: string;
  variant?: 'default' | 'info';
  shouldShow?: () => boolean;
}

export const DEFAULT_TOOLTIP_DELAY_MS = 300;
const TOOLTIP_OFFSET_PX = 8;

export function Tooltip({
  id,
  content,
  children,
  side = 'top',
  align = 'center',
  delay = DEFAULT_TOOLTIP_DELAY_MS,
  className,
  variant = 'default',
  shouldShow,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const suppressUntilExitRef = useRef(false);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition(positionForSide(rect, side, align));
  }, [align, side]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (suppressUntilExitRef.current) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (shouldShow && !shouldShow()) {
      setVisible(false);
      return;
    }
    timeoutRef.current = setTimeout(() => {
      updatePosition();
      setVisible(true);
    }, delay);
  }, [delay, shouldShow, updatePosition]);

  const handleMouseLeave = useCallback(() => {
    suppressUntilExitRef.current = false;
    hideTooltip();
  }, [hideTooltip]);

  const handleTriggerActivation = useCallback(() => {
    suppressUntilExitRef.current = true;
    hideTooltip();
  }, [hideTooltip]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, visible]);

  return (
    <div
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
      onPointerDownCapture={handleTriggerActivation}
      onClickCapture={handleTriggerActivation}
    >
      {children}
      {visible &&
        position &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-tooltip-variant={variant}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              transform: position.transform,
            }}
            className={cn(
              'pointer-events-none z-[9999] max-w-[min(32rem,calc(100vw-1rem))] whitespace-normal break-words rounded-md border text-xs',
              'animate-in fade-in-0 zoom-in-95 duration-fast',
              variant === 'info'
                ? 'w-max border-border-hover bg-bg-subtle/95 px-3 py-2 font-normal leading-snug text-fg shadow-lg'
                : 'border-fg-subtle/30 bg-[hsl(var(--color-tooltip-bg))] px-2 py-1 font-medium text-fg shadow-sm'
            )}
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  );
}

interface TooltipPosition {
  top: number;
  left: number;
  transform: string;
}

function positionForSide(
  rect: DOMRect,
  side: NonNullable<TooltipProps['side']>,
  align: NonNullable<TooltipProps['align']>
): TooltipPosition {
  switch (side) {
    case 'bottom':
      return {
        top: rect.bottom + TOOLTIP_OFFSET_PX,
        left:
          align === 'start' ? rect.left : align === 'end' ? rect.right : rect.left + rect.width / 2,
        transform:
          align === 'start' ? 'none' : align === 'end' ? 'translateX(-100%)' : 'translateX(-50%)',
      };
    case 'left':
      return {
        top:
          align === 'start' ? rect.top : align === 'end' ? rect.bottom : rect.top + rect.height / 2,
        left: rect.left - TOOLTIP_OFFSET_PX,
        transform:
          align === 'start'
            ? 'translateX(-100%)'
            : align === 'end'
              ? 'translate(-100%, -100%)'
              : 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top:
          align === 'start' ? rect.top : align === 'end' ? rect.bottom : rect.top + rect.height / 2,
        left: rect.right + TOOLTIP_OFFSET_PX,
        transform:
          align === 'start' ? 'none' : align === 'end' ? 'translateY(-100%)' : 'translateY(-50%)',
      };
    case 'top':
    default:
      return {
        top: rect.top - TOOLTIP_OFFSET_PX,
        left:
          align === 'start' ? rect.left : align === 'end' ? rect.right : rect.left + rect.width / 2,
        transform:
          align === 'start'
            ? 'translateY(-100%)'
            : align === 'end'
              ? 'translate(-100%, -100%)'
              : 'translate(-50%, -100%)',
      };
  }
}
