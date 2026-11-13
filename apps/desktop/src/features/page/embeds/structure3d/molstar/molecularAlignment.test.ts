import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { Vec3, Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { SymmetryOperator } from 'molstar/lib/mol-math/geometry/symmetry-operator';
import { computeMolecularAlignment } from './molecularAlignment';

const points = [
  [0, 0, 0],
  [1, 2, 0],
  [3, 1, 1],
  [4, 4, 2],
  [5, 1, 4],
  [6, 2, 5],
];
const residues = ['ALA', 'GLY', 'SER', 'VAL', 'THR', 'LEU'];
async function source(chain: string, offset = 0, coordinates = points) {
  const text =
    coordinates
      .map(
        ([x, y, z], i) =>
          `ATOM  ${String(i + 1).padStart(5)}  CA  ${residues[i % residues.length]} ${chain}${String(i + 1 + offset).padStart(4)}    ${[x, y, z].map((v) => v.toFixed(3).padStart(8)).join('')}  1.00 20.00           C`
      )
      .join('\n') + '\nTER\nEND\n';
  const parsed = await parsePDB(text).run();
  if (parsed.isError) throw Error(parsed.message);
  return Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
}

describe('source-derived structural correspondence and rigid fit', () => {
  it('preserves native rigidity for a numerically sensitive observed partial fit', async () => {
    const coordinates = [
      [16.008, 166.384, 50.821, -28.645, 4.531, -76.986],
      [14.635, 164.171, 48.059, -31.853, 6.448, -76.259],
      [11.477, 166.29, 48.122, -33.477, 3.016, -76.203],
      [13.595, 169.418, 47.752, -30.904, 1.488, -73.867],
      [15.612, 168.028, 44.844, -31.202, 4.23, -71.263],
      [12.432, 166.752, 43.192, -35, 4.216, -71.284],
      [10.651, 170.118, 43.293, -34.76, 0.598, -70.116],
      [13.747, 171.948, 42.06, -32.156, 1.104, -67.397],
      [15.233, 169.561, 39.475, -33.254, 4.309, -65.69],
      [15.936, 172.526, 37.195, -32.104, 2.811, -62.398],
      [18.531, 173.645, 39.746, -28.468, 2.638, -63.583],
      [19.8, 170.141, 40.531, -28.482, 6.029, -65.371],
      [20.926, 169.956, 36.902, -29.518, 7.549, -62.047],
      [22.6, 173.381, 36.88, -26.827, 5.714, -60.101],
      [24.77, 172.263, 39.773, -24.349, 7.208, -62.609],
      [25.51, 168.828, 38.285, -25.687, 10.794, -62.565],
      [28.066, 167.474, 35.822, -25.164, 13.756, -60.269],
      [28.18, 164.646, 33.285, -27.192, 16.72, -59.058],
      [31.613, 163.144, 32.655, -25.502, 20.024, -58.253],
      [32.095, 160.613, 29.863, -27.428, 22.944, -56.762],
      [33.874, 157.429, 30.93, -26.817, 26.101, -58.803],
      [34.301, 154.76, 28.238, -29.116, 29.037, -57.882],
      [32.699, 152.611, 25.554, -31.144, 28.82, -54.666],
      [34.482, 149.274, 26.085, -33.528, 31.716, -53.988],
      [32.671, 146.106, 24.985, -36.281, 31.874, -51.364],
      [29.487, 147.161, 23.21, -39.187, 31.611, -53.828],
      [28.184, 149.313, 26.029, -37.496, 29.444, -56.478],
      [28.468, 153.06, 26.586, -34.722, 26.824, -56.449],
      [28.81, 154.674, 30.012, -32.677, 25.784, -59.491],
      [29.188, 158.125, 31.562, -30.273, 22.845, -59.657],
      [29.314, 159.461, 35.121, -28.322, 21.276, -62.523],
      [26.572, 161.892, 36.111, -28.822, 17.557, -63.12],
      [27.749, 163.944, 39.086, -25.971, 15.732, -64.863],
      [24.778, 165.043, 41.203, -26.644, 12.591, -66.882],
      [25.174, 167.447, 44.164, -24.054, 10.318, -68.525],
      [23.949, 166.251, 47.578, -23.574, 10.085, -72.305],
      [22.961, 169.078, 49.923, -22.046, 6.899, -73.713],
      [24.041, 168.687, 53.546, -19.455, 6.818, -76.489],
      [22.752, 172.039, 54.768, -19.969, 3.227, -77.57],
      [19.017, 172.582, 54.277, -22.63, 0.557, -77.013],
      [16.615, 174.766, 56.309, -23.219, -3.171, -77.537],
      [19.093, 177.276, 57.747, -19.5, -3.86, -77.318],
      [19.063, 181.07, 58.35, -18.6, -7.317, -75.978],
      [20.448, 182.846, 55.292, -17.403, -7.328, -72.354],
      [21.006, 186.539, 54.541, -15.946, -9.793, -69.886],
      [22.434, 188.675, 51.724, -14.803, -9.948, -66.249],
      [24.468, 191.844, 52.302, -11.712, -11.659, -64.842],
      [24.39, 194.57, 49.654, -11.385, -13.337, -61.453],
      [26.987, 197.282, 50.242, -8.041, -14.979, -60.73],
      [27.365, 200.63, 48.467, -6.624, -17.386, -58.153],
      [29.993, 203.431, 48.48, -3.195, -18.772, -57.055],
      [29.6, 205.883, 51.365, -1.439, -21.37, -59.23],
      [31.37, 209.155, 50.578, 1.213, -23.698, -57.746],
    ];
    const reference = await source(
      'A',
      0,
      coordinates.map((row) => row.slice(0, 3))
    );
    const mobile = await source(
      'B',
      100,
      coordinates.map((row) => row.slice(3))
    );
    const fit = computeMolecularAlignment(
      reference,
      mobile,
      { auth_asym_id: 'A' },
      { auth_asym_id: 'B' }
    );
    expect(fit.pairs).toHaveLength(53);
    expect(fit.rmsd).toBeCloseTo(1.443010825, 6);
    expect(Array.from(fit.matrix).every(Number.isFinite)).toBe(true);
    expect(Mat4.isRotationAndTranslation(fit.matrix)).toBe(true);
  });

  it('fits declared partial regions using sequence correspondence rather than author numbering', async () => {
    const reference = await source('A');
    const mobile = await source(
      'B',
      100,
      points.map(([x, y, z]) => [-y + 10, x - 5, z + 3])
    );
    const fit = computeMolecularAlignment(
      reference,
      mobile,
      { auth_asym_id: 'A', beg_auth_seq_id: 1, end_auth_seq_id: 3 },
      { auth_asym_id: 'B', beg_auth_seq_id: 101, end_auth_seq_id: 103 }
    );
    expect(fit.pairs).toHaveLength(3);
    expect(fit.pairs.map((p) => [p.reference.authSeqId, p.mobile.authSeqId])).toEqual([
      [1, 101],
      [2, 102],
      [3, 103],
    ]);
    expect(fit.rmsd).toBeLessThan(1e-6);
    for (const pair of fit.pairs) {
      const transformed = Vec3.transformMat4(
        Vec3(),
        Vec3.fromArray(Vec3(), pair.mobile.position, 0),
        fit.matrix
      );
      expect(
        Vec3.distance(transformed, Vec3.fromArray(Vec3(), pair.reference.position, 0))
      ).toBeLessThan(1e-6);
    }
  });

  it('rejects insufficient and geometrically degenerate correspondence', async () => {
    const reference = await source('A');
    const mobile = await source('B');
    expect(() =>
      computeMolecularAlignment(
        reference,
        mobile,
        { auth_asym_id: 'A', end_auth_seq_id: 2 },
        { auth_asym_id: 'B', end_auth_seq_id: 2 }
      )
    ).toThrow(/three/);
    const line = await source(
      'A',
      0,
      points.map((_, i) => [i, 0, 0])
    );
    expect(() =>
      computeMolecularAlignment(line, line, { auth_asym_id: 'A' }, { auth_asym_id: 'A' })
    ).toThrow(/non-collinear/);
  });

  it('rejects an empty scientific region instead of making up coordinates', async () => {
    const structure = await source('A');
    expect(() =>
      computeMolecularAlignment(
        structure,
        structure,
        { auth_asym_id: 'missing' },
        { auth_asym_id: 'A' }
      )
    ).toThrow(/polymer/);
  });

  it('refuses to choose between physical assembly copies with the same chain name', async () => {
    const structure = await source('A');
    const unit = structure.units[0];
    const copy = unit.applyOperator(
      unit.id + 100,
      SymmetryOperator.create('copy', Mat4.fromTranslation(Mat4(), Vec3.create(20, 0, 0)))
    );
    const assembly = Structure.create([...structure.units, copy]);
    expect(() =>
      computeMolecularAlignment(assembly, structure, { auth_asym_id: 'A' }, { auth_asym_id: 'A' })
    ).toThrow(/one physical polymer chain/);
  });
});
