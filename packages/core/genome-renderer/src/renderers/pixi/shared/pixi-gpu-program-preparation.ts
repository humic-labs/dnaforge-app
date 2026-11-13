import { Shader, type GlProgram } from 'pixi.js';

import { destroyLayerShader } from './pixi-shader-lifecycle';

export interface PixiGpuProgramPreparationRenderer {
  readonly shader: {
    bind(shader: Shader, skipSync?: boolean): void;
    resetState(): void;
  };
}

export function prepareSharedPixiGpuPrograms(
  renderer: PixiGpuProgramPreparationRenderer,
  programs: readonly GlProgram[]
): void {
  const shaders = programs.map((glProgram) => new Shader({ glProgram, resources: {} }));
  try {
    for (const shader of shaders) renderer.shader.bind(shader, true);
  } finally {
    renderer.shader.resetState();
    for (const shader of shaders) destroyLayerShader(shader);
  }
}
