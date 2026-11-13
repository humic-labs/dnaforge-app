import { trackAdmissionRequestIdentity, type AdmittedTrackSource } from '@waypoint/genome-data';

export function bbiAdmissionContentIdentity(source: AdmittedTrackSource): string {
  if (source.readerKind !== 'bbi' || !source.request) return source.fingerprint;
  const { scientificKind: _inferredKind, ...unclassifiedRequest } = source.request;
  const unclassifiedPrefix = `${trackAdmissionRequestIdentity(unclassifiedRequest)}\u0000`;
  if (!source.fingerprint.startsWith(unclassifiedPrefix)) return source.fingerprint;
  const typedIdentity = trackAdmissionRequestIdentity({
    ...source.request,
    scientificKind: source.scientificKind,
  });
  return `${typedIdentity}\u0000${source.fingerprint.slice(unclassifiedPrefix.length)}`;
}
