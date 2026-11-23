import { klimtStyle } from './upstream/src/art/klimt/index';
import { NOISE_GLSL, SURFACE_GLSL } from './upstream/src/art/glsl';
import { buildRibbon } from './upstream/src/geometry/ribbon';
import { loadStructure } from './upstream/src/io/load';

type RibbonInput = { text: string; filename: string };

self.onmessage = ({ data }: MessageEvent<RibbonInput>) => {
  try {
    const structure = loadStructure(data.text, data.filename);
    const { positions, normals, tangents, surf, info, phys, indices } = buildRibbon(structure, klimtStyle.ribbon);
    if (!indices.length) throw new Error('MolArt found no connected ribbon to draw.');
    const result = {
      positions, normals, tangents, surf, info, phys, indices,
      residues: structure.residues.map(({ chainId, resSeq, iCode, name }) => ({ chainId, resSeq, iCode, name })),
      shaderGLSL: klimtStyle.surfaceGLSL,
      helpersGLSL: `${NOISE_GLSL}\n${SURFACE_GLSL}`,
    };
    self.postMessage({ ok: true, result }, { transfer: [positions.buffer, normals.buffer, tangents.buffer, surf.buffer, info.buffer, phys.buffer, indices.buffer] });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
