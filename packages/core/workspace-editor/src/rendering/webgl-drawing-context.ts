import { SEQUENCE_VERTEX_FLOATS } from './webgl-vertex-layout';
import type { SequenceDrawingContext } from './drawing-context';
import { morphBandY, morphSpanAffine, type RowMorphBands } from '../predictive-wrap-layout';
import { clipMorphPolygon, type MorphVertex } from './webgl-row-morph';
import {
  multiplyTransforms,
  parseWebGLColor,
  transformPoint,
  triangulatePath,
  strokePathTriangles,
  WebGLLinearGradient,
  type Point,
  type RGBA,
  type Transform,
} from './webgl-geometry';
import { WebGLTextAtlas, TEXT_TILE_WIDTH } from './webgl-text-atlas';
import { RetainedWebGLBatches } from './retained-webgl-batches';

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Style = string | CanvasGradient | CanvasPattern;
interface Subpath {
  points: Point[];
  closed: boolean;
}
interface State {
  fillStyle: Style;
  strokeStyle: Style;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  transform: Transform;
  dash: number[];
  lineDashOffset: number;
  clips: Point[][];
  rowMorph?: RowMorphBands;
  rowMorphPadding?: number;
}

const STRIDE = SEQUENCE_VERTEX_FLOATS;
const MAX_VERTICES = 65532;
const IDENTITY: Transform = [1, 0, 0, 1, 0, 0];
const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 position;
layout(location=1) in vec2 uv;
layout(location=2) in vec4 color;
layout(location=3) in float layer;
uniform vec2 resolution;
uniform float drawOffsetX;
out vec2 texCoord;
flat out float atlasLayer;
out vec4 tint;
void main(){
  gl_Position=vec4((position+vec2(drawOffsetX,0.0))/resolution*vec2(2.0,-2.0)+vec2(-1.0,1.0),0.0,1.0);
  texCoord=uv;atlasLayer=layer;tint=color;
}`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray atlas;
in vec2 texCoord;
flat in float atlasLayer;
in vec4 tint;
out vec4 outputColor;
void main(){
  float alpha=tint.a*texture(atlas,vec3(texCoord,atlasLayer)).a;
  outputColor=vec4(tint.rgb*alpha,alpha);
}`;
const PRESENT_VERTEX_SHADER = `#version 300 es
void main(){
  vec2 p=gl_VertexID==0?vec2(-1.0,-1.0):gl_VertexID==1?vec2(3.0,-1.0):vec2(-1.0,3.0);
  gl_Position=vec4(p,0.0,1.0);
}`;
const PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D scene;
uniform sampler2D background;
uniform sampler2D rowShift;
uniform vec2 resolution;
uniform vec2 sceneResolution;
uniform float sceneLeftPad;
uniform bool hasBackground;
out vec4 outputColor;
void main(){
  float dx=texelFetch(rowShift,ivec2(0,int(gl_FragCoord.y)),0).r;
  vec2 target=gl_FragCoord.xy/resolution;
  float sourceX=gl_FragCoord.x-dx;
  if(hasBackground){
    // Biological ink has its own transparent, horizontally padded layer.
    // Sample it exactly once; the gray/white stripe is fixed at target.
    float contentX=sourceX+sceneLeftPad;
    vec4 ink=contentX>=0.0 && contentX<sceneResolution.x
      ? texture(scene,vec2(contentX/sceneResolution.x,target.y))
      : vec4(0.0);
    vec4 paper=texture(background,target);
    outputColor=ink+paper*(1.0-ink.a);
  }else if(dx==0.0 || sourceX<0.0 || sourceX>=resolution.x){
    outputColor=texture(scene,target);
  }else{
    outputColor=texture(scene,vec2(sourceX/resolution.x,target.y));
  }
}`;

function initialState(): State {
  return {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    transform: [...IDENTITY],
    dash: [],
    lineDashOffset: 0,
    clips: [],
  };
}

export class WebGLDrawingContext implements SequenceDrawingContext {
  readonly gl: WebGL2RenderingContext;
  private readonly maxTextureSize: number;
  private state = initialState();
  private readonly stack: State[] = [];
  private paths: Subpath[] = [];
  private program!: WebGLProgram;
  private presentProgram!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private retainedBatches!: RetainedWebGLBatches;
  private geometryLayer: string | null = null;
  private vao!: WebGLVertexArrayObject;
  private sceneTexture!: WebGLTexture;
  private backgroundTexture!: WebGLTexture;
  private sceneFramebuffer!: WebGLFramebuffer;
  private sceneStencil!: WebGLRenderbuffer;
  private rowShiftTexture!: WebGLTexture;
  private resolution!: WebGLUniformLocation;
  private drawOffsetX!: WebGLUniformLocation;
  private presentResolution!: WebGLUniformLocation;
  private presentSceneResolution!: WebGLUniformLocation;
  private presentSceneLeftPad!: WebGLUniformLocation;
  private presentSceneSampler!: WebGLUniformLocation;
  private presentBackgroundSampler!: WebGLUniformLocation;
  private presentShiftSampler!: WebGLUniformLocation;
  private presentHasBackground!: WebGLUniformLocation;
  private sceneWidth = 0;
  private sceneHeight = 0;
  private sceneStorageWidth = 0;
  private sceneStorageHeight = 0;
  private sceneStorageFormat = 0;
  private presentationLeftPad = 0;
  private presentationRightPad = 0;
  private sceneReady = false;
  private backgroundReady = false;
  private shiftPixels = new Float32Array(0);
  private atlas!: WebGLTextAtlas;
  private readonly vertices = new Float32Array(MAX_VERTICES * STRIDE);
  private vertexCount = 0;
  private batchTexture: WebGLTexture | null = null;
  private readonly colors = new Map<string, RGBA>();
  private disposed = false;
  private drawCalls = 0;
  private frameVertices = 0;
  private readonly fontSet = typeof document === 'undefined' ? undefined : document.fonts;
  private readonly fontsChanged = (): void => {
    if (this.disposed || this.gl.isContextLost()) return;
    this.flush();
    this.atlas.dispose();
    this.sceneReady = false;
    this.backgroundReady = false;
    this.onRestore?.();
  };
  private readonly lost = (event: Event): void => {
    event.preventDefault();
    this.vertexCount = 0;
    this.sceneReady = false;
    this.backgroundReady = false;
    this.setStatus('context-lost');
  };
  private readonly restored = (): void => {
    if (this.disposed) return;
    try {
      this.releaseResources();
      this.initialize();
      this.setStatus('ready');
      this.onRestore?.();
    } catch (error) {
      this.setStatus('error');
      if ('dataset' in this.canvas)
        this.canvas.dispatchEvent(
          new CustomEvent('sequence-render-error', {
            bubbles: true,
            detail: error instanceof Error ? error.message : String(error),
          })
        );
    }
  };
  onRestore: (() => void) | undefined;
  onStatus: ((status: string) => void) | undefined;
  get frameStats(): { drawCalls: number; vertices: number } {
    return { drawCalls: this.drawCalls, vertices: this.frameVertices };
  }

  constructor(
    readonly canvas: Surface,
    options: { alpha?: boolean } = {}
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: options.alpha ?? true,
      antialias: true,
      depth: false,
      stencil: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl || !('createVertexArray' in gl)) {
      throw new Error(
        'WebGL 2 is unavailable. Enable hardware acceleration and reopen the sequence viewer.'
      );
    }
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    try {
      this.initialize();
    } catch (error) {
      this.releaseResources();
      throw error;
    }
    canvas.addEventListener('webglcontextlost', this.lost);
    canvas.addEventListener('webglcontextrestored', this.restored);
    this.fontSet?.addEventListener('loadingdone', this.fontsChanged);
    this.setStatus('ready');
  }

  private setStatus(status: string): void {
    this.onStatus?.(status);
    if ('dataset' in this.canvas) {
      this.canvas.dataset.renderer = 'webgl2';
      this.canvas.dataset.renderStatus = status;
      this.canvas.dispatchEvent(
        new CustomEvent('sequence-render-status', { bubbles: true, detail: status })
      );
    }
  }

  private initialize(): void {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to allocate sequence shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Sequence shader compilation failed: ${message}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate sequence GPU program');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Sequence shader linking failed: ${message}`);
    }
    this.program = program;
    const presentVertex = compile(gl.VERTEX_SHADER, PRESENT_VERTEX_SHADER);
    const presentFragment = compile(gl.FRAGMENT_SHADER, PRESENT_FRAGMENT_SHADER);
    const presentProgram = gl.createProgram();
    if (!presentProgram) throw new Error('Unable to allocate sequence presentation program');
    gl.attachShader(presentProgram, presentVertex);
    gl.attachShader(presentProgram, presentFragment);
    gl.linkProgram(presentProgram);
    gl.deleteShader(presentVertex);
    gl.deleteShader(presentFragment);
    if (!gl.getProgramParameter(presentProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(presentProgram);
      gl.deleteProgram(presentProgram);
      throw new Error(`Sequence presentation shader linking failed: ${message}`);
    }
    this.presentProgram = presentProgram;
    const buffer = gl.createBuffer(),
      vao = gl.createVertexArray(),
      sceneTexture = gl.createTexture(),
      backgroundTexture = gl.createTexture(),
      sceneFramebuffer = gl.createFramebuffer(),
      sceneStencil = gl.createRenderbuffer(),
      rowShiftTexture = gl.createTexture();
    const resolution = gl.getUniformLocation(program, 'resolution');
    const drawOffsetX = gl.getUniformLocation(program, 'drawOffsetX');
    const presentResolution = gl.getUniformLocation(presentProgram, 'resolution');
    const presentSceneResolution = gl.getUniformLocation(presentProgram, 'sceneResolution');
    const presentSceneLeftPad = gl.getUniformLocation(presentProgram, 'sceneLeftPad');
    const presentSceneSampler = gl.getUniformLocation(presentProgram, 'scene');
    const presentBackgroundSampler = gl.getUniformLocation(presentProgram, 'background');
    const presentShiftSampler = gl.getUniformLocation(presentProgram, 'rowShift');
    const presentHasBackground = gl.getUniformLocation(presentProgram, 'hasBackground');
    if (
      !buffer ||
      !vao ||
      !sceneTexture ||
      !backgroundTexture ||
      !sceneFramebuffer ||
      !sceneStencil ||
      !rowShiftTexture ||
      !resolution ||
      !drawOffsetX ||
      !presentResolution ||
      !presentSceneResolution ||
      !presentSceneLeftPad ||
      !presentSceneSampler ||
      !presentBackgroundSampler ||
      !presentShiftSampler ||
      !presentHasBackground
    )
      throw new Error('Unable to allocate sequence GPU resources');
    this.buffer = buffer;
    this.retainedBatches = new RetainedWebGLBatches(gl);
    this.vao = vao;
    this.sceneTexture = sceneTexture;
    this.backgroundTexture = backgroundTexture;
    this.sceneFramebuffer = sceneFramebuffer;
    this.sceneStencil = sceneStencil;
    this.rowShiftTexture = rowShiftTexture;
    this.resolution = resolution;
    this.drawOffsetX = drawOffsetX;
    this.presentResolution = presentResolution;
    this.presentSceneResolution = presentSceneResolution;
    this.presentSceneLeftPad = presentSceneLeftPad;
    this.presentSceneSampler = presentSceneSampler;
    this.presentBackgroundSampler = presentBackgroundSampler;
    this.presentShiftSampler = presentShiftSampler;
    this.presentHasBackground = presentHasBackground;
    this.sceneWidth = 0;
    this.sceneHeight = 0;
    this.sceneStorageWidth = 0;
    this.sceneStorageHeight = 0;
    this.sceneStorageFormat = 0;
    this.sceneReady = false;
    this.backgroundReady = false;
    this.presentationLeftPad = 0;
    this.presentationRightPad = 0;
    this.shiftPixels = new Float32Array(0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE * 4, 32);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, rowShiftTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.atlas = new WebGLTextAtlas(gl, () => this.flush());
    this.batchTexture = null;
    this.vertexCount = 0;
  }

  beginFrame(): boolean {
    if (this.disposed || this.gl.isContextLost()) return false;
    this.vertexCount = 0;
    this.geometryLayer = null;
    this.retainedBatches.beginFrame();
    this.batchTexture = null;
    this.drawCalls = 0;
    this.frameVertices = 0;
    this.sceneReady = false;
    this.backgroundReady = false;
    this.stack.length = 0;
    this.state = initialState();
    this.beginPath();
    this.atlas.beginFrame();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.drawOffsetX, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    return true;
  }

  flush(): void {
    if (!this.vertexCount || this.disposed || this.gl.isContextLost()) {
      this.vertexCount = 0;
      return;
    }
    this.atlas.uploadPending();
    const gl = this.gl;
    gl.useProgram(this.program);
    const data = this.vertices.subarray(0, this.vertexCount * STRIDE);
    const texture = this.batchTexture ?? this.atlas.solidTexture;
    if (this.geometryLayer !== null) {
      this.retainedBatches.draw(this.geometryLayer, data, texture);
    } else {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }
    this.drawCalls += 1;
    this.frameVertices += this.vertexCount;
    this.vertexCount = 0;
  }

  endFrame(): void {
    this.flush();
    this.retainedBatches.endFrame();
    if ('dataset' in this.canvas) {
      this.canvas.dataset.gpuDrawCalls = String(this.drawCalls);
      this.canvas.dataset.gpuVertices = String(this.frameVertices);
      this.canvas.dataset.renderStatus = this.gl.isContextLost() ? 'context-lost' : 'ready';
    }
  }

  setGeometryLayer(layer: string | null): void {
    this.flush();
    this.geometryLayer = layer;
  }

  setPresentationShiftBounds(bands: readonly { dx: number }[], dpr: number): void {
    this.presentationLeftPad = Math.ceil(Math.max(0, ...bands.map((band) => band.dx * dpr))) + 2;
    this.presentationRightPad = Math.ceil(Math.max(0, ...bands.map((band) => -band.dx * dpr))) + 2;
  }

  private ensurePresentationTextures(): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const viewportResized = width !== this.sceneWidth || height !== this.sceneHeight;
    if (viewportResized) {
      const hasAlpha = gl.getContextAttributes()?.alpha !== false;
      const format = hasAlpha ? gl.RGBA : gl.RGB;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        hasAlpha ? gl.RGBA8 : gl.RGB8,
        width,
        height,
        0,
        format,
        gl.UNSIGNED_BYTE,
        null
      );
      this.sceneWidth = width;
      this.sceneHeight = height;
      this.shiftPixels = new Float32Array(height);
      gl.bindTexture(gl.TEXTURE_2D, this.rowShiftTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, height, 0, gl.RED, gl.FLOAT, this.shiftPixels);
    }
    const requiredWidth =
      width + (this.backgroundReady ? this.presentationLeftPad + this.presentationRightPad : 0);

    const sceneFormat =
      this.backgroundReady || gl.getContextAttributes()?.alpha !== false ? gl.RGBA8 : gl.RGB8;
    if (
      viewportResized ||
      requiredWidth > this.sceneStorageWidth ||
      height !== this.sceneStorageHeight ||
      sceneFormat !== this.sceneStorageFormat
    ) {
      const maxWidth = this.maxTextureSize;
      if (requiredWidth > maxWidth) {
        throw new Error('Sequence row motion exceeds the available GPU texture width');
      }
      const storageWidth =
        viewportResized || sceneFormat !== this.sceneStorageFormat
          ? requiredWidth
          : Math.min(maxWidth, Math.max(requiredWidth, Math.ceil(this.sceneStorageWidth * 1.5)));
      const format = sceneFormat === gl.RGBA8 ? gl.RGBA : gl.RGB;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        sceneFormat,
        storageWidth,
        height,
        0,
        format,
        gl.UNSIGNED_BYTE,
        null
      );
      this.sceneStorageWidth = storageWidth;
      this.sceneStorageHeight = height;
      this.sceneStorageFormat = sceneFormat;

      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneStencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, storageWidth, height);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFramebuffer);
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.sceneTexture,
      0
    );
    gl.framebufferRenderbuffer(
      gl.DRAW_FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      this.sceneStencil
    );
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  capturePresentationBackground(): void {
    if (this.disposed || this.gl.isContextLost()) return;
    this.flush();
    const gl = this.gl;
    const { width, height } = this.canvas;
    this.backgroundReady = true;
    this.ensurePresentationTextures();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFramebuffer);
    gl.framebufferRenderbuffer(
      gl.DRAW_FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      null
    );
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.backgroundTexture,
      0
    );
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.framebufferTexture2D(
      gl.DRAW_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.sceneTexture,
      0
    );
    gl.framebufferRenderbuffer(
      gl.DRAW_FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      this.sceneStencil
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.viewport(0, 0, this.sceneStorageWidth, height);
    gl.uniform2f(this.resolution, this.sceneStorageWidth, height);
    gl.uniform1f(this.drawOffsetX, this.presentationLeftPad);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  capturePresentationScene(): void {
    if (this.disposed || this.gl.isContextLost()) return;
    this.ensurePresentationTextures();
    const gl = this.gl;
    const { width, height } = this.canvas;
    if (this.backgroundReady) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.sceneReady = true;
      return;
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFramebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.sceneReady = true;
  }

  presentRows(bands: readonly { top: number; bottom: number; dx: number }[], dpr: number): boolean {
    if (!this.sceneReady || this.disposed || this.gl.isContextLost()) return false;
    const gl = this.gl;
    const width = this.sceneWidth;
    const height = this.sceneHeight;
    this.shiftPixels.fill(0);
    for (const band of bands) {
      const top = Math.max(0, Math.min(height, Math.floor(band.top * dpr)));
      const bottom = Math.max(top, Math.min(height, Math.ceil(band.bottom * dpr)));
      this.shiftPixels.fill(band.dx * dpr, height - bottom, height - top);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rowShiftTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, height, gl.RED, gl.FLOAT, this.shiftPixels);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(this.presentProgram);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.presentResolution, width, height);
    gl.uniform2f(this.presentSceneResolution, this.sceneStorageWidth, this.sceneStorageHeight);
    gl.uniform1f(this.presentSceneLeftPad, this.backgroundReady ? this.presentationLeftPad : 0);
    gl.uniform1i(this.presentSceneSampler, 0);
    gl.uniform1i(this.presentShiftSampler, 1);
    gl.uniform1i(this.presentBackgroundSampler, 2);
    gl.uniform1i(this.presentHasBackground, this.backgroundReady ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  private useTexture(texture: WebGLTexture): void {
    if (this.batchTexture !== texture) {
      this.flush();
      this.batchTexture = texture;
    }
  }
  private color(style: Style, x: number, y: number): RGBA {
    if (style instanceof WebGLLinearGradient) return style.colorAt(x, y);
    if (typeof style !== 'string')
      throw new Error('Sequence WebGL painter received an unsupported pattern');
    let color = this.colors.get(style);
    if (!color) {
      color = parseWebGLColor(style);
      if (this.colors.size >= 512) this.colors.clear();
      this.colors.set(style, color);
    }
    return color;
  }
  private vertex(point: Point, u: number, v: number, style: Style, layer = 0): void {
    if (this.vertexCount === MAX_VERTICES) this.flush();
    const offset = this.vertexCount++ * STRIDE;
    const c = this.color(style, point[0], point[1]);
    this.vertices[offset] = point[0];
    this.vertices[offset + 1] = point[1];
    this.vertices[offset + 2] = u;
    this.vertices[offset + 3] = v;
    this.vertices[offset + 4] = c[0];
    this.vertices[offset + 5] = c[1];
    this.vertices[offset + 6] = c[2];
    this.vertices[offset + 7] = c[3] * this.globalAlpha;
    this.vertices[offset + 8] = layer;
  }
  private polygon(points: Point[], style: Style): void {
    if (points.length < 3) return;
    this.useTexture(this.batchTexture ?? this.atlas.solidTexture);
    const indices = triangulatePath(points, typeof style === 'string');
    const shape = this.morphShape(points);
    points = shape.points;
    if (shape.clip && points.some((p) => p[1] < shape.clip![0] || p[1] > shape.clip![1])) {
      const uv = 0.5 / this.atlas.size;
      for (let i = 0; i < indices.length; i += 3)
        this.clippedPolygon(
          indices.slice(i, i + 3).map((index) => [...points[index], uv, uv] as MorphVertex),
          style,
          shape.clip
        );
      return;
    }
    for (const index of indices)
      this.vertex(points[index], 0.5 / this.atlas.size, 0.5 / this.atlas.size, style);
  }
  private quad(
    points: Point[],
    uv: [number, number, number, number],
    style: Style,
    anchorY?: number,
    layer = 0
  ): void {
    const shape = this.morphShape(points, anchorY);
    if (shape.clip && shape.points.some((p) => p[1] < shape.clip![0] || p[1] > shape.clip![1])) {
      for (const [x, y, u, v] of this.quadVertices(points, uv, anchorY))
        this.vertex([x, y], u, v, style, layer);
      return;
    }

    const [a, b, c, d] = shape.points;
    const [u0, v0, u1, v1] = uv;
    this.vertex(a, u0, v0, style, layer);
    this.vertex(b, u1, v0, style, layer);
    this.vertex(c, u1, v1, style, layer);
    this.vertex(a, u0, v0, style, layer);
    this.vertex(c, u1, v1, style, layer);
    this.vertex(d, u0, v1, style, layer);
  }
  private quadVertices(
    points: Point[],
    uv: [number, number, number, number],
    anchorY?: number
  ): MorphVertex[] {
    const shape = this.morphShape(points, anchorY);
    points = shape.points;
    const [u0, v0, u1, v1] = uv;
    if (shape.clip && points.some((p) => p[1] < shape.clip![0] || p[1] > shape.clip![1])) {
      const polygon = clipMorphPolygon(
        [
          [...points[0], u0, v0],
          [...points[1], u1, v0],
          [...points[2], u1, v1],
          [...points[3], u0, v1],
        ],
        shape.clip[0],
        shape.clip[1]
      );
      const triangles: MorphVertex[] = [];
      for (let i = 1; i < polygon.length - 1; i++)
        triangles.push(polygon[0], polygon[i], polygon[i + 1]);
      return triangles;
    }
    const a: MorphVertex = [...points[0], u0, v0],
      b: MorphVertex = [...points[1], u1, v0],
      c: MorphVertex = [...points[2], u1, v1],
      d: MorphVertex = [...points[3], u0, v1];
    return [a, b, c, a, c, d];
  }

  private clippedPolygon(vertices: MorphVertex[], style: Style, clip: [number, number]): void {
    const polygon = clipMorphPolygon(vertices, clip[0], clip[1]);
    for (let i = 1; i < polygon.length - 1; i++)
      for (const vertex of [polygon[0], polygon[i], polygon[i + 1]])
        this.vertex([vertex[0], vertex[1]], vertex[2], vertex[3], style);
  }

  setRowMorphBands(bands: RowMorphBands, origin: number): void {
    const m = this.state.transform;
    this.state.rowMorph = {
      natural: bands.natural.map((y) => (y + origin) * m[3] + m[5]),
      painted: bands.painted.map((y) => (y + origin) * m[3] + m[5]),
    };
    this.state.rowMorphPadding = 2 * Math.hypot(m[0], m[1]);
  }

  private morphShape(
    points: Point[],
    anchorY?: number
  ): { points: Point[]; clip?: [number, number] } {
    const morph = this.state.rowMorph;
    if (!morph) return { points };
    let minY = Infinity,
      maxY = -Infinity;
    for (const point of points) {
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }

    const padding = this.state.rowMorphPadding ?? 2;
    const affine = morphSpanAffine(morph, anchorY ?? minY, anchorY ?? maxY, padding);
    if (affine) {
      const offset = affine.target - affine.start;
      return {
        points: offset === 0 ? points : points.map(([x, y]) => [x, y + offset]),
        clip: affine.scale < 1 ? [affine.target - padding, affine.targetEnd] : undefined,
      };
    }
    return { points: points.map(([x, y]) => [x, morphBandY(morph.natural, morph.painted, y)]) };
  }

  get fillStyle(): Style {
    return this.state.fillStyle;
  }
  set fillStyle(value: Style) {
    this.state.fillStyle = value;
  }
  get strokeStyle(): Style {
    return this.state.strokeStyle;
  }
  set strokeStyle(value: Style) {
    this.state.strokeStyle = value;
  }
  get font(): string {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
  }
  get textAlign(): CanvasTextAlign {
    return this.state.textAlign;
  }
  set textAlign(value: CanvasTextAlign) {
    this.state.textAlign = value;
  }
  get textBaseline(): CanvasTextBaseline {
    return this.state.textBaseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.state.textBaseline = value;
  }
  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (Number.isFinite(value) && value >= 0 && value <= 1) this.state.globalAlpha = value;
  }
  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(value: number) {
    if (value > 0 && Number.isFinite(value)) this.state.lineWidth = value;
  }
  get lineCap(): CanvasLineCap {
    return this.state.lineCap;
  }
  set lineCap(value: CanvasLineCap) {
    this.state.lineCap = value;
  }
  get lineJoin(): CanvasLineJoin {
    return this.state.lineJoin;
  }
  set lineJoin(value: CanvasLineJoin) {
    this.state.lineJoin = value;
  }

  get lineDashOffset(): number {
    return this.state.lineDashOffset;
  }
  set lineDashOffset(value: number) {
    if (Number.isFinite(value)) this.state.lineDashOffset = value;
  }

  save(): void {
    this.stack.push({
      ...this.state,
      transform: [...this.state.transform],
      dash: [...this.state.dash],
      clips: [...this.state.clips],
    });
  }
  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    const changedClip = state.clips.length !== this.state.clips.length;
    this.state = state;
    if (changedClip) this.rebuildClips();
  }
  setTransform(a?: number | DOMMatrix2DInit, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    this.state.transform =
      typeof a === 'object'
        ? [
            a.a ?? a.m11 ?? 1,
            a.b ?? a.m12 ?? 0,
            a.c ?? a.m21 ?? 0,
            a.d ?? a.m22 ?? 1,
            a.e ?? a.m41 ?? 0,
            a.f ?? a.m42 ?? 0,
          ]
        : [a ?? 1, b, c, d, e, f];
  }
  translate(x: number, y: number): void {
    this.state.transform = multiplyTransforms(this.state.transform, [1, 0, 0, 1, x, y]);
  }
  scale(x: number, y: number): void {
    this.state.transform = multiplyTransforms(this.state.transform, [x, 0, 0, y, 0, 0]);
  }
  rotate(angle: number): void {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    this.state.transform = multiplyTransforms(this.state.transform, [c, s, -s, c, 0, 0]);
  }
  setLineDash(values: number[]): void {
    this.state.dash = values.length % 2 ? [...values, ...values] : [...values];
  }
  getLineDash(): number[] {
    return [...this.state.dash];
  }

  beginPath(): void {
    this.paths = [];
  }
  moveTo(x: number, y: number): void {
    this.paths.push({ points: [transformPoint(this.state.transform, x, y)], closed: false });
  }
  lineTo(x: number, y: number): void {
    if (this.paths.length === 0) this.moveTo(x, y);
    else this.paths[this.paths.length - 1].points.push(transformPoint(this.state.transform, x, y));
  }
  closePath(): void {
    const path = this.paths[this.paths.length - 1];
    if (path) path.closed = true;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | DOMPointInit | Iterable<number | DOMPointInit> = 0
  ): void {
    const values =
      typeof radii === 'number' ? [radii] : Symbol.iterator in radii ? [...radii] : [radii];
    const r = values.map((value) => (typeof value === 'number' ? value : (value.x ?? 0)));
    let corners =
      r.length === 1
        ? [r[0], r[0], r[0], r[0]]
        : r.length === 2
          ? [r[0], r[1], r[0], r[1]]
          : r.length === 3
            ? [r[0], r[1], r[2], r[1]]
            : r.slice(0, 4);
    if (w < 0) {
      x += w;
      w = -w;
      corners = [corners[1], corners[0], corners[3], corners[2]];
    }
    if (h < 0) {
      y += h;
      h = -h;
      corners = [corners[3], corners[2], corners[1], corners[0]];
    }
    const factor = Math.min(
      1,
      w / (corners[0] + corners[1] || 1),
      w / (corners[2] + corners[3] || 1),
      h / (corners[0] + corners[3] || 1),
      h / (corners[1] + corners[2] || 1)
    );
    const [tl, tr, br, bl] = corners.map((value) => Math.max(0, value * factor));
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    this.arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - br);
    this.arc(x + w - br, y + h - br, br, 0, Math.PI / 2);
    this.lineTo(x + bl, y + h);
    this.arc(x + bl, y + h - bl, bl, Math.PI / 2, Math.PI);
    this.lineTo(x, y + tl);
    this.arc(x + tl, y + tl, tl, Math.PI, Math.PI * 1.5);
    this.closePath();
  }
  arc(
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    counterclockwise = false
  ): void {
    if (radius < 0) throw new RangeError('Arc radius must be nonnegative');
    let sweep = end - start;
    if (Math.abs(sweep) >= Math.PI * 2) sweep = counterclockwise ? -Math.PI * 2 : Math.PI * 2;
    else if (counterclockwise && sweep > 0) sweep -= Math.PI * 2;
    else if (!counterclockwise && sweep < 0) sweep += Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(1, radius) * 2)));
    for (let i = 0; i <= steps; i += 1) {
      const angle = start + (sweep * i) / steps;
      this.lineTo(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    }
  }
  fill(): void {
    for (const path of this.paths) this.polygon(path.points, this.fillStyle);
  }
  prepareRepeatedPath(
    points: readonly Point[],
    mode: 'fill' | 'stroke',
    closed = false
  ): ((offsetX: number) => void) | null {
    const m = this.state.transform;

    if (m[1] !== 0 || (mode === 'stroke' && this.state.dash.some((v) => v > 0))) return null;
    const style = mode === 'fill' ? this.fillStyle : this.strokeStyle;
    if (typeof style !== 'string') return null;
    let triangles: Point[];
    if (mode === 'fill') {
      const transformed = points.map(([x, y]) => transformPoint(m, x, y));
      const indices = triangulatePath(transformed, true);
      const shape = this.morphShape(transformed);
      triangles = indices.map((i) => shape.points[i]);
      if (shape.clip) triangles = this.clipPreparedTriangles(triangles, shape.clip);
    } else {
      const transformed = strokePathTriangles(
        points,
        this.lineWidth,
        closed,
        this.lineCap,
        this.lineJoin
      ).map(([x, y]) => transformPoint(m, x, y));
      const shape = this.morphShape(transformed);
      triangles = shape.clip ? this.clipPreparedTriangles(shape.points, shape.clip) : shape.points;
    }

    const uv = 0.5 / this.atlas.size;
    return this.prepareTriangles(
      triangles.map(([x, y]) => [x, y, uv, uv]),
      null,
      mode
    );
  }

  private prepareTriangles(
    triangles: MorphVertex[],
    texture: WebGLTexture | null,
    mode: 'fill' | 'stroke',
    layer = 0,
    offsetScaleX = this.state.transform[0],
    retainTextCoordinates = false
  ): (offsetX: number) => void {
    let coordinateStride = 4;
    if (retainTextCoordinates) {
      coordinateStride = 1;
      for (const point of triangles) {
        if (
          !Number.isFinite(point[0]) ||
          !Number.isFinite(point[1]) ||
          !Number.isFinite(point[2]) ||
          !Number.isFinite(point[3])
        ) {
          coordinateStride = 4;
          break;
        }
      }
    }
    const retainedCoordinates = coordinateStride === 1 ? triangles : null;
    const coordinates = new Float64Array(triangles.length * coordinateStride);
    const template = new Float32Array(triangles.length * STRIDE);
    let finiteCoordinates = Number.isFinite(layer);
    for (let i = 0; i < triangles.length; i++) {
      const point = triangles[i],
        at = i * coordinateStride,
        vertex = i * STRIDE;
      finiteCoordinates &&=
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]) &&
        Number.isFinite(point[2]) &&
        Number.isFinite(point[3]);
      coordinates[at] = point[0];
      if (coordinateStride === 4) {
        coordinates[at + 1] = point[1];
        coordinates[at + 2] = point[2];
        coordinates[at + 3] = point[3];
      }
      template[vertex + 1] = point[1];
      template[vertex + 2] = point[2];
      template[vertex + 3] = point[3];
      template[vertex + 8] = layer;
    }
    let hasColor = false,
      templateHasColor = false,
      red = 0,
      green = 0,
      blue = 0,
      effectiveAlpha = 0;
    return (offsetX: number) => {
      const style = mode === 'fill' ? this.fillStyle : this.strokeStyle;
      const dx = offsetX * offsetScaleX;
      this.useTexture(texture ?? this.batchTexture ?? this.atlas.solidTexture);
      if (typeof style !== 'string') {
        if (retainedCoordinates) {
          for (let i = 0; i < coordinates.length; i++) {
            const point = retainedCoordinates[i];
            this.vertex([coordinates[i] + dx, point[1]], point[2], point[3], style, layer);
          }
        } else {
          for (let i = 0; i < coordinates.length; i += 4)
            this.vertex(
              [coordinates[i] + dx, coordinates[i + 1]],
              coordinates[i + 2],
              coordinates[i + 3],
              style,
              layer
            );
        }
        return;
      }
      const color = this.color(style, 0, 0);
      const alpha = color[3] * this.globalAlpha;
      const colorChanged =
        !hasColor ||
        !Object.is(red, color[0]) ||
        !Object.is(green, color[1]) ||
        !Object.is(blue, color[2]) ||
        !Object.is(effectiveAlpha, alpha) ||
        Number.isNaN(color[0]) ||
        Number.isNaN(color[1]) ||
        Number.isNaN(color[2]) ||
        Number.isNaN(alpha);
      if (colorChanged) {
        red = color[0];
        green = color[1];
        blue = color[2];
        effectiveAlpha = alpha;
        hasColor = true;
        templateHasColor = false;
      }
      if (
        finiteCoordinates &&
        Number.isFinite(dx) &&
        colorChanged &&
        Number.isFinite(red) &&
        Number.isFinite(green) &&
        Number.isFinite(blue) &&
        Number.isFinite(effectiveAlpha)
      ) {
        const vertices = this.vertices;
        for (
          let i = 0, vertex = 0;
          i < coordinates.length;
          i += coordinateStride, vertex += STRIDE
        ) {
          if (this.vertexCount === MAX_VERTICES) this.flush();
          const at = this.vertexCount++ * STRIDE;
          vertices[at] = coordinates[i] + dx;
          vertices[at + 1] = template[vertex + 1];
          vertices[at + 2] = template[vertex + 2];
          vertices[at + 3] = template[vertex + 3];
          vertices[at + 4] = red;
          vertices[at + 5] = green;
          vertices[at + 6] = blue;
          vertices[at + 7] = effectiveAlpha;
          vertices[at + 8] = template[vertex + 8];
        }
        return;
      }
      if (!templateHasColor) {
        for (let at = 4; at < template.length; at += STRIDE) {
          template[at] = red;
          template[at + 1] = green;
          template[at + 2] = blue;
          template[at + 3] = effectiveAlpha;
        }
        templateHasColor = true;
      }
      const vertices = this.vertices;
      let i = 0;

      if (coordinateStride === 4) {
        while (i < coordinates.length) {
          if (this.vertexCount === MAX_VERTICES) this.flush();
          const end = Math.min(coordinates.length, i + (MAX_VERTICES - this.vertexCount) * 4);
          let at = this.vertexCount * STRIDE;
          vertices.set(
            i === 0 && end === coordinates.length
              ? template
              : template.subarray((i / 4) * STRIDE, (end / 4) * STRIDE),
            at
          );
          this.vertexCount += (end - i) / 4;
          for (; i < end; i += 4, at += STRIDE) vertices[at] = coordinates[i] + dx;
        }
      } else {
        while (i < coordinates.length) {
          if (this.vertexCount === MAX_VERTICES) this.flush();
          const end = Math.min(coordinates.length, i + MAX_VERTICES - this.vertexCount);
          let at = this.vertexCount * STRIDE;
          vertices.set(
            i === 0 && end === coordinates.length
              ? template
              : template.subarray(i * STRIDE, end * STRIDE),
            at
          );
          this.vertexCount += end - i;
          for (; i < end; i++, at += STRIDE) vertices[at] = coordinates[i] + dx;
        }
      }
    };
  }

  private clipPreparedTriangles(triangles: Point[], clip: [number, number]): Point[] {
    if (triangles.every((p) => p[1] >= clip[0] && p[1] <= clip[1])) return triangles;
    const clipped: Point[] = [];
    for (let i = 0; i < triangles.length; i += 3) {
      const polygon = clipMorphPolygon(
        triangles.slice(i, i + 3).map(([x, y]) => [x, y, 0, 0]),
        clip[0],
        clip[1]
      );
      for (let j = 1; j < polygon.length - 1; j++)
        for (const p of [polygon[0], polygon[j], polygon[j + 1]]) clipped.push([p[0], p[1]]);
    }
    return clipped;
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    if (!width || !height) return;
    this.useTexture(this.batchTexture ?? this.atlas.solidTexture);
    const points = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ].map(([px, py]) => transformPoint(this.state.transform, px, py));
    const whiteUV = 0.5 / this.atlas.size;
    this.quad(points, [whiteUV, whiteUV, whiteUV, whiteUV], this.fillStyle);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    const previous = this.paths;
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
    this.paths = previous;
  }
  private strokeContour(points: Point[], closed = false, cap = this.lineCap): void {
    const m = this.state.transform;
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(determinant) < 1e-12) return;
    let triangles: Point[];
    if (m[1] === 0 && m[2] === 0 && m[0] === m[3] && cap !== 'round' && this.lineJoin !== 'round') {
      triangles = strokePathTriangles(
        points,
        this.lineWidth * Math.abs(m[0]),
        closed,
        cap,
        this.lineJoin
      );
    } else {
      const local = points.map(
        ([x, y]): Point => [
          (m[3] * (x - m[4]) - m[2] * (y - m[5])) / determinant,
          (-m[1] * (x - m[4]) + m[0] * (y - m[5])) / determinant,
        ]
      );
      triangles = strokePathTriangles(local, this.lineWidth, closed, cap, this.lineJoin).map(
        ([x, y]) => transformPoint(m, x, y)
      );
    }
    this.useTexture(this.batchTexture ?? this.atlas.solidTexture);
    const shape = this.morphShape(triangles);
    const painted = shape.points;
    if (shape.clip && painted.some((p) => p[1] < shape.clip![0] || p[1] > shape.clip![1])) {
      const uv = 0.5 / this.atlas.size;
      for (let i = 0; i < painted.length; i += 3)
        this.clippedPolygon(
          painted.slice(i, i + 3).map(([x, y]) => [x, y, uv, uv]),
          this.strokeStyle,
          shape.clip
        );
      return;
    }
    for (const point of painted)
      this.vertex(point, 0.5 / this.atlas.size, 0.5 / this.atlas.size, this.strokeStyle);
  }
  stroke(): void {
    const scale = Math.hypot(this.state.transform[0], this.state.transform[1]);
    const dash = this.state.dash.map((v) => v * scale);
    const dashed = dash.length > 0 && dash.some((v) => v > 0);
    for (const path of this.paths) {
      if (!dashed) {
        this.strokeContour(path.points, path.closed);
        continue;
      }
      const dashLength = dash.reduce((sum, value) => sum + value, 0);
      let dashIndex = 0,
        dashUsed = (((this.lineDashOffset * scale) % dashLength) + dashLength) % dashLength;
      while (dashUsed >= dash[dashIndex]) {
        dashUsed -= dash[dashIndex];
        dashIndex = (dashIndex + 1) % dash.length;
      }
      const count = path.closed ? path.points.length : path.points.length - 1;
      for (let i = 0; i < count; i += 1) {
        const a = path.points[i],
          b = path.points[(i + 1) % path.points.length];
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = Math.hypot(dx, dy);
        let distance = 0;
        while (distance < length) {
          const step = Math.min(length - distance, dash[dashIndex] - dashUsed);
          if (step > 0 && dashIndex % 2 === 0)
            this.strokeContour([
              [a[0] + (dx * distance) / length, a[1] + (dy * distance) / length],
              [a[0] + (dx * (distance + step)) / length, a[1] + (dy * (distance + step)) / length],
            ]);
          distance += Math.max(0, step);
          dashUsed += Math.max(0, step);
          if (dashUsed >= dash[dashIndex]) {
            dashIndex = (dashIndex + 1) % dash.length;
            dashUsed = 0;
          }
        }
      }
    }
  }
  clip(): void {
    for (const path of this.paths) this.state.clips.push([...path.points]);
    this.rebuildClips();
  }
  private rebuildClips(): void {
    this.flush();
    const gl = this.gl;
    gl.disable(gl.STENCIL_TEST);

    if (!this.state.clips.length) return;
    gl.stencilMask(0xff);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    for (let i = 0; i < this.state.clips.length; i += 1) {
      gl.stencilFunc(gl.EQUAL, i, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
      this.polygon(this.state.clips[i], '#ffffff');
      this.flush();
    }
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilFunc(gl.EQUAL, this.state.clips.length, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.flush();
    const a = transformPoint(this.state.transform, x, y),
      b = transformPoint(this.state.transform, x + w, y + h);
    const gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.floor(Math.min(a[0], b[0])),
      this.canvas.height - Math.ceil(Math.max(a[1], b[1])),
      Math.ceil(Math.abs(b[0] - a[0])),
      Math.ceil(Math.abs(b[1] - a[1]))
    );
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return new WebGLLinearGradient(
      transformPoint(this.state.transform, x0, y0),
      transformPoint(this.state.transform, x1, y1)
    );
  }
  measureText(text: string): TextMetrics {
    return this.atlas.measure(text, this.font);
  }
  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.textQuads(text, x, y, maxWidth, false, (texture, points, uv, anchorY, layer) => {
      this.useTexture(texture);
      this.quad(points, uv, this.fillStyle, anchorY, layer);
    });
  }

  prepareRepeatedText(text: string, y: number, maxWidth?: number): ((x: number) => void) | null {
    if (this.state.transform[1] !== 0) return null;
    const tiles: ((x: number) => void)[] = [];
    const font = this.font,
      baseline = this.textBaseline,
      offsetScaleX = this.state.transform[0];
    const dpr = Math.max(1, Math.hypot(this.state.transform[0], this.state.transform[1]));
    this.textQuads(text, 0, y, maxWidth, true, (texture, points, uv, anchorY, layer, tile) => {
      const triangles = this.quadVertices(points, uv, anchorY);
      let paint = this.prepareTriangles(triangles, texture, 'fill', layer, offsetScaleX, true);
      let generation = this.atlas.generation,
        u = uv[0],
        v = uv[1];
      tiles.push((x) => {
        if (generation !== this.atlas.generation) {
          const run = this.atlas.get(text, font, dpr, baseline, tile);
          const nextU = run.x / this.atlas.size,
            nextV = run.y / this.atlas.size;
          const seen = new Set<MorphVertex>();
          for (const point of triangles) {
            if (seen.has(point)) continue;
            seen.add(point);
            point[2] += nextU - u;
            point[3] += nextV - v;
          }
          u = nextU;
          v = nextV;
          paint = this.prepareTriangles(
            triangles,
            run.texture,
            'fill',
            run.layer,
            offsetScaleX,
            true
          );
          generation = this.atlas.generation;
        }
        paint(x);
      });
    });
    if (tiles.length === 1) return tiles[0];
    return (x) => {
      for (const paint of tiles) paint(x);
    };
  }

  private textQuads(
    text: string,
    x: number,
    y: number,
    maxWidth: number | undefined,
    repeated: boolean,
    emit: (
      texture: WebGLTexture,
      points: Point[],
      uv: [number, number, number, number],
      anchorY: number,
      layer: number,
      tile: number
    ) => void
  ): void {
    if (!text || (maxWidth !== undefined && maxWidth <= 0)) return;
    const dpr = Math.max(1, Math.hypot(this.state.transform[0], this.state.transform[1]));
    const resident = this.atlas.peekResidentText?.(text, this.font, dpr, this.textBaseline);
    const metrics = resident?.metrics ?? this.atlas.measure(text, this.font, this.textBaseline);
    const sx = maxWidth !== undefined ? Math.min(1, maxWidth / metrics.width) : 1;
    if (this.textAlign === 'center') x -= (metrics.width * sx) / 2;
    else if (this.textAlign === 'right' || this.textAlign === 'end') x -= metrics.width * sx;
    const pen = transformPoint(this.state.transform, x, y);

    const tiles = Math.max(
      1,
      Math.ceil(
        ((Math.ceil(metrics.actualBoundingBoxLeft || 0) +
          (metrics.actualBoundingBoxRight || metrics.width)) *
          dpr) /
          TEXT_TILE_WIDTH
      )
    );
    for (let tile = 0; tile < tiles; tile++) {
      const tileLeft =
        x + (-Math.ceil(metrics.actualBoundingBoxLeft || 0) + (tile * TEXT_TILE_WIDTH) / dpr) * sx;
      const tileRight = tileLeft + (TEXT_TILE_WIDTH / dpr) * sx;
      const tileTop = y - Math.ceil(metrics.actualBoundingBoxAscent) - 2 / dpr;
      const tileBottom = y + Math.ceil(metrics.actualBoundingBoxDescent) + 2 / dpr;
      const bounds = this.morphShape(
        [
          transformPoint(this.state.transform, tileLeft, tileTop),
          transformPoint(this.state.transform, tileRight, tileTop),
          transformPoint(this.state.transform, tileRight, tileBottom),
          transformPoint(this.state.transform, tileLeft, tileBottom),
        ],
        pen[1]
      ).points;
      if (
        (!repeated && bounds.every((p) => p[0] < 0)) ||
        (!repeated && bounds.every((p) => p[0] > this.canvas.width)) ||
        bounds.every((p) => p[1] < 0) ||
        bounds.every((p) => p[1] > this.canvas.height)
      )
        continue;
      const run =
        tile === 0 && resident
          ? resident.run
          : this.atlas.get(text, this.font, dpr, this.textBaseline, tile);
      const left = x + run.left * sx,
        top = y + run.top;
      const width = (run.width / dpr) * sx,
        height = run.height / dpr;
      const points = [
        transformPoint(this.state.transform, left, top),
        transformPoint(this.state.transform, left + width, top),
        transformPoint(this.state.transform, left + width, top + height),
        transformPoint(this.state.transform, left, top + height),
      ];
      emit(
        run.texture,
        points,
        [
          run.x / this.atlas.size,
          run.y / this.atlas.size,
          (run.x + run.width) / this.atlas.size,
          (run.y + run.height) / this.atlas.size,
        ],
        pen[1],
        run.layer,
        tile
      );
    }
  }

  private releaseResources(): void {
    this.retainedBatches?.dispose();
    this.atlas?.destroy();
    this.sceneReady = false;
    this.backgroundReady = false;
    if (this.sceneTexture) this.gl.deleteTexture(this.sceneTexture);
    if (this.backgroundTexture) this.gl.deleteTexture(this.backgroundTexture);
    if (this.sceneFramebuffer) this.gl.deleteFramebuffer(this.sceneFramebuffer);
    if (this.sceneStencil) this.gl.deleteRenderbuffer(this.sceneStencil);
    if (this.rowShiftTexture) this.gl.deleteTexture(this.rowShiftTexture);
    if (this.presentProgram) this.gl.deleteProgram(this.presentProgram);
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.vao) this.gl.deleteVertexArray(this.vao);
    if (this.program) this.gl.deleteProgram(this.program);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vertexCount = 0;
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.canvas.removeEventListener('webglcontextrestored', this.restored);
    this.fontSet?.removeEventListener('loadingdone', this.fontsChanged);
    this.releaseResources();
    this.colors.clear();
    this.stack.length = 0;
    this.paths.length = 0;
    this.onRestore = undefined;
    this.onStatus = undefined;
    this.setStatus('released');
  }
}

const contexts = new WeakMap<Surface, WebGLDrawingContext>();

export function getSequenceWebGLContext(
  canvas: Surface,
  options: { alpha?: boolean } = {}
): WebGLDrawingContext | null {
  let context = contexts.get(canvas);
  if (!context) {
    try {
      context = new WebGLDrawingContext(canvas, options);
      contexts.set(canvas, context);
    } catch (error) {
      if ('dataset' in canvas) {
        canvas.dataset.renderStatus = 'error';
        canvas.dispatchEvent(
          new CustomEvent('sequence-render-error', {
            bubbles: true,
            detail: error instanceof Error ? error.message : String(error),
          })
        );
      }
      return null;
    }
  }
  return context;
}

export function releaseSequenceWebGLContext(canvas: Surface): void {
  contexts.get(canvas)?.dispose();
  contexts.delete(canvas);
}
