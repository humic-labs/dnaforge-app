import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { parseFasta } from '@waypoint/plasmid-viewer/parsers';
import { decodeSequenceDocument, type TraceData } from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { binaryCoordinateText } from '../shared/binary-coordinates';
import {
  buildDefaultMolecularDocument,
  packagedCoordinateFormat,
} from '../shared/default-molecular-view';
import {
  MOLECULAR_DOCUMENT_SUFFIX,
  serializeMolecularDocument,
} from '../shared/molecular-document';
import { MOLECULAR_VIEW_MAX_COORDINATE_BYTES } from '../shared/molecular-view';
import {
  SOURCE_DOCUMENT_MARKER_PATH,
  type SourceDocumentFamily,
  type SourceDocumentPresentation,
} from '../shared/source-document-package';
import { materializeImportedSequencePackages } from './workspace-git/sequence-package-import';
import { inventoryCoordinatesInWorker } from './molecular-catalog/inventory-worker';

export interface SourceDocumentProducts {
  presentation: SourceDocumentPresentation;
  products: string[];
  recordCount: number;
}

function manifestProduct(
  presentation: SourceDocumentPresentation,
  recordCount: number
): SourceDocumentProducts {
  return { presentation, recordCount, products: [SOURCE_DOCUMENT_MARKER_PATH] };
}

export async function writeSourceDocumentProducts(
  root: string,
  familyId: SourceDocumentFamily,
  name: string,
  bytes: Uint8Array,
  sha256: string
): Promise<SourceDocumentProducts> {
  if (familyId === 'chromatogram') {
    const { sequence } = decodeSequenceDocument(bytes, { format: 'ab1', path: name });
    const trace = sequence.metadata?.trace as TraceData | undefined;
    const samples = trace?.channels.A.length;
    if (
      !trace ||
      !samples ||
      !sequence.length ||
      !Object.values(trace.channels).every((channel) => channel.length === samples) ||
      trace.peakPositions.length !== sequence.length ||
      trace.peakPositions.some(
        (value, i, positions) =>
          value < 0 || value >= samples || (i > 0 && value < positions[i - 1])
      )
    )
      throw new Error('The chromatogram has incomplete channels or invalid base-call positions.');
    return manifestProduct('chromatogram', 1);
  }
  if (familyId === 'structure') {
    const format = packagedCoordinateFormat(name);
    if (!format) throw new Error('Unrecognized coordinate file format.');
    const textSize = format === 'bcif' ? 4 * Math.ceil(bytes.length / 3) : bytes.length;
    await inventoryCoordinatesInWorker({ bytes, format, purpose: 'document-preview' });
    if (textSize > MOLECULAR_VIEW_MAX_COORDINATE_BYTES)
      return manifestProduct('coordinate-asset', 1);
    const stem = basename(name, extname(name));
    const document = await buildDefaultMolecularDocument({
      name: stem,
      format,
      text:
        format === 'bcif'
          ? binaryCoordinateText(bytes)
          : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      documentId: randomUUID(),
      referenceId: randomUUID(),
      createdAt: Date.now(),
    });
    const product = stem + MOLECULAR_DOCUMENT_SUFFIX;
    await writeFile(join(root, product), serializeMolecularDocument(document), { flag: 'wx' });
    return { presentation: 'molecular-document', recordCount: 1, products: [product] };
  }
  const records = parseFasta(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
    complete: true,
  });
  await writeFile(join(root, 'records.json'), JSON.stringify(records), { flag: 'wx' });
  if (sequenceFileTypeForPath(name)?.managedImport !== 'nucleotide-fasta')
    return manifestProduct('fasta-collection', records.length);
  const productRoot = join(root, 'sequences');
  await mkdir(productRoot);
  const input = join(productRoot, name);
  await writeFile(input, bytes, { flag: 'wx' });
  const materialized = await materializeImportedSequencePackages(input, undefined, {
    expectedSourceSha256: sha256,
  });
  if (!materialized.converted) {
    if (!materialized.sourceOnly)
      throw new Error(
        materialized.skippedReason ?? 'The FASTA sequence package could not be built.'
      );
    await rm(productRoot, { recursive: true });
    return manifestProduct('fasta-collection', records.length);
  }
  if (materialized.packages.length !== records.length)
    throw new Error('The FASTA package record count has changed.');
  return {
    presentation: 'sequence-package',
    recordCount: records.length,
    products: materialized.packages.map((product) =>
      relative(root, product.productPath).split(sep).join('/')
    ),
  };
}
