import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ACCESSION_PATTERN = /GC[AF]_[0-9]+\.[0-9]+/g;
const EXACT_ACCESSION = /^GC[AF]_[0-9]+\.[0-9]+$/;
const PASTE_HINT = 'Paste an assembly link or an accession such as GCF_000008865.2.';

export interface NcbiAssemblyLink {
  readonly accession: string;
}

export function parseNcbiAssemblyLink(raw: string): NcbiAssemblyLink {
  const text = raw.trim();
  if (text.length === 0 || text.length > 2_048 || text.includes('\0')) {
    throw new Error(PASTE_HINT);
  }
  const accessions = [...new Set(text.match(ACCESSION_PATTERN) ?? [])];
  if (accessions.length === 0) {
    throw new Error(PASTE_HINT);
  }
  if (accessions.length > 1) {
    throw new Error('This link names more than one assembly. Paste one assembly page.');
  }
  const accession = accessions[0];
  if (!accession || !EXACT_ACCESSION.test(accession)) {
    throw new Error(PASTE_HINT);
  }
  if (text === accession) return { accession };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(PASTE_HINT);
  }
  if (url.protocol !== 'https:' || !isAssemblyArchiveHost(url.hostname)) {
    throw new Error('Paste an assembly link from NCBI, EBI, or UCSC.');
  }
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.some((segment) => segment === accession || segment.startsWith(`${accession}_`))) {
    return { accession };
  }
  if (isUcscHost(url.hostname) && `${url.pathname}${url.search}`.includes(accession)) {
    return { accession };
  }
  throw new Error(
    'Paste the assembly page itself. A search page or a record that is not one assembly cannot be opened.'
  );
}

function isAssemblyArchiveHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'ncbi.nlm.nih.gov' ||
    host.endsWith('.ncbi.nlm.nih.gov') ||
    host === 'ebi.ac.uk' ||
    host.endsWith('.ebi.ac.uk') ||
    isUcscHost(host)
  );
}

function isUcscHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'ucsc.edu' || host.endsWith('.ucsc.edu');
}

export function ncbiAssemblyPackageDownloadUrl(accession: string): string {
  if (!EXACT_ACCESSION.test(accession)) {
    throw new Error(PASTE_HINT);
  }
  const parameters = new URLSearchParams();
  parameters.append('include_annotation_type', 'GENOME_FASTA');
  parameters.append('include_annotation_type', 'GENOME_GFF');
  parameters.set('filename', `${accession}.zip`);
  return `https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/${accession}/download?${parameters.toString()}`;
}

export async function downloadWithOfficeResources(
  url: string,
  destinationPath: string
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('office-resources', ['download', url, '--output', destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `NCBI assembly download failed (${String(code)}).`));
    });
  });
}

export async function acquireNcbiAssemblyPackage(input: {
  readonly link: string;
  readonly download?: (url: string, destinationPath: string) => Promise<void>;
}): Promise<{
  readonly accession: string;
  readonly directoryPath: string;
  readonly packagePath: string;
}> {
  const { accession } = parseNcbiAssemblyLink(input.link);
  const directoryPath = await mkdtemp(join(tmpdir(), `dnaforge-ncbi-assembly-${accession}-`));
  const packagePath = join(directoryPath, `${accession}.zip`);
  try {
    await (input.download ?? downloadWithOfficeResources)(
      ncbiAssemblyPackageDownloadUrl(accession),
      packagePath
    );
  } catch (error) {
    const names = await readdir(directoryPath).catch(() => [] as string[]);
    if (!names.some((name) => name.endsWith('.part'))) {
      await rm(directoryPath, { recursive: true, force: true });
    }
    throw error;
  }
  return { accession, directoryPath, packagePath };
}
