import type { IDisposable, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { LigaturesAddon } from '@xterm/addon-ligatures/lib/addon-ligatures.mjs';
import type { TerminalPreferences } from './terminal-preferences';

type RenderingPreferences = Pick<TerminalPreferences, 'gpuAcceleration' | 'fontLigatures'>;
type RenderingTerminal = Pick<Terminal, 'loadAddon' | 'refresh' | 'rows' | 'element'>;

export class TerminalRendering {
  private graphics: WebglAddon | undefined;
  private contextLoss: IDisposable | undefined;
  private ligatures: LigaturesAddon | undefined;
  private graphicsFailed = false;
  private mode: RenderingPreferences['gpuAcceleration'] | undefined;
  private disposed = false;

  constructor(private readonly terminal: RenderingTerminal) {}

  configure(preferences: RenderingPreferences): void {
    if (this.disposed) return;
    const ligaturesChanged = preferences.fontLigatures !== Boolean(this.ligatures);
    if (!ligaturesChanged && preferences.gpuAcceleration === this.mode) return;
    if (this.mode === 'off' && preferences.gpuAcceleration === 'auto') this.graphicsFailed = false;
    this.mode = preferences.gpuAcceleration;
    if (ligaturesChanged) {
      this.releaseGraphics();
      this.ligatures?.dispose();
      this.ligatures = undefined;
      if (preferences.fontLigatures) {
        this.ligatures = new LigaturesAddon();
        this.terminal.loadAddon(this.ligatures);
      }
    }
    if (this.mode === 'off') this.releaseGraphics();
    else if (!this.graphics && !this.graphicsFailed) {
      try {
        this.graphics = new WebglAddon();
        this.contextLoss = this.graphics.onContextLoss(() => {
          this.graphicsFailed = true;
          this.releaseGraphics();
          this.refresh();
        });
        this.terminal.loadAddon(this.graphics);
      } catch {
        this.graphicsFailed = true;
        this.releaseGraphics();
      }
    }
    this.refresh();
  }

  private refresh(): void {
    if (this.terminal.element) {
      this.terminal.element.dataset.terminalRenderer = this.graphics ? 'webgl' : 'dom';
      this.terminal.element.dataset.terminalLigatures = String(Boolean(this.ligatures));
    }
    this.terminal.refresh(0, this.terminal.rows - 1);
  }

  private releaseGraphics(): void {
    this.contextLoss?.dispose();
    this.contextLoss = undefined;
    const graphics = this.graphics;
    this.graphics = undefined;
    graphics?.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseGraphics();
    this.ligatures?.dispose();
    this.ligatures = undefined;
  }
}
