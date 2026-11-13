import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { readEncodedPolymerChain } from '../page/public/embeds/structure3d/encodedPolymer';
import { readVerifiedProteinChain } from '../page/public/embeds/structure3d/proteinComparison';
import {
  coordinateDigest,
  MOLECULAR_VIEW_MAX_COORDINATE_BYTES,
} from '../page/public/embeds/structure3d/molecularView';

export async function readPredictionCoordinateModel(text: string, format: 'pdb' | 'cif') {
  if (!text || new TextEncoder().encode(text).byteLength > MOLECULAR_VIEW_MAX_COORDINATE_BYTES)
    throw new Error('Predicted coordinates are empty or exceed the saved-view size limit.');
  const trajectory = await (async () => {
    if (format === 'pdb') {
      const parsed = await parsePDB(text).run();
      if (parsed.isError) throw new Error(parsed.message);
      return trajectoryFromPDB(parsed.result).run();
    }
    const parsed = await CIF.parseText(text).run();
    if (parsed.isError) throw new Error(parsed.message);
    if (parsed.result.blocks.length !== 1)
      throw new Error('Choose one predicted coordinate model.');
    return trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  })();
  if (trajectory.frameCount !== 1 || !trajectory.representative?.atomicHierarchy.atoms._rowCount)
    throw new Error('The prediction must contain one model with actual atomic coordinates.');
  return trajectory.representative;
}

export async function validatePredictionCoordinates(
  text: string,
  format: 'pdb' | 'cif',
  sequenceSha256: string
): Promise<void> {
  const model = await readPredictionCoordinateModel(text, format);
  const proteins = Array.from({ length: model.atomicHierarchy.chains._rowCount }, (_, index) =>
    readEncodedPolymerChain(model, index)
  ).filter((item) => item?.kind === 'protein');
  if (proteins.length === 0) throw new Error('The prediction contains no protein coordinates.');
  for (const protein of proteins) {
    const digest = await coordinateDigest(protein!.sequence);
    if (protein!.unresolved.length || digest !== sequenceSha256)
      throw new Error(
        'The predicted coordinate protein does not match the requested protein product sequence.'
      );
    await readVerifiedProteinChain({
      text,
      format,
      sequence: protein!.sequence,
      chainId: protein!.chainId,
    });
  }
}
