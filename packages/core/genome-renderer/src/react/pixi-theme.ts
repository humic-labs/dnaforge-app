import type { Application } from 'pixi.js';
import {
  recordWebGLTrace,
  webglThemeColorToCss,
  webglThemeForMode,
  type RenderState,
  type WebGLThemeMode,
} from '@waypoint/genome-renderer';

export function currentWebGLThemeMode(): WebGLThemeMode {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyPixiTheme(app: Application, mode: WebGLThemeMode): void {
  const theme = webglThemeForMode(mode);
  app.renderer.background.color = theme.background;
  const canvas = app.canvas as HTMLCanvasElement;
  canvas.style.backgroundColor = webglThemeColorToCss(theme.background);
}

export function installWebGLThemeObserver(params: {
  stateRef: { current: RenderState };
  appRef: { current: Application | null };
}): (() => void) | undefined {
  if (typeof document === 'undefined') return undefined;
  const applyCurrentTheme = () => {
    const mode = currentWebGLThemeMode();
    const previousMode = params.stateRef.current.themeMode;
    params.stateRef.current.themeMode = mode;
    if (params.appRef.current) applyPixiTheme(params.appRef.current, mode);
    if (previousMode !== mode) recordWebGLTrace('theme-mode-change', { mode });
  };
  applyCurrentTheme();
  if (typeof MutationObserver === 'undefined') return undefined;
  const observer = new MutationObserver(applyCurrentTheme);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
