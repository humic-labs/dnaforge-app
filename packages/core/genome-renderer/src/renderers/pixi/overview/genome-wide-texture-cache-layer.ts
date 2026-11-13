import { Container, ImageSource, Renderer, RenderTexture, Sprite, Texture } from 'pixi.js';
import type { ViewerRenderContract } from './viewer-render-contract';
import type { RetainedLinearTranscriptLayer } from './retained-linear-transcript-layer';
import {
  isPrebuiltAnnotationRasterLaneProjectionV1,
  isPrebuiltAnnotationRasterPresentationReceiptV1,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from './prebuilt-annotation-raster-contract';

const DEFAULT_TEXTURE_WIDTH = 8192;

export interface PrebuiltGenomeWideTextureMeta {
  widthPx: number;
  heightPx: number;
  resolution: number;
  spineOffsetPx: number;
  genomeLength: number;
  semanticReceipt?: PrebuiltAnnotationRasterPresentationReceiptV1;
  laneProjection?: PrebuiltAnnotationRasterLaneProjectionV1;
}

export interface GenomeWideTextureCompositeArgs {
  renderer: Renderer;
  source: RetainedLinearTranscriptLayer;
  genomeLength: number;
  trackHeightPx: number;
  spineOffsetPx: number;
  liveContract: ViewerRenderContract;
}

export interface PreparedPrebuiltGenomeWideTexture {
  readonly texture: Texture;
  readonly meta: PrebuiltGenomeWideTextureMeta;
}

export class GenomeWideTextureCacheLayer {
  readonly container = new Container();
  private renderTexture: RenderTexture | null = null;
  private textureWidthPx = 0;
  private textureHeightPx = 0;
  private textureResolution = 1;
  private spineOffsetPx = 0;
  private genomeLength = 0;
  renderCount = 0;

  private prebuiltSprite: Sprite | null = null;
  private prebuiltTexture: Texture | null = null;
  private prebuiltMeta: PrebuiltGenomeWideTextureMeta | null = null;
  private readonly preparedPrebuiltTextures = new Set<PreparedPrebuiltGenomeWideTexture>();
  prebuiltCompositeCount = 0;

  constructor() {
    this.container.eventMode = 'none';
    this.container.visible = false;
  }

  get isPresenting(): boolean {
    if (!this.container.visible) return false;
    return this.prebuiltSprite?.visible ?? false;
  }

  get runtimeTexturePresenting(): boolean {
    return false;
  }

  get prebuiltTexturePresenting(): boolean {
    return this.container.visible && (this.prebuiltSprite?.visible ?? false);
  }

  loadPrebuiltTexture(image: ImageBitmap, meta: PrebuiltGenomeWideTextureMeta): void {
    const prepared = this.preparePrebuiltTexture(image, meta);
    if (prepared) this.activatePreparedPrebuiltTexture(prepared);
  }

  preparePrebuiltTexture(
    image: ImageBitmap,
    meta: PrebuiltGenomeWideTextureMeta
  ): PreparedPrebuiltGenomeWideTexture | null {
    if (
      meta.genomeLength <= 0 ||
      meta.widthPx <= 0 ||
      meta.heightPx <= 0 ||
      !Number.isFinite(meta.resolution) ||
      meta.resolution <= 0
    ) {
      return null;
    }
    const semanticReceipt = isPrebuiltAnnotationRasterPresentationReceiptV1(meta.semanticReceipt)
      ? Object.freeze({
          ...meta.semanticReceipt,
          layerTypes: Object.freeze([...meta.semanticReceipt.layerTypes]),
        })
      : undefined;
    const laneProjectionProvided = meta.laneProjection !== undefined;
    const laneProjection = isPrebuiltAnnotationRasterLaneProjectionV1(meta.laneProjection)
      ? Object.freeze({ ...meta.laneProjection })
      : undefined;
    if (
      laneProjectionProvided &&
      (!semanticReceipt ||
        !laneProjection ||
        laneProjection.sourceMaxAnnotationLane !== semanticReceipt.maxAnnotationLane ||
        meta.heightPx !== laneProjection.presentedHeightPx ||
        meta.spineOffsetPx !== laneProjection.presentedSpineOffsetPx ||
        !imageMatchesProjectedMeta(image, meta))
    ) {
      return null;
    }
    const source = new ImageSource({
      resource: image,
      resolution: Math.max(1, meta.resolution),
      scaleMode: 'nearest',
      antialias: true,
    });
    const texture = new Texture({ source });
    const prepared = {
      texture,
      meta: { ...meta, semanticReceipt, laneProjection },
    } satisfies PreparedPrebuiltGenomeWideTexture;
    this.preparedPrebuiltTextures.add(prepared);
    return prepared;
  }

  activatePreparedPrebuiltTexture(prepared: PreparedPrebuiltGenomeWideTexture): boolean {
    if (!this.preparedPrebuiltTextures.delete(prepared)) return false;
    const previousTexture = this.prebuiltTexture;
    this.prebuiltTexture = prepared.texture;
    if (!this.prebuiltSprite) {
      this.prebuiltSprite = new Sprite(prepared.texture);
      this.prebuiltSprite.eventMode = 'none';
      this.prebuiltSprite.roundPixels = true;
      this.container.addChild(this.prebuiltSprite);
    } else {
      this.prebuiltSprite.texture = prepared.texture;
    }
    this.prebuiltMeta = prepared.meta;
    previousTexture?.destroy(true);
    return true;
  }

  discardPreparedPrebuiltTexture(prepared: PreparedPrebuiltGenomeWideTexture): void {
    if (!this.preparedPrebuiltTextures.delete(prepared)) return;
    prepared.texture.destroy(true);
  }

  hasPrebuilt(): boolean {
    return this.prebuiltSprite !== null && this.prebuiltMeta !== null;
  }

  get prebuiltWidthPx(): number {
    return this.prebuiltMeta?.widthPx ?? 0;
  }

  get prebuiltResolution(): number {
    return this.prebuiltMeta?.resolution ?? 1;
  }

  get prebuiltSemanticReceipt(): PrebuiltAnnotationRasterPresentationReceiptV1 | null {
    return this.prebuiltMeta?.semanticReceipt ?? null;
  }

  get prebuiltLaneProjection(): PrebuiltAnnotationRasterLaneProjectionV1 | null {
    return this.prebuiltMeta?.laneProjection ?? null;
  }

  clearPrebuilt(): void {
    for (const prepared of this.preparedPrebuiltTextures) {
      prepared.texture.destroy(true);
    }
    this.preparedPrebuiltTextures.clear();
    this.prebuiltSprite?.destroy();
    this.prebuiltSprite = null;
    this.prebuiltTexture?.destroy(true);
    this.prebuiltTexture = null;
    this.prebuiltMeta = null;
  }

  compositePrebuilt(liveContract: ViewerRenderContract): boolean {
    const meta = this.prebuiltMeta;
    const sprite = this.prebuiltSprite;
    if (!meta || !sprite) return false;
    sprite.visible = true;
    this.positionGenomeWideSprite(
      sprite,
      liveContract,
      meta.widthPx,
      meta.genomeLength,
      meta.resolution,
      meta.spineOffsetPx
    );
    this.container.visible = true;
    this.prebuiltCompositeCount += 1;
    return true;
  }

  private positionGenomeWideSprite(
    sprite: Sprite,
    liveContract: ViewerRenderContract,
    textureWidthPx: number,
    spanBp: number,
    resolution: number,
    spineOffsetPx: number
  ): void {
    const texturePixelsPerBp = textureWidthPx / spanBp;
    const r = resolution;
    sprite.x = Math.round(liveContract.projectX(0) * r) / r;
    sprite.scale.x = liveContract.pixelsPerBp / texturePixelsPerBp;
    sprite.y = Math.round((liveContract.projectY(0) - spineOffsetPx) * r) / r;
    sprite.scale.y = 1;
  }

  private rebuild(args: GenomeWideTextureCompositeArgs): boolean {
    const resolution = Math.max(1, args.renderer.resolution ?? 1);
    const maxTexDevice = maxTextureWidth(args.renderer);
    const texW = Math.min(DEFAULT_TEXTURE_WIDTH, Math.floor(maxTexDevice / resolution));
    const texH = Math.max(1, Math.ceil(args.trackHeightPx));
    try {
      if (
        !this.renderTexture ||
        this.textureWidthPx !== texW ||
        this.textureHeightPx !== texH ||
        this.textureResolution !== resolution
      ) {
        this.renderTexture?.destroy(true);
        this.renderTexture = RenderTexture.create({
          width: texW,
          height: texH,
          resolution,
          antialias: true,
        });
        this.renderTexture.source.scaleMode = 'nearest';
        this.textureWidthPx = texW;
        this.textureHeightPx = texH;
        this.textureResolution = resolution;
      }
      const pixelsPerBp = texW / Math.max(1, args.genomeLength);
      const genomeContract: ViewerRenderContract = {
        projectX: (bp) => bp * pixelsPerBp,
        projectY: (offsetPx) => args.spineOffsetPx + offsetPx,
        pixelsPerBp,
        xOriginBp: 0,
      };
      args.source.updateCamera(genomeContract, texW, texH, 0);
      args.renderer.render({
        container: args.source.container,
        target: this.renderTexture,
        clear: true,
      });
      args.source.updateCamera(args.liveContract, 0, 0, 0);

      this.genomeLength = args.genomeLength;
      this.spineOffsetPx = args.spineOffsetPx;
      this.renderCount += 1;
      return true;
    } catch {
      return false;
    }
  }

  async buildAndExtractPng(args: GenomeWideTextureCompositeArgs): Promise<{
    dataUrl: string;
    widthPx: number;
    heightPx: number;
    resolution: number;
    spineOffsetPx: number;
    genomeLength: number;
  } | null> {
    if (!this.rebuild(args)) return null;
    if (!this.renderTexture) return null;
    try {
      const dataUrl = await args.renderer.extract.base64({
        target: this.renderTexture,
        format: 'png',
      });
      return {
        dataUrl,
        widthPx: this.textureWidthPx,
        heightPx: this.textureHeightPx,
        resolution: this.textureResolution,
        spineOffsetPx: this.spineOffsetPx,
        genomeLength: this.genomeLength,
      };
    } catch {
      return null;
    }
  }

  hide(): void {
    this.container.visible = false;
  }

  resetData(): void {
    this.genomeLength = 0;
    if (this.prebuiltSprite) this.prebuiltSprite.visible = false;
    this.container.visible = false;
  }

  destroy(): void {
    this.renderTexture?.destroy(true);
    this.renderTexture = null;
    this.clearPrebuilt();
    this.container.destroy({ children: true });
  }
}

function maxTextureWidth(renderer: Renderer): number {
  const gl = (renderer as Renderer & { gl?: WebGLRenderingContext }).gl;
  if (gl && typeof gl.getParameter === 'function') {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (typeof max === 'number' && max > 0) return max;
  }
  return DEFAULT_TEXTURE_WIDTH;
}

function imageMatchesProjectedMeta(
  image: ImageBitmap,
  meta: PrebuiltGenomeWideTextureMeta
): boolean {
  const physicalWidthPx = meta.widthPx * meta.resolution;
  const physicalHeightPx = meta.heightPx * meta.resolution;
  return (
    Number.isSafeInteger(physicalWidthPx) &&
    Number.isSafeInteger(physicalHeightPx) &&
    image.width === physicalWidthPx &&
    image.height === physicalHeightPx
  );
}
