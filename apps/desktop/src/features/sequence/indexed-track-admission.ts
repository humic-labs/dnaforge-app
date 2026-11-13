import { directTrackAdmissionRequest, type IndexedBbiTrackInput } from '@waypoint/genome-data';
import { getBbiReaderWorkerClient } from './bbi-reader-runtime';
import { admitIndexedTrack } from './indexed-track-client';
import {
  admitIndexedBigWigRequest as admitBigWig,
  admitIndexedBigBedRequest as admitBigBed,
  type IndexedBbiRequestAdmissionInput,
} from '../../shared/genome/indexed-track-admission';
export { recommendedTypesForScientificKind } from '../../shared/genome/indexed-track-admission';

type Input = Omit<IndexedBbiRequestAdmissionInput, 'runtime'>;
const runtime = () => ({ admit: admitIndexedTrack, reader: getBbiReaderWorkerClient() });
export function admitIndexedBigWigRequest(input: Input) {
  return admitBigWig({ ...input, runtime: runtime() });
}
export function admitIndexedBigBedRequest(input: Input) {
  return admitBigBed({ ...input, runtime: runtime() });
}
export function admitIndexedBigWigSource(
  input: Omit<Input, 'request'> & {
    assemblyId: string;
    source: IndexedBbiTrackInput;
    label?: string;
  }
) {
  return admitIndexedBigWigRequest({
    ...input,
    request: directTrackAdmissionRequest({
      assemblyId: input.assemblyId,
      input: input.source,
      formatId: 'bigwig',
      ...(input.label ? { label: input.label } : {}),
      ingress: input.source.kind === 'path' ? 'file-picker' : 'url',
    }),
  });
}
