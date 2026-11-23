import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import type { Trajectory } from 'molstar/lib/mol-model/structure';
import { Task } from 'molstar/lib/mol-task';
import { DocumentReadError } from './document-read-failure';
import type { StructureFileFormat } from './scientific-file-types';

/** Read the default model that the coordinate viewer will display, without creating a viewer. */
export async function readLooseCoordinateModel(
  data: string | Uint8Array,
  format: StructureFileFormat
): Promise<void> {
  let trajectory: Trajectory;
  let recognized: boolean;
  if (format.parser === 'pdb') {
    if (typeof data !== 'string') throw new DocumentReadError('coordinates');
    recognized = /^(?:HEADER|ATOM  |HETATM|MODEL )/mu.test(data);
    for (const [line] of data.matchAll(/^(?:ATOM  |HETATM)[^\r\n]*/gmu)) {
      if (
        [30, 38, 46].some((start) => {
          const value = line.slice(start, start + 8).trim();
          return !value || !Number.isFinite(Number(value));
        })
      )
        throw new DocumentReadError('coordinates', true);
    }
    const parsed = await parsePDB(data).run();
    if (parsed.isError) throw new DocumentReadError('coordinates', recognized);
    trajectory = await trajectoryFromPDB(parsed.result).run();
  } else {
    recognized = typeof data === 'string' && /^\s*data_\S+/imu.test(data);
    const parsed = await CIF.parse(data).run();
    if (parsed.isError) {
      if (format.encoding === 'binary' && parsed.message.startsWith('Unsupported format version.'))
        throw new DocumentReadError('unsupported-format', true);
      throw new DocumentReadError('coordinates', recognized);
    }
    const block = parsed.result.blocks[0];
    if (!block) throw new DocumentReadError('coordinates', recognized);
    recognized = true;
    trajectory = await trajectoryFromMmCIF(block).run();
  }
  if (trajectory.frameCount === 0) throw new DocumentReadError('coordinates', recognized);
  const frame = trajectory.getFrameAtIndex(0);
  const model = Task.is(frame) ? await frame.run() : frame;
  const atomic = Boolean(
    model?.atomicHierarchy.atoms._rowCount && model.atomicConformation.xyzDefined
  );
  const coarse = Boolean(
    model?.coarseHierarchy.spheres.count || model?.coarseHierarchy.gaussians.count
  );
  if (!atomic && !coarse) throw new DocumentReadError('coordinates', recognized);
}
