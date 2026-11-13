export interface CanvasTheme {
  isDark: boolean;
  bg: string;
  bgSubtle: string;
  bgMuted: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  accent: string;
  error: string;
}

export const PLANNOTATE_DRAFT_OUTLINE_ALPHA = 0.6;
export const PLANNOTATE_DRAFT_FAINT_ALPHA = 0.3;

const LIGHT_THEME: CanvasTheme = {
  isDark: false,
  bg: '#ffffff',
  bgSubtle: '#f5f5f5',
  bgMuted: '#f3f4f6',
  fg: '#000000',
  fgMuted: '#888888',
  fgSubtle: '#999999',
  border: '#cccccc',
  accent: '#1976d2',
  error: '#DC2626',
};

let currentTheme: CanvasTheme = LIGHT_THEME;

function readCssColor(style: CSSStyleDeclaration, varName: string, fallback: string): string {
  const value = style.getPropertyValue(varName).trim();
  if (!value) return fallback;
  return `hsl(${value})`;
}

let cachedIsDark: boolean | null = null;

export function resolveCanvasTheme(): CanvasTheme {
  if (typeof document === 'undefined') return LIGHT_THEME;

  const isDark = document.documentElement.classList.contains('dark');

  if (isDark === cachedIsDark) return currentTheme;
  cachedIsDark = isDark;

  const style = getComputedStyle(document.documentElement);

  currentTheme = {
    isDark,
    bg: readCssColor(style, '--color-bg', LIGHT_THEME.bg),
    bgSubtle: readCssColor(style, '--color-bg-muted', LIGHT_THEME.bgSubtle),
    bgMuted: readCssColor(style, '--color-bg-muted', LIGHT_THEME.bgMuted),
    fg: readCssColor(style, '--color-fg', LIGHT_THEME.fg),
    fgMuted: readCssColor(style, '--color-fg-muted', LIGHT_THEME.fgMuted),
    fgSubtle: readCssColor(style, '--color-fg-subtle', LIGHT_THEME.fgSubtle),
    border: readCssColor(style, '--color-border', LIGHT_THEME.border),
    accent: readCssColor(style, '--color-accent', LIGHT_THEME.accent),
    error: readCssColor(style, '--color-error', LIGHT_THEME.error),
  };

  return currentTheme;
}

export function getCanvasTheme(): CanvasTheme {
  return currentTheme;
}

export function setCanvasTheme(theme: CanvasTheme): void {
  currentTheme = theme;
}

const MOLSTAR_HOVER_RGB_LIGHT: readonly [number, number, number] = [255, 102, 153];
const MOLSTAR_HOVER_RGB_DARK: readonly [number, number, number] = [179, 71, 107];
const MOLSTAR_SELECTION_RGB_LIGHT: readonly [number, number, number] = [51, 255, 26];
const MOLSTAR_SELECTION_RGB_DARK: readonly [number, number, number] = [36, 178, 18];

export function molstarHoverColorRgb(isDark: boolean): readonly [number, number, number] {
  return isDark ? MOLSTAR_HOVER_RGB_DARK : MOLSTAR_HOVER_RGB_LIGHT;
}

export function molstarSelectionColorRgb(isDark: boolean): readonly [number, number, number] {
  return isDark ? MOLSTAR_SELECTION_RGB_DARK : MOLSTAR_SELECTION_RGB_LIGHT;
}

export function molstarHoverColorHex(isDark: boolean): number {
  const [r, g, b] = molstarHoverColorRgb(isDark);
  return (r << 16) | (g << 8) | b;
}

export function molstarSelectionColorHex(isDark: boolean): number {
  const [r, g, b] = molstarSelectionColorRgb(isDark);
  return (r << 16) | (g << 8) | b;
}
