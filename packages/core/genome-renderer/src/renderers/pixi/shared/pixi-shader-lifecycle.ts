import type { Shader } from 'pixi.js';

export function destroyLayerShader(shader: Shader): void {
  shader.destroy(false);
}
