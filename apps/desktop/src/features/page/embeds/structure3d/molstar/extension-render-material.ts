import { mesh_vert } from 'molstar/lib/mol-gl/shader/mesh.vert';
import { mesh_frag } from 'molstar/lib/mol-gl/shader/mesh.frag';
import { MeshShaderCode, ShaderCode } from 'molstar/lib/mol-gl/shader-code';
import { AttributeSpec, UniformSpec } from 'molstar/lib/mol-gl/renderable/schema';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { ValueCell } from 'molstar/lib/mol-util';

export interface RibbonMaterial {
  surf: Float32Array;
  info: Float32Array;
  phys: Float32Array;
  tangents: Float32Array;
  helpersGLSL: string;
  shaderGLSL: string;
}

const colorVariant = '#if defined(dRenderVariant_color) || defined(dRenderVariant_tracing)';
const varyings = `
varying vec4 vRibbonSurf;
varying vec4 vRibbonInfo;
varying vec4 vRibbonPhys;
varying vec3 vRibbonTangent;
`;

export function extensionRibbonMaterial(data: RibbonMaterial) {
  const vertex = mesh_vert
    .replace(
      'void main(){',
      `${colorVariant}
attribute vec4 aRibbonSurf;
attribute vec4 aRibbonInfo;
attribute vec4 aRibbonPhys;
attribute vec3 aRibbonTangent;
${varyings}
#endif
void main(){`
    )
    .replace(
      'vNormal = transformedNormal;',
      `vNormal = transformedNormal;
${colorVariant}
  vRibbonSurf = aRibbonSurf;
  vRibbonInfo = aRibbonInfo;
  vRibbonPhys = aRibbonPhys;
  vRibbonTangent = normalize(normalMatrix * aRibbonTangent);
#endif`
    );
  const fragment = mesh_frag
    .replace(
      'void main() {',
      `${colorVariant}
${varyings}
${data.helpersGLSL}
${data.shaderGLSL}
vec3 ribbonColor() {
  Surface s;
  s.t = vRibbonSurf.x; s.around = vRibbonSurf.y; s.across = vRibbonSurf.z; s.ss = floor(vRibbonSurf.w + 0.5);
  s.chain = vRibbonInfo.x; s.res = vRibbonInfo.y; s.faceY = vRibbonInfo.z; s.arrow = vRibbonInfo.w;
  s.phys = vRibbonPhys; s.facet = 0.0; s.face = vec4(0.0); s.run = vec2(0.0); s.seed = 7.0;
  s.n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0); s.v = normalize(-vViewPosition);
  vec3 t = vRibbonTangent - s.n * dot(vRibbonTangent, s.n);
  s.tangent = length(t) > 1e-5 ? normalize(t) : vec3(1.0,0.0,0.0);
  s.bin = normalize(cross(s.n,s.tangent)); s.on = s.n; s.objKey = normalize(uKey); s.canvas = vModelPosition.xy;
  return pow(clamp(shadeSurface(s),0.0,1.0),vec3(1.0/2.2));
}
#endif
void main() {`
    )
    .replace('#include apply_light_color', 'gl_FragColor = vec4(ribbonColor(), material.a);');
  return {
    shaderCode: ShaderCode(
      'extension-ribbon',
      vertex,
      fragment,
      MeshShaderCode.extensions,
      MeshShaderCode.outTypes,
      MeshShaderCode.ignoreDefine
    ),
    schema: {
      aRibbonSurf: AttributeSpec('float32', 4, 0),
      aRibbonInfo: AttributeSpec('float32', 4, 0),
      aRibbonPhys: AttributeSpec('float32', 4, 0),
      aRibbonTangent: AttributeSpec('float32', 3, 0),
      uKey: UniformSpec('v3', 'material'),
      uSun: UniformSpec('v3', 'material'),
    },
    values: {
      aRibbonSurf: ValueCell.create(data.surf),
      aRibbonInfo: ValueCell.create(data.info),
      aRibbonPhys: ValueCell.create(data.phys),
      aRibbonTangent: ValueCell.create(data.tangents),
      uKey: ValueCell.create(Vec3.create(-0.42, 0.62, 0.66)),
      uSun: ValueCell.create(Vec3.create(1, 1, 1)),
    },
  };
}
