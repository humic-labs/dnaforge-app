import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { DESKTOP_REPLAY_BLOCK_ATTRIBUTE } from '@waypoint/analytics-policy';

export const TELEMETRY_BLOCKED_CLASS = 'ph-no-capture';
export const TELEMETRY_BLOCKED_ATTRIBUTES = {
  'data-ph-no-capture': '',
  'data-analytics-block': 'true',
} as const;

export const REPLAY_BLOCKED_ATTRIBUTES = { [DESKTOP_REPLAY_BLOCK_ATTRIBUTE]: '' } as const;

interface TelemetryBlockedSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children: ReactNode;
}

export function TelemetryBlockedSurface({
  as: Component = 'div',
  className = '',
  children,
  ...props
}: TelemetryBlockedSurfaceProps) {
  return (
    <Component
      {...props}
      {...TELEMETRY_BLOCKED_ATTRIBUTES}
      className={`${TELEMETRY_BLOCKED_CLASS} ${className}`.trim()}
    >
      {children}
    </Component>
  );
}
