const lightBrightness = 0.82;
const lightSaturation = 2;
const darkBrightness = 1.18;

export const READ_HOVER_FILTERS = {
  light: `brightness(${lightBrightness}) saturate(${lightSaturation})`,
  dark: `brightness(${darkBrightness})`,
} as const;
export const READ_SELECTION_FILTERS = {
  light: READ_HOVER_FILTERS.light,
  dark: 'brightness(1.1)',
} as const;

type Theme = keyof typeof READ_HOVER_FILTERS;
type Rect = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;
type BackingSize = Pick<HTMLCanvasElement, 'width' | 'height'>;

export interface ReadHoverSurface {
  readonly canvas: HTMLCanvasElement;
  paint(source: HTMLCanvasElement, rect: Rect, theme: Theme, cornerRadius: number): boolean;
  dispose(): void;
}

const vertex = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform sampler2D brightness;
uniform vec4 shape;
uniform vec2 clipSize;
uniform float cropHeight;
uniform float radius;
uniform bool dark;
out vec4 pixel;

float brighten(float channel) {
  return texelFetch(brightness, ivec2(round(255.0 * channel), 0), 0).r;
}

void main() {
  vec2 position = vec2(gl_FragCoord.x, cropHeight - gl_FragCoord.y);
  if (any(lessThan(position, shape.xy)) || any(greaterThanEqual(position, shape.xy + clipSize))) {
    pixel = vec4(0.0);
    return;
  }
  vec3 original = texelFetch(source, ivec2(position), 0).rgb;
  vec3 tinted;
  if (dark) {
    tinted = vec3(brighten(original.r), brighten(original.g), brighten(original.b));
  } else {
    float gray = dot(original, vec3(0.213, 0.715, 0.072));
    tinted = roundEven(255.0 * clamp(${lightBrightness} * (${lightSaturation.toFixed(1)} * original + ${(1 - lightSaturation).toFixed(1)} * gray), 0.0, 1.0)) / 255.0;
  }
  vec2 nearest = max(vec2(0), max(shape.xy + radius - position,
                                  position - (shape.xy + shape.zw - radius)));
  float spread = radius + 0.5;
  float coverage = clamp(spread * (1.0 - length(nearest * (1.0 / spread))), 0.0, 1.0);
  pixel = vec4(tinted * coverage, coverage);
}`;

function attachShader(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  type: GLenum,
  source: string
) {
  const shader = gl.createShader(type);
  if (!shader) return;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  gl.attachShader(program, shader);
  gl.deleteShader(shader);
}

function nearestTexture(gl: WebGL2RenderingContext, slot: number) {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.activeTexture(gl.TEXTURE0 + slot);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function commonGridStep(outputPixels: number, layoutPixels: number) {
  let a = outputPixels;
  let b = layoutPixels;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return outputPixels / a;
}

export function readHoverLayoutScale(
  bounds: Rect,
  css: ResizeObserverSize,
  pixels: ResizeObserverSize,
  deviceScale: number
): number {
  if (css.inlineSize <= 0 || css.blockSize <= 0) return 0;
  const snap = (position: number) => Math.round(position * deviceScale);
  if (
    deviceScale > 0 &&
    css.inlineSize === bounds.width &&
    css.blockSize === bounds.height &&
    snap(bounds.left + bounds.width) - snap(bounds.left) === pixels.inlineSize &&
    snap(bounds.top + bounds.height) - snap(bounds.top) === pixels.blockSize
  )
    return deviceScale;

  const scale = pixels.inlineSize / css.inlineSize;
  return Number.isFinite(scale) && scale === pixels.blockSize / css.blockSize ? scale : 0;
}

export function readHoverCrop(
  backing: BackingSize,
  bounds: Rect,
  rect: Rect,
  layoutScale: number,
  outputScale = backing.width / bounds.width
) {
  if (
    ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    backing.width <= 0 ||
    backing.height <= 0 ||
    !(layoutScale > 0)
  )
    return null;
  const snap = (css: number) => Math.round(css * layoutScale);
  const originX = snap(bounds.left);
  const originY = snap(bounds.top);
  const layoutWidth = snap(bounds.left + bounds.width) - originX;
  const layoutHeight = snap(bounds.top + bounds.height) - originY;
  if (
    ![layoutWidth, layoutHeight].every(Number.isSafeInteger) ||
    layoutWidth <= 0 ||
    layoutHeight <= 0
  )
    return null;
  const nativeGrid = outputScale === layoutScale;
  const scale = nativeGrid ? outputScale : backing.width / bounds.width;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (nativeGrid) {
    if (Math.abs(layoutWidth - backing.width) > 1 || Math.abs(layoutHeight - backing.height) > 1)
      return null;
  } else if (
    scale !== backing.height / bounds.height ||
    ![
      bounds.width * layoutScale,
      bounds.height * layoutScale,
      bounds.left * layoutScale,
      bounds.top * layoutScale,
      bounds.left * scale,
      bounds.top * scale,
    ].every(Number.isSafeInteger)
  ) {
    return null;
  }
  const presentedWidth = nativeGrid ? layoutWidth : backing.width;
  const presentedHeight = nativeGrid ? layoutHeight : backing.height;
  const xStep = commonGridStep(presentedWidth, layoutWidth);
  const yStep = commonGridStep(presentedHeight, layoutHeight);
  const toOutput = (css: number) => (snap(css) / layoutScale) * scale;
  const readX = (local: number) =>
    nativeGrid ? snap(bounds.left + local) - originX : toOutput(local);
  const readY = (local: number) =>
    nativeGrid ? snap(bounds.top + local) - originY : toOutput(local);
  const x = Math.floor(readX(rect.left));
  const y = Math.floor(readY(rect.top));
  const w = toOutput(rect.width);
  const h = toOutput(rect.height);
  const clipW = Math.ceil(readX(rect.left + rect.width)) - x;
  const clipH = Math.ceil(readY(rect.top + rect.height)) - y;
  if (w <= 0 || h <= 0 || clipW <= 0 || clipH <= 0) return null;
  const left = Math.max(0, Math.floor(x / xStep) * xStep);
  const top = Math.max(0, Math.floor(y / yStep) * yStep);
  const width = Math.min(presentedWidth, Math.ceil((x + w) / xStep) * xStep) - left;
  const height = Math.min(presentedHeight, Math.ceil((y + h) / yStep) * yStep) - top;
  if (width <= 0 || height <= 0) return null;
  if ((xStep === presentedWidth && w < xStep) || (yStep === presentedHeight && h < yStep))
    return null;
  return {
    x: x - left,
    y: y - top,
    w,
    h,
    clipW,
    clipH,
    left,
    top,
    width,
    height,
    scale,
    presentedWidth,
    presentedHeight,
  };
}

export function createReadHoverSurface({
  document,
  colorSpace,
  layoutScale,
  onContextLost,
}: {
  document: Document;
  colorSpace: PredefinedColorSpace;
  layoutScale: number;
  onContextLost?: () => void;
}): ReadHoverSurface | null {
  if (
    !['srgb', 'display-p3'].includes(colorSpace) ||
    !Number.isFinite(layoutScale) ||
    layoutScale <= 0
  )
    return null;
  const input = document.createElement('canvas');
  const scratch = input.getContext('2d', { colorSpace, alpha: false });
  if (!scratch || scratch.getContextAttributes().colorSpace !== colorSpace) return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const loseContext = gl.getExtension('WEBGL_lose_context');
  function release() {
    loseContext?.loseContext();
  }
  gl.drawingBufferColorSpace = colorSpace;
  gl.unpackColorSpace = colorSpace;
  if (gl.drawingBufferColorSpace !== colorSpace || gl.unpackColorSpace !== colorSpace) {
    release();
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    release();
    return null;
  }
  attachShader(gl, program, gl.VERTEX_SHADER, vertex);
  attachShader(gl, program, gl.FRAGMENT_SHADER, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    release();
    return null;
  }
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const shape = uniform('shape');
  const radius = uniform('radius');
  const clipSize = uniform('clipSize');
  const cropHeight = uniform('cropHeight');
  const dark = uniform('dark');
  gl.useProgram(program);
  gl.uniform1i(uniform('source'), 0);
  gl.uniform1i(uniform('brightness'), 1);
  const sourceTexture = nearestTexture(gl, 0);
  const brightnessTexture = nearestTexture(gl, 1);
  if (!sourceTexture || !brightnessTexture) {
    gl.deleteTexture(sourceTexture);
    gl.deleteTexture(brightnessTexture);
    gl.deleteProgram(program);
    release();
    return null;
  }
  const f = Math.fround;
  const brightness = Uint8Array.from({ length: 256 }, (_, byte) =>
    Math.min(255, Math.round(255 * f(f(byte / 255) * f(darkBrightness))))
  );
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, brightness);
  gl.activeTexture(gl.TEXTURE0);
  const textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', borderRadius: '0' });
  let disposed = false;
  let allocatedWidth = 0;
  let allocatedHeight = 0;
  function hide(): false {
    canvas.style.visibility = 'hidden';
    return false;
  }
  function lost() {
    hide();
    onContextLost?.();
  }
  canvas.addEventListener('webglcontextlost', lost);
  return {
    canvas,
    paint(source, rect, theme, cornerRadius) {
      if (disposed || gl.isContextLost()) return hide();
      const crop = readHoverCrop(
        source,
        source.getBoundingClientRect(),
        rect,
        layoutScale,
        source.ownerDocument.defaultView?.devicePixelRatio
      );
      if (!crop || crop.width > textureLimit || crop.height > textureLimit) return hide();
      const { width, height, left, top, scale } = crop;
      if (allocatedWidth !== width || allocatedHeight !== height) {
        canvas.width = input.width = width;
        canvas.height = input.height = height;
        gl.viewport(0, 0, width, height);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          width,
          height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null
        );
        allocatedWidth = width;
        allocatedHeight = height;
      }
      if (source.width === crop.presentedWidth && source.height === crop.presentedHeight) {
        scratch.drawImage(source, left, top, width, height, 0, 0, width, height);
      } else {
        scratch.drawImage(source, -left, -top, crop.presentedWidth, crop.presentedHeight);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, input);
      gl.uniform4f(shape, crop.x, crop.y, crop.w, crop.h);
      gl.uniform2f(clipSize, crop.clipW, crop.clipH);
      gl.uniform1f(radius, Math.min(cornerRadius * scale, crop.w / 2, crop.h / 2));
      gl.uniform1f(cropHeight, height);
      gl.uniform1i(dark, theme === 'dark' ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      Object.assign(canvas.style, {
        visibility: 'visible',
        left: left / scale + 'px',
        top: top / scale + 'px',
        width: width / scale + 'px',
        height: height / scale + 'px',
      });
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', lost);
      gl.deleteTexture(brightnessTexture);
      gl.deleteTexture(sourceTexture);
      gl.deleteProgram(program);
      release();
      canvas.remove();
    },
  };
}
