/** Shared GLSL: hashing/noise (deterministic, seeded), surface struct and lighting helpers. */

export const NOISE_GLSL = /* glsl */ `
// portable smoothstep: GLSL leaves smoothstep undefined when edge0 >= edge1 (Apple/Metal returns garbage);
// this form is well defined for reversed edges too
float sstep(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec2 sstep(float a, float b, vec2 x){ vec2 t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec3 sstep(float a, float b, vec3 x){ vec3 t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise1(float x){ float i = floor(x), f = fract(x); float u = f*f*(3.0-2.0*f); return mix(hash11(i), hash11(i+1.0), u); }
float vnoise2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  float a = hash12(i), b = hash12(i+vec2(1,0)), c = hash12(i+vec2(0,1)), d = hash12(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
float fbm2(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<4;i++){ s += a*vnoise2(p); p = p*2.03 + 17.1; a *= 0.5; } return s/0.9375; }
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
`;

export const SURFACE_GLSL = /* glsl */ `
struct Surface {
  float t;        // residue parameter along the chain (global residue index units)
  float around;   // 0..1 around the cross-section
  float across;   // -1..1 across the ribbon width
  float ss;       // 0 coil, 1 helix, 2 strand, 3 decoration (e.g. drip)
  float chain;
  float res;
  float faceY;    // +1 top (outer face of helices), -1 bottom
  float arrow;    // 1 on strand arrow heads
  float facet;    // facet id (faceted meshes) else 0
  vec4 phys;      // (arc length Å, across Å, thickness Å, perimeter Å)
  vec2 run;       // art mode: (0..1 along this helix / strand / loop, piece id + 1); y = 0 when there is no piece information
  vec3 n;         // view-space normal
  vec3 v;         // view vector (to eye)
  vec3 tangent;   // view-space chain tangent
  vec3 bin;       // view-space across direction
  float seed;
  vec3 on;        // object-space normal (moves with the protein)
  vec3 objKey;    // key light fixed to the protein (= view key light at the default camera)
  vec2 canvas;    // protein-anchored 2D canvas coordinate (Å) on the principal plane
  vec4 face;      // face anchor of this helix/strand: (centre arc Å, side x radius Å (0 = none), up code, kind + random: 0 loop, 1.x helix, 2.x strand); constant per triangle
};
uniform vec3 uKey;   // key light direction in view space (default (-0.42, 0.62, 0.66); the user may turn it)
uniform vec3 uSun;   // key light colour, linear rgb (white = no tint)
#define KEY uKey
float lambert(vec3 n){ return max(dot(n, normalize(KEY)), 0.0); }
float halfLambert(vec3 n){ return dot(n, normalize(KEY)) * 0.5 + 0.5; }
float blinn(vec3 n, vec3 v, float p){ return pow(max(dot(n, normalize(normalize(KEY) + v)), 0.0), p); }
`;
