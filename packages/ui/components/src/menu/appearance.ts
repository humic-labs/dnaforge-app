import type { CSSProperties } from 'react';
import { menuDensityVariables, type MenuDensity } from './density';
import './menu.css';

export type { MenuDensity } from './density';
export type MenuTone = 'default' | 'danger';
export const INTERACTION_CLASS = 'wp-interactive';

export function menuDensityStyle(density: MenuDensity): CSSProperties {
  return menuDensityVariables(density) as CSSProperties;
}
