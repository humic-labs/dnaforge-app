import type { CSSProperties } from 'react';
import './menu.css';

export type MenuDensity = 'compact' | 'form' | 'touch';
export type MenuTone = 'default' | 'danger';

export const INTERACTION_CLASS = 'wp-interactive';

const DENSITY = {
  compact: { height: 28, fontSize: 12, lineHeight: 16, padding: 8, gap: 6, icon: 16 },
  form: { height: 36, fontSize: 13, lineHeight: 18, padding: 10, gap: 8, icon: 16 },
  touch: { height: 44, fontSize: 14, lineHeight: 20, padding: 12, gap: 8, icon: 20 },
} as const;

export function menuDensityStyle(density: MenuDensity): CSSProperties {
  const metrics = DENSITY[density];
  return {
    '--menu-control-height': `${metrics.height}px`,
    '--menu-font-size': `${metrics.fontSize}px`,
    '--menu-line-height': `${metrics.lineHeight}px`,
    '--menu-padding-inline': `${metrics.padding}px`,
    '--menu-slot-gap': `${metrics.gap}px`,
    '--menu-icon-size': `${metrics.icon}px`,
  } as CSSProperties;
}
