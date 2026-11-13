import type { ColoredCutSite } from '@waypoint/sequence-utils';
import { getCanvasTheme } from '../canvas-theme';

export function getCutSiteLabelBg(): string {
  const theme = getCanvasTheme();
  if (!theme.isDark) return 'rgba(255, 255, 255, 0.9)';
  return theme.bg;
}

export function lightenColor(hex: string, percent: number = 20): string {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  const newR = Math.min(255, r + (255 - r) * (percent / 100));
  const newG = Math.min(255, g + (255 - g) * (percent / 100));
  const newB = Math.min(255, b + (255 - b) * (percent / 100));
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
}

export function darkenColor(hex: string, percent: number = 20): string {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  const newR = Math.max(0, r * (1 - percent / 100));
  const newG = Math.max(0, g * (1 - percent / 100));
  const newB = Math.max(0, b * (1 - percent / 100));
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
}

export function hoverTint(hex: string, percent: number = 20): string {
  return getCanvasTheme().isDark ? darkenColor(hex, percent) : lightenColor(hex, percent);
}

export interface RenderedCutSite {
  cutSite: ColoredCutSite;
  labelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  lineIndex: number;
}

export const CUT_SITE_LABEL_BASE_FONT_SIZE = 11;

export function cutSiteLabelMetrics(baseFontSize: number): { size: number; height: number } {
  return {
    size: Math.round(baseFontSize * 0.91),
    height: Math.round(baseFontSize * 1.27),
  };
}

export const CUT_SITE_LABEL_DENSITY_FACTOR = 1.2;
export const MIN_VISIBLE_CUT_SITE_LABELS = 3;
const CUT_SITE_LABEL_DENSITY_GAP_PX = 4;

export function selectCutSiteLabelsByDensity(
  sortedSites: readonly ColoredCutSite[],
  measureLabelWidth: (enzymeName: string) => number,
  availableSpanPx: number,
  isHovered: (site: ColoredCutSite) => boolean
): Set<ColoredCutSite> {
  const keep = new Set<ColoredCutSite>();
  if (sortedSites.length <= 1) {
    for (const s of sortedSites) keep.add(s);
    return keep;
  }

  let totalWidth = 0;
  for (const s of sortedSites) {
    totalWidth += measureLabelWidth(s.enzyme.name) + CUT_SITE_LABEL_DENSITY_GAP_PX;
  }
  const budgetPx = Math.max(80, availableSpanPx) * CUT_SITE_LABEL_DENSITY_FACTOR;
  if (totalWidth <= budgetPx) {
    for (const s of sortedSites) keep.add(s);
    return keep;
  }

  const avgWidth = totalWidth / sortedSites.length;
  const densityMax = Math.floor(budgetPx / Math.max(avgWidth, 1));
  const maxLabels = Math.max(Math.min(sortedSites.length, MIN_VISIBLE_CUT_SITE_LABELS), densityMax);
  const keepEvery = Math.max(1, Math.ceil(sortedSites.length / maxLabels));
  sortedSites.forEach((site, index) => {
    if (isHovered(site) || index % keepEvery === 0) keep.add(site);
  });
  return keep;
}

export const RECOGNITION_HIGHLIGHT_FILL = 'rgba(185, 185, 185, 0.25)';

export const INTERNAL_RECOGNITION_HIGHLIGHT_FILL = 'rgba(220, 38, 38, 0.4)';

export function getHoveredRecognitionStroke(): {
  strokeStyle: string;
  lineWidth: number;
} {
  const theme = getCanvasTheme();
  return {
    strokeStyle: theme.isDark ? 'rgba(200, 200, 200, 0.8)' : 'rgba(80, 80, 80, 0.8)',
    lineWidth: 2,
  };
}
