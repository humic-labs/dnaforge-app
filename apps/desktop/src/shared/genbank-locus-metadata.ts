import {
  decodeGenBankLocusName,
  formatGenBankLocusPrefix,
  GENBANK_LOCUS_ENCODING_COMMENT,
} from '@waypoint/sequence-utils';

export function renameGenBankLocus(content: string, name: string): string {
  return updateGenBankLocusMetadata(content, { name });
}

export function updateGenBankLocusMetadata(
  content: string,
  update: { name?: string; topology?: 'circular' | 'linear' }
): string {
  const requestedName = update.name?.trim();
  if (update.name !== undefined && (!requestedName || /[\r\n]/.test(requestedName))) {
    throw new Error('Sequence name must be a non-empty single line.');
  }
  const locus = /^(LOCUS\s+)(.+?)\s+(\d+)\s+bp\b([^\r\n]*)/im;
  if (!locus.test(content)) {
    throw new Error('The managed sequence product has no valid GenBank LOCUS line.');
  }
  const encoded = content.split(/\r?\n/).includes(GENBANK_LOCUS_ENCODING_COMMENT);
  const result = content.replace(
    locus,
    (_match, _prefix: string, oldName: string, lengthField: string, suffix: string) => {
      const nextName = requestedName ?? (encoded ? decodeGenBankLocusName(oldName) : oldName);
      let nextSuffix = suffix;
      if (update.topology) {
        const existingTopology = /\b(circular|linear)\b */i;
        nextSuffix = existingTopology.test(suffix)
          ? suffix.replace(existingTopology, update.topology.padEnd(8) + ' ')
          : `${suffix}${suffix.endsWith(' ') ? '' : ' '}${update.topology}`;
      }
      return `${formatGenBankLocusPrefix(nextName, Number(lengthField))} bp${nextSuffix}`;
    }
  );
  if (encoded) return result;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return result.replace(/^(LOCUS[^\r\n]*)/m, `$1${newline}${GENBANK_LOCUS_ENCODING_COMMENT}`);
}
