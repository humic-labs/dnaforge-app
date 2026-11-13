const GENBANK_EXTENSIONS = ['.gb', '.gbk', '.gbff', '.genbank'] as const;
const CONVERTIBLE_FASTA_EXTENSIONS = ['.fasta', '.fa', '.fas', '.fna', '.ffn'] as const;

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? path : path.slice(0, path.length - (normalized.length - cut));
}

function joinPath(dir: string, ...parts: string[]): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function matchingExtension(name: string, extensions: readonly string[]): string | null {
  const lower = name.toLowerCase();
  return extensions.find((ext) => lower.endsWith(ext)) ?? null;
}

export function candidatePackagedConstructPath(loosePath: string): string | null {
  const name = fileName(loosePath);
  const gbExt = matchingExtension(name, GENBANK_EXTENSIONS);
  if (gbExt) {
    const stem = name.slice(0, name.length - gbExt.length);
    if (!stem) return null;
    return joinPath(parentDir(loosePath), stem, name);
  }
  const fastaExt = matchingExtension(name, CONVERTIBLE_FASTA_EXTENSIONS);
  if (fastaExt) {
    const stem = name.slice(0, name.length - fastaExt.length);
    if (!stem) return null;
    return joinPath(parentDir(loosePath), stem, `${stem}.gb`);
  }
  return null;
}
