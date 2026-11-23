/**
 * Scientific cartoon geometry built from the immutable Structure.
 *
 * Coordinates are *read* from the Structure and written into new Float32Arrays;
 * nothing in the Structure is modified. Every vertex carries surface-anchored
 * parameters (residue parameter t, across-ribbon coordinate, profile angle) so
 * that artistic marks can be attached to the protein rather than to the screen.
 */
import { NUCLEIC_LINK, type Structure } from '../model/structure';

export interface RibbonOptions {
  /** Spline samples per residue (even number). */
  samplesPerResidue?: number;
  /** Vertices around the cross-section. */
  profileSegments?: number;
  helixWidth?: number;
  helixThickness?: number;
  strandWidth?: number;
  strandThickness?: number;
  arrowWidth?: number;
  coilRadius?: number;
  /** Optional flat "ribbon" loops (art styles): width/thickness in Å. Defaults to a round tube of coilRadius. */
  coilWidth?: number;
  coilThickness?: number;
  coilFlatness?: number;
  /** Rotate the cross-section by half a segment so low-segment profiles are rectangles, not diamonds. */
  cornerProfile?: boolean;
  /**
   * Block ends (display only): helices and strands are constant-section bars that end in a flat cut face where
   * the secondary structure changes, with the loop emerging from the cut. No arrow heads are drawn.
   */
  blockEnds?: boolean;
  /**
   * Local widenings of the ribbon (display only), e.g. the "head" a character style paints a face on:
   * around residue parameter `t` (global residue index units) the width grows by the factor 1 + `widen`,
   * fading out over `span` residues to either side.
   */
  bulges?: {
    t: number;
    span: number;
    /** relative widening at the centre (0 = none) */
    widen?: number;
    /** instead of widening: blend the section towards this absolute width / thickness (Å) and roundness */
    to?: { w: number; h: number; p: number };
    /** hold the full effect over most of the span instead of peaking at the centre */
    flat?: boolean;
  }[];
  /** Superellipse exponent for helix/strand sections (2 = ellipse, large = rectangle). */
  flatness?: number;
  /** The same for helices only (default: `flatness`). */
  helixFlatness?: number;
  /**
   * Art mode (display only): smooth the path the ribbon follows, in passes per secondary-structure type.
   * About 8 passes collapse a helix onto its axis (it becomes one bar or band); fewer passes turn loops
   * and strands into sweeping curves. The drawn shape then no longer follows the true backbone.
   */
  smooth?: { helix?: number; strand?: number; coil?: number };
  /** Art mode: push the path away from its own smoothed course (0 = none): bends get sharper, coils wider, the line more angular. */
  exaggerate?: number;
  /**
   * Art mode: the outline of each helix / strand / loop as a whole shape (display only): 'disc' a circle as wide as the
   * piece is long, 'petal' a lens, 'taper' a triangle running to a point, 'brush' a loaded stroke thinning out,
   * 'scallop' a lobed leaf edge, 'flame' a tapering, flickering tongue.
   */
  outline?: { helix?: Outline; strand?: Outline; coil?: Outline };
  /** Art mode: redraw the path: 'manhattan' only horizontal and vertical runs in the protein's own frame, 'polyline' straight runs with sharp knees. */
  path?: 'manhattan' | 'polyline';
  /** Art mode: loops curl into a ring on their way (radius in Å). */
  curl?: { radius: number; turns?: number };
  /** Art mode: the whole path undulates in the picture plane (amplitude Å, period in residues). */
  wave?: { amp: number; period: number };
  /** The protein's own frame (x, y, view axis), needed by path / curl / wave. */
  frame?: [[number, number, number], [number, number, number], [number, number, number]];
  /** Art mode: lay bands flat towards this direction ('helix': collapsed helices only, 'all': every piece, like cut paper). */
  face?: 'helix' | 'all';
  faceDir?: [number, number, number];
  /** Art mode: with `path`, the straight runs meet in true mitred corners instead of a rounded bend. */
  sharp?: boolean;
  /** Art mode: record for every vertex which piece (helix / strand / loop) it belongs to and how far along it lies. */
  runs?: boolean;
  /** Art mode: leave this much bare paper (Å) between consecutive pieces (where the secondary structure changes). */
  gap?: number;
  /** DNA / RNA backbone band: width and thickness in Å (defaults: 0.8 x the helix width, the helix thickness). */
  nucleicWidth?: number;
  nucleicThickness?: number;
  /** DNA / RNA base slab: width in Å (0 = draw no bases). */
  baseWidth?: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** (t, around 0..1, across -1..1, ssCode 0 coil / 1 helix / 2 strand) */
  surf: Float32Array;
  /** (chainIndex, residueIndex, faceY -1..1 (top/bottom of ribbon), arrowness 0..1) */
  info: Float32Array;
  tangents: Float32Array;
  /** Physical surface coordinates in Å: (arc length along chain, across offset, thickness offset, perimeter coord). */
  phys: Float32Array;
  /** art mode: per vertex (position 0..1 along its helix / strand / loop, piece id + 1); absent or 0 = no piece information */
  run?: Float32Array;
  /** Spline centre of the ring each vertex belongs to (display geometry only). */
  centers: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  /** Per-segment ranges, useful for deformation and diagnostics. */
  segments: { chainIndex: number; first: number; last: number }[];
  gaps: number;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp = (a: V, b: V, f: number): V => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const smooth = (f: number) => f * f * (3 - 2 * f);

export interface Outline { kind: 'disc' | 'petal' | 'taper' | 'brush' | 'scallop' | 'flame'; amount?: number; lobes?: number; max?: number; /** narrowest width in Å (default 0.8 x the loop width) */ min?: number }

const SS_CODE = { C: 0, H: 1, E: 2 } as const;

export const DEFAULT_RIBBON: Required<RibbonOptions> = {
  samplesPerResidue: 8,
  profileSegments: 16,
  helixWidth: 2.3,
  helixThickness: 0.42,
  strandWidth: 2.0,
  strandThickness: 0.5,
  arrowWidth: 3.4,
  coilRadius: 0.32,
  flatness: 6,
  helixFlatness: undefined as unknown as number,
  coilWidth: 0,
  coilThickness: 0,
  coilFlatness: 2,
  cornerProfile: false,
  blockEnds: false,
  bulges: [],
  smooth: {},
  exaggerate: 0,
  outline: {},
  path: undefined as unknown as 'polyline',
  curl: undefined as unknown as { radius: number },
  wave: undefined as unknown as { amp: number; period: number },
  frame: undefined as unknown as [[number, number, number], [number, number, number], [number, number, number]],
  face: 'helix',
  faceDir: [0, 0, 0],
  sharp: false,
  runs: false,
  gap: 0,
  nucleicWidth: 0,
  nucleicThickness: 0,
  baseWidth: 1.7,
};

/** Scale every width-like art option by `f` (used to keep large proteins from crowding). Thickness is left alone. */
export function scaleRibbonWidths(r: RibbonOptions, f: number): RibbonOptions {
  if (f === 1) return r;
  const out: RibbonOptions = { ...r };
  for (const k of ['helixWidth', 'strandWidth', 'arrowWidth'] as const) out[k] = (r[k] ?? DEFAULT_RIBBON[k]) * f;
  if (r.coilWidth) out.coilWidth = r.coilWidth * (0.5 + 0.5 * f);
  if (r.outline) {
    const sc = (o?: Outline) => (o ? { ...o, max: (o.max ?? 14) * f } : o);
    out.outline = { helix: sc(r.outline.helix), strand: sc(r.outline.strand), coil: sc(r.outline.coil) };
  }
  if (r.curl) out.curl = { ...r.curl, radius: r.curl.radius * f };
  if (r.wave) out.wave = { ...r.wave, amp: r.wave.amp * f };
  return out;
}

/** Split chains into continuous backbone segments (break when CA–CA > 4.3 Å; for nucleotides when the trace atoms are > 8.5 Å apart). */
export function backboneSegments(s: Structure): { chainIndex: number; first: number; last: number }[] {
  const out: { chainIndex: number; first: number; last: number }[] = [];
  const c = s.coords;
  for (const ch of s.chains) {
    let first = ch.residueStart;
    for (let i = ch.residueStart; i < ch.residueEnd; i++) {
      const next = i + 1;
      let brk = next >= ch.residueEnd;
      if (!brk) {
        const a = s.residues[i].ca, b = s.residues[next].ca;
        const nuc = s.residues[i].kind === 'nucleic';
        brk = s.residues[next].kind !== s.residues[i].kind || Math.hypot(c[3 * a] - c[3 * b], c[3 * a + 1] - c[3 * b + 1], c[3 * a + 2] - c[3 * b + 2]) > (nuc ? NUCLEIC_LINK : 4.3);
      }
      if (brk) {
        out.push({ chainIndex: ch.index, first, last: i });
        first = next;
      }
    }
  }
  return out;
}

export function buildRibbon(s: Structure, options: RibbonOptions = {}): MeshData {
  const o = { ...DEFAULT_RIBBON, ...options };
  const spr = Math.max(2, Math.round(o.samplesPerResidue / 2) * 2);
  const segs = o.profileSegments;
  const P: number[] = [], Nn: number[] = [], SU: number[] = [], IN: number[] = [], TG: number[] = [], ID: number[] = [], PH: number[] = [], CT: number[] = [], RN: number[] = [];
  let curRun: [number, number] = [0, 0];
  const segments = backboneSegments(s);
  let gaps = 0;
  const atom = (i: number): V => [s.coords[3 * i], s.coords[3 * i + 1], s.coords[3 * i + 2]];

  let curPhys: [number, number, number, number] = [0, 0, 0, 0];
  let curCenter: V = [0, 0, 0];
  const copyFrom = (vi: number) => {
    curPhys = [PH[4 * vi], PH[4 * vi + 1], PH[4 * vi + 2], PH[4 * vi + 3]];
    curRun = [RN[2 * vi], RN[2 * vi + 1]];
    curCenter = [CT[3 * vi], CT[3 * vi + 1], CT[3 * vi + 2]];
  };
  const pushV = (p: V, n: V, su: [number, number, number, number], inf: [number, number, number, number], t: V) => {
    PH.push(...curPhys);
    RN.push(curRun[0], curRun[1]);
    CT.push(curCenter[0], curCenter[1], curCenter[2]);
    P.push(p[0], p[1], p[2]);
    Nn.push(n[0], n[1], n[2]);
    SU.push(...su);
    IN.push(...inf);
    TG.push(t[0], t[1], t[2]);
    return P.length / 3 - 1;
  };

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (si > 0 && segments[si - 1].chainIndex === seg.chainIndex) gaps++;
    const n = seg.last - seg.first + 1;
    const res = s.residues.slice(seg.first, seg.last + 1);
    if (n < 2) continue; // a single isolated residue cannot form a ribbon
    const ss = res.map((r) => r.ss);
    const ca = res.map((r) => atom(r.ca));
    // DNA / RNA: a band through the trace atoms with a slab for every base; drawn true in every mode (no art-mode reshaping)
    const nuc = res[0].kind === 'nucleic';

    // --- control points (strands smoothed to remove the CA pleat, display only) ---
    const ctrl: V[] = ca.map((p, k) => {
      if (ss[k] === 'E' && k > 0 && k < n - 1 && ss[k - 1] === 'E' && ss[k + 1] === 'E') {
        return scale(add(add(ca[k - 1], ca[k + 1]), scale(p, 2)), 0.25);
      }
      return p;
    });

    // art mode: smooth the path (display only; the structure is not touched)
    const sm = nuc ? {} : o.smooth ?? {};
    const lim = ss.map((t) => (t === 'H' ? sm.helix ?? 0 : t === 'E' ? sm.strand ?? 0 : sm.coil ?? 0));
    const passes = Math.max(sm.helix ?? 0, sm.strand ?? 0, sm.coil ?? 0);
    for (let it = 0; it < passes; it++) {
      const prev = ctrl.map((q) => [q[0], q[1], q[2]] as V);
      for (let k = 1; k < n - 1; k++) if (it < lim[k]) ctrl[k] = scale(add(add(prev[k - 1], prev[k + 1]), scale(prev[k], 2)), 0.25);
    }

    if (o.exaggerate > 0 && !nuc) {
      let sm2 = ctrl.map((q) => [q[0], q[1], q[2]] as V);
      for (let it = 0; it < 5; it++) {
        const prev = sm2.map((q) => [q[0], q[1], q[2]] as V);
        for (let k = 1; k < n - 1; k++) sm2[k] = scale(add(add(prev[k - 1], prev[k + 1]), scale(prev[k], 2)), 0.25);
      }
      for (let k = 1; k < n - 1; k++) ctrl[k] = add(ctrl[k], scale(sub(ctrl[k], sm2[k]), o.exaggerate));
    }

    // runs of equal secondary structure (used by the art-mode path and outline options)
    const run0: number[] = new Array(n), run1: number[] = new Array(n);
    for (let k = 0; k < n; ) {
      let e = k;
      while (e + 1 < n && ss[e + 1] === ss[k]) e++;
      for (let j = k; j <= e; j++) { run0[j] = k; run1[j] = e; }
      k = e + 1;
    }
    // segments of the path that are straight by construction (for `sharp`)
    const linSeg: boolean[] = new Array(n).fill(false);
    const fr = o.frame;
    if (fr && !nuc && (o.path || o.curl || o.wave)) {
      const F = ctrl.map((q) => [dot(q, fr[0] as V), dot(q, fr[1] as V), dot(q, fr[2] as V)] as V);
      const mix3 = (a: V, b: V, u: number): V => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      const solid = (k: number) => ss[k] !== 'C' && run1[k] - run0[k] >= 2;
      // 1) helices and strands become straight runs (manhattan: along the frame's x or y only)
      if (o.path) {
        for (let k = 0; k < n; k = run1[k] + 1) {
          if (!solid(k)) continue;
          // a helix that still coils (not collapsed onto its axis) keeps its own path unless everything must be rectilinear
          if (o.path !== 'manhattan' && ss[k] === 'H' && (sm.helix ?? 0) < 4) continue;
          const a = run0[k], b = run1[k], A = [...F[a]] as V, B = [...F[b]] as V;
          if (o.path === 'manhattan') {
            const c: V = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, 0];
            if (Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1])) { A[1] = c[1]; B[1] = c[1]; } else { A[0] = c[0]; B[0] = c[0]; }
          }
          for (let j = a; j <= b; j++) F[j] = mix3(A, B, (j - a) / (b - a));
          for (let j = a; j < b; j++) linSeg[j] = true;
        }
        // 2) loops between them: manhattan = one right-angled turn; polyline = one sharp knee at the loop's far point
        for (let k = 0; k < n; k = run1[k] + 1) {
          if (solid(k)) continue;
          let a = run0[k], b = run1[k];
          while (a > 0 && !solid(a - 1)) a--;
          while (b < n - 1 && !solid(b + 1)) b++;
          k = b;
          const ia = Math.max(0, a - 1), ib = Math.min(n - 1, b + 1);
          if (ib - ia < 2) continue;
          const A = F[ia], B = F[ib];
          let apex = Math.round((ia + ib) / 2), far = -1;
          for (let j = a; j <= b; j++) {
            const u = (j - ia) / (ib - ia), m = mix3(A, B, u);
            const d = Math.hypot(F[j][0] - m[0], F[j][1] - m[1], F[j][2] - m[2]);
            if (d > far) { far = d; apex = j; }
          }
          const P = [...F[apex]] as V;
          const jc = Math.min(ib - 1, Math.max(ia + 1, Math.round((ia + ib) / 2)));   // the corner sits on a control point
          for (let j = ia; j < ib; j++) linSeg[j] = true;
          for (let j = a; j <= b; j++) {
            if (o.path === 'manhattan') {
              const u = (j - ia) / (ib - ia);
              F[j] = j <= jc ? [A[0] + (B[0] - A[0]) * (j - ia) / (jc - ia), A[1], A[2] + (B[2] - A[2]) * u] : [B[0], A[1] + (B[1] - A[1]) * (j - jc) / (ib - jc), A[2] + (B[2] - A[2]) * u];
            } else F[j] = j <= apex ? mix3(A, P, (j - ia) / Math.max(1, apex - ia)) : mix3(P, B, (j - apex) / Math.max(1, ib - apex));
          }
        }
      }
      // 3) loops curl into a ring on their way
      if (o.curl) {
        for (let k = 0; k < n; k = run1[k] + 1) {
          if (ss[k] !== 'C') continue;
          const a = run0[k], b = run1[k], len2 = b - a + 1;
          if (len2 < 5) continue;
          const R = Math.min(o.curl.radius, len2 * 0.45), turns = o.curl.turns ?? 1;
          const sgn = (a * 7 + len2) % 2 === 0 ? 1 : -1;
          for (let j = Math.max(0, a - 1); j <= Math.min(n - 2, b); j++) linSeg[j] = false;
          for (let j = a; j <= b; j++) {
            const u = (j - a + 0.5) / len2, r = R * Math.sin(Math.PI * u), th = sgn * 2 * Math.PI * turns * u;
            F[j] = [F[j][0] + r * Math.cos(th) - r * 0.0, F[j][1] + r * Math.sin(th), F[j][2] + 0.6 * r * (u - 0.5)];
          }
        }
      }
      // 4) the whole path undulates in the picture plane
      if (o.wave) {
        const W = F.map((q, k) => {
          const T = sub(F[Math.min(n - 1, k + 1)], F[Math.max(0, k - 1)]);
          const l = Math.hypot(T[0], T[1]) || 1;
          const w = o.wave.amp * Math.sin((2 * Math.PI * (seg.first + k)) / o.wave.period) * Math.min(1, Math.min(k, n - 1 - k) / 2);
          return [q[0] - (T[1] / l) * w, q[1] + (T[0] / l) * w, q[2]] as V;
        });
        for (let k = 0; k < n; k++) F[k] = W[k];
        linSeg.fill(false);
      }
      for (let k = 0; k < n; k++) ctrl[k] = add(add(scale(fr[0] as V, F[k][0]), scale(fr[1] as V, F[k][1])), scale(fr[2] as V, F[k][2]));
    }
    // length of each run along the drawn path (Å), for outlines that depend on it
    const runLen: number[] = new Array(n).fill(0);
    for (let k = 0; k < n; k = run1[k] + 1) {
      let L = 3.0;
      for (let j = run0[k]; j < run1[k]; j++) L += len(sub(ctrl[j + 1], ctrl[j]));
      for (let j = run0[k]; j <= run1[k]; j++) runLen[j] = L;
    }

    // --- side (width) vectors ---
    const side: V[] = res.map((r, k) => {
      const prev = ca[Math.max(0, k - 1)], next = ca[Math.min(n - 1, k + 1)];
      const T = norm(sub(next, prev));
      let d: V;
      if (!s.caOnly && r.c >= 0 && r.o >= 0) d = sub(atom(r.o), atom(r.c));
      else {
        const a = sub(next, ca[k]), b = sub(ca[k], prev);
        d = cross(b, a);
        if (len(d) < 1e-3) d = cross(T, [0, 0, 1]);
      }
      d = sub(d, scale(T, dot(d, T)));
      if (len(d) < 1e-4) d = cross(T, Math.abs(T[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
      return norm(d);
    });
    // helices: make the ribbon's top face (+normal) point away from the helix axis
    for (let k = 0; k < n; ) {
      if (ss[k] !== 'H') {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < n && ss[e + 1] === 'H') e++;
      let vote = 0;
      for (let j = Math.max(1, k); j <= Math.min(n - 2, e); j++) {
        const inward = sub(scale(add(ca[j - 1], ca[j + 1]), 0.5), ca[j]);
        const T = norm(sub(ca[j + 1], ca[j - 1]));
        vote += dot(cross(T, side[j]), inward) > 0 ? 1 : -1;
      }
      for (let j = k; j <= e; j++) {
        if (j > k && dot(side[j], side[j - 1]) < 0) side[j] = scale(side[j], -1);
        if (vote > 0) side[j] = scale(side[j], -1);
      }
      k = e + 1;
    }
    if (nuc) {
      // the band lies on the surface of the (double) helix: width along the curve's binormal, top face away from the axis
      if (n > 2) { side[0] = side[1]; side[n - 1] = side[n - 2]; }
      for (let k = 1; k < n; k++) if (dot(side[k], side[k - 1]) < 0) side[k] = scale(side[k], -1);
      for (let it = 0; it < 2; it++) {
        const prev = side.map((q) => [q[0], q[1], q[2]] as V);
        for (let k = 1; k < n - 1; k++) side[k] = norm(add(add(prev[k - 1], prev[k + 1]), scale(prev[k], 2)));
      }
      let vote = 0;
      for (let j = 1; j < n - 1; j++) {
        const inward = sub(scale(add(ca[j - 1], ca[j + 1]), 0.5), ca[j]);
        vote += dot(cross(norm(sub(ca[j + 1], ca[j - 1])), side[j]), inward);
      }
      if (vote > 0) for (let k = 0; k < n; k++) side[k] = scale(side[k], -1);
    }
    // continuity for everything else
    for (let k = 1; k < n; k++) if (ss[k] !== 'H' && dot(side[k], side[k - 1]) < 0) side[k] = scale(side[k], -1);
    // strands: average neighbouring sides to suppress alternating peptide flips
    // strands and flat loops: average neighbouring sides to suppress alternating peptide flips
    const flatCoil = o.coilWidth > 0;
    let side2 = side.map((sd, k) =>
      (ss[k] === 'E' || (flatCoil && ss[k] === 'C')) && k > 0 && k < n - 1 ? norm(add(add(side[k - 1], side[k + 1]), scale(sd, 2))) : sd,
    );

    // art mode: bands laid flat towards one direction (a collapsed helix has no meaningful peptide plane)
    const fd = o.faceDir as V;
    if (!nuc && (passes > 0 || o.face === 'all') && len(fd) > 0.5) {
      const flat = side2.map((sd, k) => {
        if (!(o.face === 'all' || (ss[k] === 'H' && (sm.helix ?? 0) >= 4))) return sd;
        const T = norm(sub(ctrl[Math.min(n - 1, k + 1)], ctrl[Math.max(0, k - 1)]));
        const c = cross(fd, T);   // top face towards faceDir
        return len(c) > 0.25 ? norm(c) : sd;
      });
      for (let k = 1; k < n; k++) if (dot(flat[k], flat[k - 1]) < 0) flat[k] = scale(flat[k], -1);
      // ease between laid-flat and free pieces
      side2 = flat.map((sd, k) => (k > 0 && k < n - 1 ? norm(add(add(flat[k - 1], flat[k + 1]), scale(sd, 2))) : sd));
    }

    // --- Catmull-Rom spline ---
    const cp = (k: number) => ctrl[Math.max(0, Math.min(n - 1, k))];
    const ext = (k: number): V => {
      if (k < 0) return sub(scale(ctrl[0], 2), ctrl[1]);
      if (k > n - 1) return sub(scale(ctrl[n - 1], 2), ctrl[n - 2]);
      return cp(k);
    };
    const sharpAt = (k: number) => o.sharp && k >= 0 && k < n - 1 && linSeg[k];
    const spline = (t: number): { p: V; d: V; mit?: { dir: V; m: number } } => {
      const k = Math.min(n - 2, Math.max(0, Math.floor(t)));
      const f = t - k;
      if (sharpAt(k)) {
        const d = sub(ctrl[k + 1], ctrl[k]);
        const p = lerp(ctrl[k], ctrl[k + 1], f);
        if (f < 1e-9 && sharpAt(k - 1)) {
          // a corner: the section lies on the bisector plane and widens into a mitre
          const din = norm(sub(ctrl[k], ctrl[k - 1])), dout = norm(d), bis = add(din, dout), bl = len(bis);
          if (bl > 0.3 && bl < 1.999) return { p, d: bis, mit: { dir: norm(sub(din, dout)), m: Math.min(2.6, 2 / bl) } };
        }
        return { p, d };
      }
      const p0 = ext(k - 1), p1 = ext(k), p2 = ext(k + 1), p3 = ext(k + 2);
      const f2 = f * f, f3 = f2 * f;
      const p: V = [0, 1, 2].map(
        (i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * f + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * f2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * f3),
      ) as V;
      const d: V = [0, 1, 2].map(
        (i) => 0.5 * (-p0[i] + p2[i] + 2 * (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * f + 3 * (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * f2),
      ) as V;
      return { p, d };
    };

    // --- profile along t ---
    const coil = o.coilWidth > 0 ? { w: o.coilWidth, h: o.coilThickness || o.coilWidth * 0.35, p: o.coilFlatness } : { w: o.coilRadius * 2, h: o.coilRadius * 2, p: 2 };
    const band = { w: o.nucleicWidth || o.helixWidth * 0.8, h: o.nucleicThickness || o.helixThickness, p: o.helixFlatness ?? o.flatness };
    const nominal = (k: number) => {
      if (nuc) return band;
      const t = ss[Math.max(0, Math.min(n - 1, k))];
      if (t === 'H') return { w: o.helixWidth, h: o.helixThickness, p: o.helixFlatness ?? o.flatness };
      if (t === 'E') return { w: o.strandWidth, h: o.strandThickness, p: o.flatness };
      return coil;
    };
    const isArrowEnd = (k: number) => !o.blockEnds && !o.outline?.strand && ss[k] === 'E' && (k === n - 1 || ss[k + 1] !== 'E');
    /** blockEnds: a flat cut between residue k and k+1 (at t = k + 0.5) where the secondary structure changes */
    const isCut = (k: number) => o.blockEnds && k >= 0 && k < n - 1 && ss[k] !== ss[k + 1];

    const profile = (t: number, afterStep: boolean) => {
      if (o.blockEnds) {
        const kc = Math.floor(t - 0.5 + 1e-9);   // t in (kc + 0.5, kc + 1.5] belongs to residue kc + 1
        const onCut = Math.abs(t - (kc + 0.5)) < 1e-9;
        return { ...nominal(onCut && !afterStep ? kc : kc + 1), arrow: 0 };
      }
      const k = Math.floor(t + 1e-9);
      const kr = Math.round(t);
      // arrow head occupies [e-0.5, e+0.5] of the last strand residue e
      if (isArrowEnd(kr) && t >= kr - 0.5 - 1e-9 && (t > kr - 0.5 + 1e-9 || afterStep)) {
        const f = Math.min(1, (t - (kr - 0.5)) / 1.0);
        return { w: o.arrowWidth + (coil.w - o.arrowWidth) * f, h: o.strandThickness, p: o.flatness, arrow: 1 };
      }
      // just after an arrow tip, blend from coil-size into the next residue's profile
      if (k >= 0 && isArrowEnd(k) && t > k + 0.5) {
        const nx = nominal(k + 1);
        const f = smooth((t - (k + 0.5)) / 0.5);
        return { w: coil.w + (nx.w - coil.w) * f, h: coil.h + (nx.h - coil.h) * f, p: coil.p + (nx.p - coil.p) * f, arrow: 0 };
      }
      const a = nominal(k), b = nominal(k + 1);
      const f = smooth(t - k);
      return { w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f, p: a.p + (b.p - a.p) * f, arrow: 0 };
    };

    // --- samples (with duplicated sample at each arrow step) ---
    let samples: { t: number; step: boolean; brk?: boolean }[] = [];
    const t0 = 0, t1 = n - 1;
    for (let i = 0; i <= (t1 - t0) * spr; i++) {
      const t = t0 + i / spr;
      samples.push({ t, step: false });
      const kr = Math.round(t);
      if (Math.abs(t - (kr - 0.5)) < 1e-9 && (isArrowEnd(kr) || isCut(kr - 1))) samples.push({ t, step: true });
    }

    if (o.gap > 0) {
      // bare paper between pieces: drop the samples around each change of secondary structure and cap both sides
      let lastCut = -10;
      for (let k = 0; k < n - 1; k++) {
        if (ss[k] === ss[k + 1] || k + 0.5 - lastCut < 1.5) continue;
        lastCut = k + 0.5;
        const g = Math.min(0.45, o.gap / 2 / (len(sub(ctrl[k + 1], ctrl[k])) || 1));
        const lo = k + 0.5 - g, hi = k + 0.5 + g;
        samples = samples.filter((q) => q.t < lo - 1e-6 || q.t > hi + 1e-6);
        samples.push({ t: lo, step: false }, { t: hi, step: false, brk: true });
      }
      samples.sort((a, b) => a.t - b.t);
    }

    const caps: [number, number][] = [];
    let prevRing = -1;
    let prevArea = 0;
    let arc = seg.first * 3.8;
    let prevP: V | null = null;
    let prevT: V | null = null;
    let prevS: V | null = null;
    const ringStarts: number[] = [];
    const arcAt: number[] = new Array(n).fill(arc);
    for (let si2 = 0; si2 < samples.length; si2++) {
      const { t, step, brk } = samples[si2];
      const { p, d, mit } = spline(t);
      let T = norm(d);
      if (len(d) < 1e-6 && prevT) T = prevT;
      const k = Math.min(n - 2, Math.floor(t));
      const f = Math.min(1, Math.max(0, t - k));
      let S = lerp(side2[k], side2[Math.min(n - 1, k + 1)], f);
      S = sub(S, scale(T, dot(S, T)));
      if (len(S) < 1e-4) S = prevS ?? cross(T, [0, 0, 1]);
      S = norm(S);
      if (prevS && dot(S, prevS) < 0) S = scale(S, -1);
      const B = cross(T, S);
      const pr = { ...profile(t, step) };
      {
        const kq = Math.min(n - 1, Math.max(0, Math.round(t)));
        const ol = ss[kq] === 'H' ? o.outline?.helix : ss[kq] === 'E' ? o.outline?.strand : o.outline?.coil;
        if (ol && !nuc && !pr.arrow && run1[kq] - run0[kq] >= 2) {
          const a0 = run0[kq] - 0.5, a1 = run1[kq] + 0.5, u = Math.min(1, Math.max(0, (t - a0) / (a1 - a0)));
          const floor_ = ol.min ?? coil.w * 0.8;
          let fmul = 1;
          if (ol.kind === 'disc') pr.w = Math.max(floor_, Math.min(runLen[kq], ol.max ?? 14) * Math.sqrt(Math.max(0, 1 - (2 * u - 1) * (2 * u - 1))));
          else if (ol.kind === 'petal') fmul = 0.1 + 0.9 * Math.pow(Math.sin(Math.PI * u), ol.amount ?? 0.7);
          else if (ol.kind === 'taper') fmul = 0.06 + 0.94 * (1 - u);
          else if (ol.kind === 'brush') fmul = (0.2 + 0.8 * Math.pow(1 - u, ol.amount ?? 0.8)) * Math.min(1, 0.5 + u * 7);
          else if (ol.kind === 'scallop') fmul = (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.5)) * (1 + (ol.amount ?? 0.3) * Math.sin(2 * Math.PI * (ol.lobes ?? 3) * u));
          else if (ol.kind === 'flame') fmul = (0.1 + 0.9 * Math.pow(1 - u, 0.8)) * (1 + 0.22 * Math.sin(2 * Math.PI * (ol.lobes ?? 3) * u));
          if (ol.kind !== 'disc') pr.w = Math.max(floor_, pr.w * fmul);
          if (ol.min !== undefined) pr.h = Math.min(pr.h, Math.max(pr.w, ol.min));
        }
      }
      if (o.bulges.length && !pr.arrow && !nuc) {
        let grow = 0;
        for (const bu of o.bulges) {
          const q = Math.abs((seg.first + t - bu.t) / bu.span);
          if (q >= 1) continue;
          const wgt = bu.flat ? smooth(Math.min(1, (1 - q) / 0.3)) : (1 - q * q) * (1 - q * q);
          if (bu.to) {
            pr.w += (bu.to.w - pr.w) * wgt;
            pr.h += (bu.to.h - pr.h) * wgt;
            pr.p += (bu.to.p - pr.p) * wgt;
          } else grow = Math.max(grow, (bu.widen ?? 0) * wgt);
        }
        pr.w *= 1 + grow;
      }
      if (mit) {
        pr.w *= 1 + (mit.m - 1) * Math.abs(dot(S, mit.dir));
        pr.h *= 1 + (mit.m - 1) * Math.abs(dot(B, mit.dir));
      }
      const resIdx = seg.first + Math.min(n - 1, Math.max(0, Math.round(t)));
      const ssCode = nuc ? 1 : SS_CODE[s.residues[resIdx].ss];
      const ringStart = P.length / 3;
      {
        const kq = resIdx - seg.first;
        curRun = [Math.min(1, Math.max(0, (t - (run0[kq] - 0.5)) / (run1[kq] - run0[kq] + 1))), seg.first + run0[kq] + 1];
      }
      const a = pr.w / 2, b = pr.h / 2, pe = pr.p;
      if (prevP) arc += len(sub(p, prevP));
      prevP = p;
      if (Math.abs(t - Math.round(t)) < 1e-9) arcAt[Math.round(t)] = arc;
      curCenter = p;
      let perim = 0;
      let lastXY: [number, number] | null = null;
      for (let j = 0; j < segs; j++) {
        const th = (2 * Math.PI * (j + (o.cornerProfile ? 0.5 : 0))) / segs;
        const c = Math.cos(th), sn = Math.sin(th);
        const x = a * Math.sign(c) * Math.pow(Math.abs(c), 2 / pe);
        const y = b * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / pe);
        let nx = (Math.sign(x) * Math.pow(Math.abs(x / a), pe - 1)) / a;
        let ny = (Math.sign(y) * Math.pow(Math.abs(y / b), pe - 1)) / b;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        if (lastXY) perim += Math.hypot(x - lastXY[0], y - lastXY[1]);
        lastXY = [x, y];
        curPhys = [arc, x, y, perim];
        const pos = add(p, add(scale(S, x), scale(B, y)));
        const nrm = norm(add(scale(S, nx), scale(B, ny)));
        pushV(pos, nrm, [seg.first + t, j / segs, x / Math.max(a, 1e-6), ssCode], [seg.chainIndex, resIdx, ny, pr.arrow], T);
      }
      ringStarts.push(ringStart);
      if (brk && prevRing >= 0) {
        caps.push([prevRing, 1], [ringStart, -1]);
        prevRing = -1;
      }
      if (prevRing >= 0) {
        if (step) {
          // arrow back face: annulus between previous (narrow) ring and this (wide) ring, normal = -T
          // (block ends: the cut face looks along +T when the section shrinks)
          const shrink = o.blockEnds && pr.w * pr.h < prevArea;
          const back = scale(T, shrink ? 1 : -1);
          const base = P.length / 3;
          for (let j = 0; j < segs; j++) {
            for (const r of [prevRing, ringStart]) {
              const vi = r + j;
              copyFrom(vi);
              pushV([P[3 * vi], P[3 * vi + 1], P[3 * vi + 2]], back, [SU[4 * vi], SU[4 * vi + 1], SU[4 * vi + 2], SU[4 * vi + 3]], [IN[4 * vi], IN[4 * vi + 1], 0, 1], T);
            }
          }
          for (let j = 0; j < segs; j++) {
            const j1 = (j + 1) % segs;
            const a0 = base + 2 * j, a1 = base + 2 * j + 1, b0 = base + 2 * j1, b1 = base + 2 * j1 + 1;
            if (shrink) ID.push(a0, a1, b0, a1, b1, b0);
            else ID.push(a0, b0, a1, a1, b0, b1);
          }
        } else {
          for (let j = 0; j < segs; j++) {
            const j1 = (j + 1) % segs;
            const a0 = prevRing + j, a1 = prevRing + j1, b0 = ringStart + j, b1 = ringStart + j1;
            // counter-clockwise seen from outside (outward normal = (a1-a0) x (b0-a0))
            ID.push(a0, a1, b0, a1, b1, b0);
          }
        }
      }
      prevRing = ringStart;
      prevArea = pr.w * pr.h;
      prevT = T;
      prevS = S;
    }
    // end caps
    caps.push([ringStarts[0], -1], [ringStarts[ringStarts.length - 1], 1]);
    for (const [ring, sign] of caps) {
      const T: V = [TG[3 * ring] * sign, TG[3 * ring + 1] * sign, TG[3 * ring + 2] * sign];
      let c: V = [0, 0, 0];
      for (let j = 0; j < segs; j++) c = add(c, [P[3 * (ring + j)], P[3 * (ring + j) + 1], P[3 * (ring + j) + 2]]);
      c = scale(c, 1 / segs);
      const vi0 = ring;
      copyFrom(vi0);
      curPhys = [curPhys[0], 0, 0, 0];
      const centre = pushV(c, T, [SU[4 * vi0], 0, 0, SU[4 * vi0 + 3]], [IN[4 * vi0], IN[4 * vi0 + 1], 0, 0], T);
      const base = P.length / 3;
      for (let j = 0; j < segs; j++) {
        const vi = ring + j;
        copyFrom(vi);
        pushV([P[3 * vi], P[3 * vi + 1], P[3 * vi + 2]], T, [SU[4 * vi], SU[4 * vi + 1], SU[4 * vi + 2], SU[4 * vi + 3]], [IN[4 * vi], IN[4 * vi + 1], 0, 0], T);
      }
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        if (sign > 0) ID.push(centre, base + j, base + j1);
        else ID.push(centre, base + j1, base + j);
      }
    }
    // --- DNA / RNA bases: a slab in the plane of each base, from the backbone to the base's N1 (purine) / N3 (pyrimidine) ---
    if (nuc && o.baseWidth > 0) {
      for (let k = 0; k < n; k++) {
        const r = res[k];
        const find = (name: string) => {
          for (let a = r.atomStart; a < r.atomEnd; a++) if (s.atomNames[a] === name) return a;
          return -1;
        };
        const tipA = find(find('N9') >= 0 ? 'N1' : 'N3');
        if (tipA < 0) continue;
        const from = ctrl[k], D = sub(atom(tipA), from), L = len(D);
        if (L < 1.5 || L > 16) continue;
        const T = norm(D);
        const c2 = find('C2'), c4 = find('C4'), c6 = find('C6');
        let S: V = c2 >= 0 && c4 >= 0 && c6 >= 0 ? cross(cross(sub(atom(c4), atom(c2)), sub(atom(c6), atom(c2))), T) : [0, 0, 0];
        if (len(S) < 1e-3) S = cross(T, Math.abs(T[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
        S = norm(S);
        const B = cross(T, S);
        const a = o.baseWidth / 2, b = Math.max(band.h, 0.3) / 2, pe = Math.max(4, band.p);
        const resIdx = seg.first + k;
        curRun = [Math.min(1, Math.max(0, (k + 0.5) / n)), seg.first + 1];
        const rings: number[] = [];
        for (let ri = 0; ri < 2; ri++) {
          const c = add(from, scale(D, ri));
          curCenter = c;
          rings.push(P.length / 3);
          let perim = 0;
          let lastXY: [number, number] | null = null;
          for (let j = 0; j < segs; j++) {
            const th = (2 * Math.PI * (j + (o.cornerProfile ? 0.5 : 0))) / segs;
            const cs = Math.cos(th), sn = Math.sin(th);
            const x = a * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / pe);
            const y = b * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / pe);
            let nx = (Math.sign(x) * Math.pow(Math.abs(x / a), pe - 1)) / a;
            let ny = (Math.sign(y) * Math.pow(Math.abs(y / b), pe - 1)) / b;
            const nl = Math.hypot(nx, ny) || 1;
            nx /= nl;
            ny /= nl;
            if (lastXY) perim += Math.hypot(x - lastXY[0], y - lastXY[1]);
            lastXY = [x, y];
            curPhys = [arcAt[k] + L * ri, x, y, perim];
            // a position along the chain of its own (never a whole residue), so the slab is not taken for a ring of the backbone
            pushV(add(c, add(scale(S, x), scale(B, y))), norm(add(scale(S, nx), scale(B, ny))), [resIdx + 0.26 + 0.01 * ri, j / segs, x / a, 2], [seg.chainIndex, resIdx, ny, 0], T);
          }
        }
        for (let j = 0; j < segs; j++) {
          const j1 = (j + 1) % segs;
          const a0 = rings[0] + j, a1 = rings[0] + j1, b0 = rings[1] + j, b1 = rings[1] + j1;
          ID.push(a0, a1, b0, a1, b1, b0);
        }
        for (const [ring, sign] of [[rings[0], -1], [rings[1], 1]]) {
          const Tc = scale(T, sign);
          copyFrom(ring);
          curPhys = [curPhys[0], 0, 0, 0];
          const centre = pushV([CT[3 * ring], CT[3 * ring + 1], CT[3 * ring + 2]], Tc, [SU[4 * ring], 0, 0, 2], [seg.chainIndex, resIdx, 0, 0], T);
          const base = P.length / 3;
          for (let j = 0; j < segs; j++) {
            const vi = ring + j;
            copyFrom(vi);
            pushV([P[3 * vi], P[3 * vi + 1], P[3 * vi + 2]], Tc, [SU[4 * vi], SU[4 * vi + 1], SU[4 * vi + 2], 2], [seg.chainIndex, resIdx, 0, 0], T);
          }
          for (let j = 0; j < segs; j++) {
            const j1 = (j + 1) % segs;
            if (sign > 0) ID.push(centre, base + j, base + j1);
            else ID.push(centre, base + j1, base + j);
          }
        }
      }
    }
  }
  return {
    positions: new Float32Array(P),
    normals: new Float32Array(Nn),
    surf: new Float32Array(SU),
    info: new Float32Array(IN),
    tangents: new Float32Array(TG),
    phys: new Float32Array(PH),
    ...(o.runs ? { run: new Float32Array(RN) } : {}),
    centers: new Float32Array(CT),
    indices: new Uint32Array(ID),
    vertexCount: P.length / 3,
    segments,
    gaps,
  };
}

/** Convert to non-indexed geometry with flat (per-triangle) normals and a per-facet id. */
export function flatten(m: MeshData): MeshData & { facet: Float32Array } {
  const nt = m.indices.length / 3;
  const P = new Float32Array(nt * 9), N = new Float32Array(nt * 9), TG = new Float32Array(nt * 9);
  const SU = new Float32Array(nt * 12), IN = new Float32Array(nt * 12), F = new Float32Array(nt * 3);
  const PH = new Float32Array(nt * 12), CT = new Float32Array(nt * 9);
  const RN = m.run ? new Float32Array(nt * 6) : undefined;
  for (let t = 0; t < nt; t++) {
    const ids = [m.indices[3 * t], m.indices[3 * t + 1], m.indices[3 * t + 2]];
    const v = ids.map((i) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]] as V);
    let fn = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    if (len(fn) < 1e-12) fn = [m.normals[3 * ids[0]], m.normals[3 * ids[0] + 1], m.normals[3 * ids[0] + 2]];
    fn = norm(fn);
    // strands and loops: both triangles of a quad share one normal, so a twisted strand reads as broad bands
    // instead of a sawtooth of alternating triangles (helices keep their triangular facets)
    if (Math.round(m.surf[4 * ids[0] + 3]) !== 1) {
      const t2 = t ^ 1;
      if (t2 < nt) {
        const w = [m.indices[3 * t2], m.indices[3 * t2 + 1], m.indices[3 * t2 + 2]].map((i) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]] as V);
        const f2 = cross(sub(w[1], w[0]), sub(w[2], w[0]));
        if (len(f2) > 1e-12 && dot(norm(f2), fn) > 0.2) fn = norm(add(fn, norm(f2)));
      }
    }
    // stable facet id per triangle: shards split each quad diagonally (cubist triangles)
    // quad id: both triangles of a quad form one plane; cap fans (face normal ~ chain tangent) become one plane per cap
    const tg: V = [m.tangents[3 * ids[0]], m.tangents[3 * ids[0] + 1], m.tangents[3 * ids[0] + 2]];
    const isCap = Math.abs(dot(fn, norm(tg))) > 0.9;
    const fid = isCap ? 4000000 + Math.round(m.surf[4 * ids[0]]) * 8 : Math.floor(t / 2);
    for (let k = 0; k < 3; k++) {
      const i = ids[k], o = 3 * t + k;
      P.set(v[k], 3 * o);
      N.set(fn, 3 * o);
      TG.set([m.tangents[3 * i], m.tangents[3 * i + 1], m.tangents[3 * i + 2]], 3 * o);
      SU.set(m.surf.subarray(4 * i, 4 * i + 4), 4 * o);
      IN.set(m.info.subarray(4 * i, 4 * i + 4), 4 * o);
      PH.set(m.phys.subarray(4 * i, 4 * i + 4), 4 * o);
      if (RN) RN.set(m.run!.subarray(2 * i, 2 * i + 2), 2 * o);
      CT.set(m.centers.subarray(3 * i, 3 * i + 3), 3 * o);
      F[o] = fid;
    }
  }
  const idx = new Uint32Array(nt * 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return { ...m, positions: P, normals: N, tangents: TG, surf: SU, info: IN, phys: PH, ...(RN ? { run: RN } : {}), centers: CT, indices: idx, vertexCount: nt * 3, facet: F };
}
