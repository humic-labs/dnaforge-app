import { ArtStyle, baseInk } from '../types';

/**
 * Gustav Klimt — gilded ornament.
 * Material: polished gold leaf (studio-style reflection bands, saturated mid-gold, white
 * highlights, deep bronze in the folds), black/cream enamel tiles, dark-green enamel strands.
 * Ornament is laid out in physical ribbon coordinates (arc length × width, Å) so it follows the
 * local tangent and stays fixed through rotation:
 *   helices — engraved spiral filigree over all the gold, with panels of eye roundels and
 *             Klimt rectangle mosaics that fill the ribbon width, dotted bevel edges;
 *   strands — green enamel with dense gold spiral scrollwork, white rosettes and occasional
 *             gold/cream/black mosaic panels, gold rims;
 *   loops   — flat gold bands with black-and-white mosaic runs.
 */
export const klimtStyle: ArtStyle = {
  id: 'klimt',
  label: 'Klimt',
  technique: 'Hammered gold leaf with crackle seams; crimson, cobalt, black and cream jewel mosaics; dark and crimson helix panels with big gold spirals and ringed roundels; green strands densely covered in gold vines, spirals, leaves and white flowers; loops set with rows of jewel squares.',
  mesh: 'smooth',
  ribbon: {
    helixWidth: 3.1,
    helixThickness: 0.3,
    strandWidth: 2.7,
    strandThickness: 0.3,
    arrowWidth: 4.1,
    coilWidth: 1.15,
    coilThickness: 0.3,
    coilFlatness: 8,
    flatness: 10,
  },
  art: {
    note: 'ornament over anatomy: helices are tall flat gold rectangles laid towards the viewer, like the robes and panels in his portraits; strands are straight flowered bands; every loop winds into a spiral, as in the Tree of Life.',
    stretch: 1.18,
    fit: 0.3,
    ribbon: { smooth: { helix: 8, strand: 6, coil: 4 }, face: 'all', path: 'polyline', blockEnds: true, curl: { radius: 3.6, turns: 1.5 }, helixWidth: 8.0, strandWidth: 4.2, coilWidth: 0.9 },
  },
  surfaceGLSL: /* glsl */ `
// hammered gold leaf: irregular leaf cells (voronoi) with dark seams and per-cell tone
vec3 leafCell(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + hash22(i + o) * 0.85 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = i + o; } else if (d < d2) d2 = d;
  }
  return vec3(hash12(id), sqrt(d2) - sqrt(d1), 0.0);   // (cell tone, distance to seam)
}
vec3 gold(Surface s, float tint){
  float lam = lambert(s.n);
  vec3 r = reflect(-s.v, s.n);
  float env = 0.5 + 0.5 * r.y;
  vec3 deep = lin(vec3(0.68, 0.45, 0.08)), mid = lin(vec3(0.85, 0.60, 0.12)), hi = lin(vec3(0.98, 0.80, 0.34));   // orange gold
  vec3 g = mix(deep, mid, sstep(0.0, 0.45, lam * 0.7 + env * 0.3));
  g = mix(g, hi, sstep(0.55, 0.9, lam * 0.6 + env * 0.4));
  vec3 lc = leafCell(s.phys.xy * vec2(2.4, 2.8));
  g *= 0.86 + 0.26 * lc.x;                                         // each leaf fragment its own tone
  g = mix(g, deep * 0.75, (1.0 - sstep(0.02, 0.09, lc.y)) * 0.6);   // stronger crackle seams   // crackle seams
  g += lin(vec3(1.0, 0.95, 0.75)) * blinn(s.n, s.v, 60.0) * 0.25;
  return g * tint;
}
vec3 enamel(Surface s, vec3 base){
  return lin(base) * (0.6 + 0.5 * lambert(s.n)) + vec3(0.5) * blinn(s.n, s.v, 90.0) * 0.25;
}
float spiral(vec2 q, float turns){
  float r = length(q), a = atan(q.y, q.x) / 6.2831853;
  return abs(fract(r * turns - a) - 0.5);
}
vec3 jewel(float k){
  return k < 0.22 ? vec3(0.58, 0.10, 0.10) : (k < 0.4 ? vec3(0.12, 0.20, 0.52) : (k < 0.58 ? vec3(0.05, 0.04, 0.03) : (k < 0.8 ? vec3(0.95, 0.91, 0.80) : (k < 0.9 ? vec3(0.12, 0.38, 0.24) : vec3(-1.0)))));
}
// rectangle mosaic of jewel tiles set into gold
vec3 mosaic(Surface s, vec2 p, vec2 cell, float seed){
  vec2 g = p / cell, gi = floor(g), f = fract(g);
  float k = hash12(gi + seed);
  float inside = step(0.1, f.x) * step(f.x, 0.9) * step(0.12, f.y) * step(f.y, 0.88);
  vec3 t = jewel(k);
  if (inside < 0.5 || t.x < 0.0) return gold(s, 1.0);
  return enamel(s, t);
}
vec3 shadeSurface(Surface s){
  float X = s.phys.x, Y = s.phys.y;
  float rim = abs(s.across);
  if (abs(s.faceY) < 0.45) return gold(s, 0.6);                       // gilded edges
  vec3 c;
  if (s.ss > 1.5) {
    // --- strands: green enamel with gold vines, leaves, white flowers, gold dots; some gold mosaic stripes ---
    c = enamel(s, vec3(0.10, 0.33, 0.22));
    float block = hash11(floor(X / 6.0) * 3.7 + s.seed + s.chain * 5.0);
    if (block > 0.82 && s.arrow < 0.5) {
      c = mosaic(s, vec2(X, Y + 3.0), vec2(0.42, 0.36), 11.0 + s.seed);
    } else {
      // a gold vine snaking along the strand
      float vy = 0.55 * sin(X * 0.9 + s.seed);
      if (abs(Y - vy) < 0.07) c = gold(s, 1.0);
      // spiral tendrils budding off the vine
      float cell = 0.85;
      float side = Y > vy ? 1.0 : -1.0;   // ornaments bud on both sides of the vine
      float id = floor(X / cell) * 2.0 + (side > 0.0 ? 1.0 : 0.0);
      vec2 q = vec2((fract(X / cell) - 0.5) * cell, Y - vy - side * 0.62);
      float h = hash11(id * 4.1 + s.seed);
      if (h < 0.28) {
        // white five-petal flower with gold heart
        float a = atan(q.y, q.x), r = length(q) / 0.58;
        if (r < 0.62 + 0.38 * cos(5.0 * a)) c = enamel(s, vec3(0.98, 0.96, 0.90));
        if (r < 0.3) c = gold(s, 1.1);
      } else if (h < 0.78) {
        if (spiral(q * (h < 0.53 ? 1.0 : -1.0), 2.6) < 0.14 && length(q) < 0.5) c = gold(s, 1.0);
      } else {
        // leaf: pointed ellipse
        vec2 lq = vec2(q.x * 0.8 + q.y * 0.6, -q.x * 0.6 + q.y * 0.8);
        if ((lq.x * lq.x) / 0.12 + (lq.y * lq.y) / 0.025 < 1.0) c = gold(s, 1.0);
      }
      // scattered gold dots
      vec2 dg = fract(vec2(X, Y) * 1.6) - 0.5;
      if (length(dg) < 0.1 && hash12(floor(vec2(X, Y) * 1.6)) > 0.35) c = gold(s, 1.1);
    }
    if (rim > 0.82) c = gold(s, 1.0);
  } else if (s.ss > 0.5) {
    // --- helices: alternate gold-leaf faces and jewel panels carrying gold spirals or ringed roundels ---
    c = gold(s, 1.0);
    float cell = 3.0;
    float id = floor(X / cell) + (s.faceY > 0.0 ? 0.0 : 101.0);
    vec2 q = vec2((fract(X / cell) - 0.5) * cell, Y);
    float h = hash11(id * 1.71 + s.seed * 2.3 + s.chain * 9.1);
    float r = length(q);
    if (h < 0.22) {
      // dark panel (black-brown, crimson or cobalt) with a big gold spiral filling the ribbon
      float k = hash11(id * 3.3 + 1.0);
      c = enamel(s, k < 0.45 ? vec3(0.13, 0.08, 0.05) : (k < 0.75 ? vec3(0.50, 0.08, 0.08) : vec3(0.11, 0.18, 0.46)));
      if (spiral(q, 2.2) < 0.12 && r < 1.25) c = gold(s, 1.05);
    } else if (h < 0.38) {
      // crimson roundel with gold rings and a blue heart
      if (r < 1.25) c = enamel(s, vec3(0.62, 0.10, 0.10));
      if (abs(r - 0.95) < 0.09 || abs(r - 0.55) < 0.08) c = gold(s, 1.05);
      if (r < 0.45) c = enamel(s, vec3(0.12, 0.23, 0.60));   // ~30% of the roundel
      if (r < 0.1) c = gold(s, 1.1);
    } else if (h < 0.6) {
      // jewel rectangle mosaic
      c = mosaic(s, vec2(X, Y + 3.0), vec2(0.55, 0.48), id + s.seed);
    }
    if (rim > 0.9) c = gold(s, 0.85);
  } else {
    // --- loops: gold ribbons with a centred row of small jewel squares ---
    c = gold(s, 1.0);
    if (rim < 0.55) {
      float g = X / 0.42;
      float k = hash11(floor(g) + s.seed * 3.0);
      vec3 t = jewel(k);
      float f = fract(g);
      float j = (hash11(floor(g) * 2.7 + 5.0) - 0.5) * 0.25;   // hand-set: ±25% size and placement
      if (t.x >= 0.0 && f > 0.12 + j && f < 0.88 - j * 0.5 && abs(s.across) < 0.45 + j && hash11(floor(g) * 1.9) > 0.35) c = enamel(s, t);
    }
  }
  return c;
}`,
  ink: {
    ...baseInk,
    color: [0.16, 0.09, 0.02],
    color2: [0.06, 0.04, 0.02],
    width: 1.15,
    widthVar: 0.1,
    softness: 0.45,
  },
};
