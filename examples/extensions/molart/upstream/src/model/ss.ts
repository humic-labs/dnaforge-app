import type { SSRange } from '../io/types';
import type { SS } from './structure';

export type SSSource = 'file' | 'computed-dssp' | 'computed-ca' | 'none';

interface ProtoRes {
  chainId: string;
  resSeq: number;
  iCode: string;
  name: string;
  n: number;
  ca: number;
  c: number;
  o: number;
}

type V = [number, number, number];
const at = (c: Float64Array, i: number): V => [c[3 * i], c[3 * i + 1], c[3 * i + 2]];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function assignSecondaryStructure(
  res: ProtoRes[],
  chainOf: number[],
  coords: Float64Array,
  ranges: SSRange[],
  mode: 'auto' | 'file' | 'computed',
  caOnly: boolean,
): { ss: SS[]; source: SSSource; notes: string[] } {
  const notes: string[] = [];
  if (mode !== 'computed' && ranges.length > 0) {
    const ss = fromRanges(res, chainOf, ranges, notes);
    return { ss, source: 'file', notes };
  }
  if (mode === 'file') notes.push('No secondary-structure records in file; falling back to computed assignment.');
  if (caOnly) {
    notes.push('Secondary structure computed from CA geometry only (approximate).');
    return { ss: caOnlySS(res, chainOf, coords), source: 'computed-ca', notes };
  }
  notes.push('Secondary structure computed from backbone hydrogen bonds (DSSP-like, H and E only).');
  return { ss: dsspLite(res, chainOf, coords), source: 'computed-dssp', notes };
}

function fromRanges(res: ProtoRes[], chainOf: number[], ranges: SSRange[], notes: string[]): SS[] {
  const ss: SS[] = res.map(() => 'C');
  const key = (c: string, s: number, i: string) => `${c}|${s}|${i}`;
  const idx = new Map<string, number>();
  res.forEach((r, i) => {
    const k = key(r.chainId, r.resSeq, r.iCode);
    if (!idx.has(k)) idx.set(k, i);
  });
  let missed = 0;
  // Strands first, then helices take precedence on (rare) overlaps.
  for (const type of ['E', 'H'] as const) {
    for (const r of ranges) {
      if (r.type !== type) continue;
      const a = idx.get(key(r.start.chainId, r.start.resSeq, r.start.iCode));
      const b = idx.get(key(r.end.chainId, r.end.resSeq, r.end.iCode));
      if (a === undefined || b === undefined || b < a || chainOf[a] !== chainOf[b]) {
        missed++;
        continue;
      }
      for (let i = a; i <= b; i++) ss[i] = type;
    }
  }
  if (missed) notes.push(`${missed} secondary-structure record(s) referenced residues not present; ignored.`);
  return ss;
}

/** Simplified DSSP: Kabsch–Sander H-bond energy, alpha helices (H) and ladders (E). */
export function dsspLite(res: ProtoRes[], chainOf: number[], coords: Float64Array): SS[] {
  const N = res.length;
  const ss: SS[] = new Array(N).fill('C');
  const ok = res.map((r) => r.n >= 0 && r.ca >= 0 && r.c >= 0 && r.o >= 0);
  const linked = new Array(N).fill(false); // residue i peptide-bonded to i+1
  for (let i = 0; i + 1 < N; i++) {
    if (ok[i] && ok[i + 1] && chainOf[i] === chainOf[i + 1]) linked[i] = dist(at(coords, res[i].c), at(coords, res[i + 1].n)) < 2.5;
  }
  const H: (V | null)[] = res.map((r, i) => {
    if (!ok[i] || i === 0 || !linked[i - 1] || r.name === 'PRO') return null;
    const n = at(coords, r.n);
    const c = at(coords, res[i - 1].c);
    const o = at(coords, res[i - 1].o);
    const d: V = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
    const l = Math.hypot(...d) || 1;
    return [n[0] + d[0] / l, n[1] + d[1] / l, n[2] + d[2] / l];
  });
  // spatial grid over CA
  const cell = 9;
  const grid = new Map<string, number[]>();
  const ca = res.map((r) => at(coords, r.ca));
  const gk = (p: V) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  ca.forEach((p, i) => {
    const k = gk(p);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const neighbours: number[][] = ca.map(() => []);
  ca.forEach((p, i) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (l) for (const j of l) if (j !== i && dist(p, ca[j]) < 9) neighbours[i].push(j);
        }
  });
  const hb = new Set<number>(); // CO(i) -> NH(j) encoded i*N+j
  for (let i = 0; i < N; i++) {
    if (!ok[i]) continue;
    const o = at(coords, res[i].o), c = at(coords, res[i].c);
    for (const j of neighbours[i]) {
      const h = H[j];
      if (!h || Math.abs(i - j) < 2) continue;
      const n = at(coords, res[j].n);
      const e = 27.888 * (1 / dist(o, n) + 1 / dist(c, h) - 1 / dist(o, h) - 1 / dist(c, n));
      if (e < -0.5) hb.add(i * N + j);
    }
  }
  const hbond = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N && hb.has(i * N + j);
  const contiguous = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (!linked[k]) return false;
    return true;
  };
  // alpha helices
  for (let i = 1; i + 4 < N; i++) {
    if (hbond(i - 1, i + 3) && hbond(i, i + 4) && contiguous(i - 1, i + 4)) for (let k = i; k <= i + 3; k++) ss[k] = 'H';
  }
  // bridges
  const bridge = new Map<number, Set<string>>();
  const addB = (i: number, j: number, t: string) => {
    (bridge.get(i) ?? bridge.set(i, new Set()).get(i)!).add(`${t}${j}`);
  };
  for (let i = 1; i + 1 < N; i++) {
    if (!contiguous(i - 1, i + 1)) continue;
    for (const j of neighbours[i]) {
      if (j <= i + 2 || j + 1 >= N || !contiguous(j - 1, j + 1)) continue;
      const par = (hbond(i - 1, j) && hbond(j, i + 1)) || (hbond(j - 1, i) && hbond(i, j + 1));
      const anti = (hbond(i, j) && hbond(j, i)) || (hbond(i - 1, j + 1) && hbond(j - 1, i + 1));
      if (par) {
        addB(i, j, 'p');
        addB(j, i, 'p');
      }
      if (anti) {
        addB(i, j, 'a');
        addB(j, i, 'a');
      }
    }
  }
  // ladders: a bridge with an adjacent bridge of the same type -> E
  for (const [i, set] of bridge) {
    for (const b of set) {
      const t = b[0];
      const j = parseInt(b.substring(1), 10);
      const nb = t === 'p' ? [`p${j + 1}`, `p${j - 1}`] : [`a${j - 1}`, `a${j + 1}`];
      const prev = bridge.get(i - 1), next = bridge.get(i + 1);
      if ((prev && prev.has(nb[1])) || (next && next.has(nb[0]))) if (ss[i] !== 'H') ss[i] = 'E';
    }
  }
  // fill single-residue bulges between strand residues
  for (let i = 1; i + 1 < N; i++) if (ss[i] === 'C' && ss[i - 1] === 'E' && ss[i + 1] === 'E' && contiguous(i - 1, i + 1)) ss[i] = 'E';
  return ss;
}

/** CA-only fallback: helices from i→i+3 / i→i+4 distances and CA dihedral, strands from extension + pairing. */
export function caOnlySS(res: ProtoRes[], chainOf: number[], coords: Float64Array): SS[] {
  const N = res.length;
  const ca = res.map((r) => at(coords, r.ca));
  const ss: SS[] = new Array(N).fill('C');
  const same = (a: number, b: number) => b < N && chainOf[a] === chainOf[b] && (b === a || dist(ca[b - 1], ca[b]) < 4.3) ;
  const sameRun = (a: number, b: number) => {
    for (let k = a; k <= b; k++) if (!same(a, k)) return false;
    return true;
  };
  const dihedral = (a: V, b: V, c: V, d: V) => {
    const b1 = sub(b, a), b2 = sub(c, b), b3 = sub(d, c);
    // IUPAC convention: atan2(|b2| b1·(b2×b3), (b1×b2)·(b2×b3)); right-handed α-helix ≈ +50°
    const n1 = cross(b1, b2), n2 = cross(b2, b3);
    return (Math.atan2(Math.hypot(...b2) * dot(b1, n2), dot(n1, n2)) * 180) / Math.PI;
  };
  const helixWin = new Array(N).fill(false);
  for (let i = 0; i + 4 < N; i++) {
    if (!sameRun(i, i + 4)) continue;
    const d3 = dist(ca[i], ca[i + 3]), d4 = dist(ca[i], ca[i + 4]);
    const dh = dihedral(ca[i], ca[i + 1], ca[i + 2], ca[i + 3]);
    helixWin[i] = d3 > 4.2 && d3 < 5.9 && d4 > 5.3 && d4 < 7.0 && dh > 25 && dh < 85;
  }
  for (let i = 0; i + 1 < N; i++) if (helixWin[i] && helixWin[i + 1]) for (let k = i; k <= i + 4; k++) ss[k] = 'H';
  const extended = ca.map((_, i) => i >= 1 && i + 1 < N && sameRun(i - 1, i + 1) && dist(ca[i - 1], ca[i + 1]) > 6.0);
  for (let i = 0; i < N; i++) {
    if (!extended[i] || ss[i] === 'H') continue;
    for (let j = 0; j < N; j++) {
      if (Math.abs(i - j) < 3 || !extended[j]) continue;
      if (dist(ca[i], ca[j]) < 5.5) {
        ss[i] = 'E';
        break;
      }
    }
  }
  // remove isolated E
  for (let i = 0; i < N; i++) if (ss[i] === 'E' && ss[i - 1] !== 'E' && ss[i + 1] !== 'E') ss[i] = 'C';
  return ss;
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
