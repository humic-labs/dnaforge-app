export interface TextRun {
  texture: WebGLTexture;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
  ascent: number;
  descent: number;
}

interface ResidentText {
  run: TextRun;
  metrics: TextMetrics;
}

interface CachedText extends ResidentText {
  metricsEpoch: number;
}

const ATLAS_SIZE = 2048;
const MAX_PAGES = 4;
const MAX_RUNS = 4096;
const PAD = 2;
export const TEXT_TILE_WIDTH = ATLAS_SIZE - PAD * 2;

interface PendingRun {
  page: Page;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font: string;
  dpr: number;
  baseline: CanvasTextBaseline;
  left: number;
  ascent: number;
  tileStart: number;
  phaseX: number;
  phaseY: number;
}

interface Page {
  texture: WebGLTexture;
  layer: number;
  x: number;
  y: number;
  rowHeight: number;
}

export class WebGLTextAtlas {
  readonly size = ATLAS_SIZE;
  private readonly scratch: OffscreenCanvas | HTMLCanvasElement;
  private readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private readonly runs = new Map<string, CachedText>();
  private metricsEpoch = 0;
  private residentKeyFont = '';
  private residentKeyDpr = NaN;
  private residentKeyBaseline: CanvasTextBaseline | undefined;
  private residentKeyPrefix = '';
  private texture: WebGLTexture | undefined;
  private generationId = 0;
  get generation(): number {
    return this.generationId;
  }
  private readonly pages: Page[] = [];
  private readonly pending: PendingRun[] = [];
  private readonly metrics = new Map<string, TextMetrics>();
  private evictOldestPage(): void {
    const oldest = this.pages.shift();
    if (!oldest) return;
    this.evictPage(oldest);
  }
  private evictPage(page: Page): void {
    for (const [key, run] of this.runs) {
      if (run.run.layer === page.layer) this.runs.delete(key);
    }

    for (let i = this.pending.length - 1; i >= 0; i--)
      if (this.pending[i].page === page) this.pending.splice(i, 1);
    this.generationId++;
  }
  get solidTexture(): WebGLTexture {
    if (this.texture) return this.texture;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate sequence text texture');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      gl.RGBA8,
      ATLAS_SIZE,
      ATLAS_SIZE,
      MAX_PAGES,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const white = new Uint8Array(16).fill(255);
    for (let layer = 0; layer < MAX_PAGES; layer++)
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        2,
        2,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        white
      );
    this.texture = texture;
    return texture;
  }
  private createPage(): Page {
    let layer = 0;
    while (this.pages.some((page) => page.layer === layer)) layer++;
    if (layer >= MAX_PAGES) throw new Error('Sequence text array exceeds its four layers');
    const page: Page = { texture: this.solidTexture, layer, x: 2, y: 0, rowHeight: 2 };
    this.pages.push(page);
    return page;
  }
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly flush: () => void
  ) {
    this.scratch =
      typeof document !== 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(1, 1);
    if ('style' in this.scratch) {
      this.scratch.style.cssText =
        'position:fixed;left:-10000px;top:-10000px;visibility:hidden;pointer-events:none';
      document.body.append(this.scratch);
    }

    const context = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!context || !('measureText' in context))
      throw new Error('Sequence text rasterization is unavailable');
    this.context = context;

    this.scratch.width = ATLAS_SIZE;
    this.scratch.height = ATLAS_SIZE;
  }

  measure(text: string, font: string, baseline: CanvasTextBaseline = 'alphabetic'): TextMetrics {
    const key = `${font}|${baseline}|${text}`;
    const cached = this.metrics.get(key);
    if (cached) return cached;
    this.context.font = font;
    this.context.textBaseline = baseline;
    const metrics = this.context.measureText(text);
    if (this.metrics.size >= MAX_RUNS * 2) {
      this.metrics.clear();
      this.metricsEpoch++;
    }
    this.metrics.set(key, metrics);
    return metrics;
  }

  private residentTextKey(
    text: string,
    font: string,
    dpr: number,
    baseline: CanvasTextBaseline
  ): string {
    if (
      font !== this.residentKeyFont ||
      dpr !== this.residentKeyDpr ||
      baseline !== this.residentKeyBaseline
    ) {
      this.residentKeyFont = font;
      this.residentKeyDpr = dpr;
      this.residentKeyBaseline = baseline;
      this.residentKeyPrefix = `${dpr}|${font}|${baseline}|0|0|0|`;
    }
    return this.residentKeyPrefix + text;
  }

  peekResidentText(
    text: string,
    font: string,
    dpr: number,
    baseline: CanvasTextBaseline
  ): ResidentText | undefined {
    const cached = this.runs.get(this.residentTextKey(text, font, dpr, baseline));
    return cached?.metricsEpoch === this.metricsEpoch ? cached : undefined;
  }

  get(
    text: string,
    font: string,
    dpr: number,
    baseline: CanvasTextBaseline,
    tile = 0,
    phaseX = 0,
    phaseY = 0
  ): TextRun {
    const key =
      tile === 0 && phaseX === 0 && phaseY === 0
        ? this.residentTextKey(text, font, dpr, baseline)
        : `${dpr}|${font}|${baseline}|${tile}|${phaseX}|${phaseY}|${text}`;
    const cached = this.runs.get(key);
    if (cached) {
      if (cached.metricsEpoch !== this.metricsEpoch) {
        const metrics = this.metrics.get(`${font}|${baseline}|${text}`);
        if (metrics) {
          cached.metrics = metrics;
          cached.metricsEpoch = this.metricsEpoch;
        }
      }
      return cached.run;
    }
    const metrics = this.measure(text, font, baseline);
    const left = Math.ceil(metrics.actualBoundingBoxLeft || 0);
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent);
    const descent = Math.ceil(metrics.actualBoundingBoxDescent);
    const tileStart = tile * TEXT_TILE_WIDTH;
    const inkWidth = Math.max(
      1,
      Math.ceil((left + (metrics.actualBoundingBoxRight || metrics.width)) * dpr)
    );
    const width = Math.min(TEXT_TILE_WIDTH, Math.max(1, inkWidth - tileStart)) + PAD * 2;
    const height = Math.max(1, Math.ceil((ascent + descent) * dpr) + PAD * 2);
    if (width > ATLAS_SIZE || height > ATLAS_SIZE)
      throw new Error('Sequence label exceeds GPU text atlas size');
    let page = this.pages[this.pages.length - 1];
    if (page && page.x + width > ATLAS_SIZE) {
      page.x = 0;
      page.y += page.rowHeight;
      page.rowHeight = 0;
    }
    if (!page || page.y + height > ATLAS_SIZE) {
      if (this.pages.length >= MAX_PAGES) {
        this.flush();
        this.evictOldestPage();
      }
      page = this.createPage();
    }
    this.pending.push({
      page,
      x: page.x,
      y: page.y,
      width,
      height,
      text,
      font,
      dpr,
      baseline,
      left,
      ascent,
      tileStart,
      phaseX,
      phaseY,
    });
    const run: TextRun = {
      texture: page.texture,
      layer: page.layer,
      x: page.x + PAD,
      y: page.y,
      width: width - PAD * 2,
      height,
      left: -left + (tileStart - phaseX) / dpr,
      top: -ascent - (PAD + phaseY) / dpr,
      advance: metrics.width,
      ascent,
      descent,
    };
    page.x += width;
    page.rowHeight = Math.max(page.rowHeight, height);
    this.runs.set(key, { run, metrics, metricsEpoch: this.metricsEpoch });
    return run;
  }

  uploadPending(): void {
    if (!this.pending.length) return;
    const pending = this.pending.splice(0);
    const pages = new Map<Page, Map<number, PendingRun[]>>();
    for (const run of pending) {
      let shelves = pages.get(run.page);
      if (!shelves) {
        shelves = new Map();
        pages.set(run.page, shelves);
      }
      const shelf = shelves.get(run.y);
      if (shelf) shelf.push(run);
      else shelves.set(run.y, [run]);
    }
    for (const [page, shelves] of pages) {
      this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, page.texture);
      for (const [top, runs] of shelves) {
        let left = ATLAS_SIZE,
          right = 0,
          bottom = top;
        for (const run of runs) {
          left = Math.min(left, run.x);
          right = Math.max(right, run.x + run.width);
          bottom = Math.max(bottom, run.y + run.height);
        }
        const dirtyWidth = right - left;
        const dirtyHeight = bottom - top;
        this.context.save();
        this.context.setTransform(1, 0, 0, 1, 0, 0);
        this.context.clearRect(0, 0, dirtyWidth, dirtyHeight);
        this.context.restore();
        for (const run of runs) {
          const { dpr } = run;
          const x = run.x - left,
            y = run.y - top;
          this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.context.save();
          this.context.beginPath();
          this.context.rect(x / dpr, y / dpr, run.width / dpr, run.height / dpr);
          this.context.clip();
          this.context.font = run.font;
          this.context.textAlign = 'left';
          this.context.textBaseline = run.baseline;
          this.context.fillStyle = '#ffffff';
          this.context.fillText(
            run.text,
            run.left + (x + PAD - run.tileStart + run.phaseX) / dpr,
            run.ascent + (y + PAD + run.phaseY) / dpr
          );
          this.context.restore();
        }
        const pixels = this.context.getImageData(0, 0, dirtyWidth, dirtyHeight);

        this.gl.texSubImage3D(
          this.gl.TEXTURE_2D_ARRAY,
          0,
          left,
          top,
          page.layer,
          dirtyWidth,
          dirtyHeight,
          1,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          pixels.data
        );
      }
    }
  }

  beginFrame(): void {
    if (this.runs.size > MAX_RUNS) {
      this.flush();
      this.evictOldestPage();
    }
  }
  dispose(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = undefined;
    this.generationId++;
    this.pages.length = 0;
    this.pending.length = 0;
    this.metrics.clear();
    this.metricsEpoch++;
    this.runs.clear();
  }
  destroy(): void {
    this.dispose();
    this.scratch.width = 1;
    this.scratch.height = 1;
    if ('remove' in this.scratch) this.scratch.remove();
  }
}
