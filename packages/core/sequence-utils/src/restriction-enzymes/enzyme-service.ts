import type { RestrictionEnzyme, EnzymeDataFile, VendorCode } from './types';

let cachedEnzymes: RestrictionEnzyme[] | null = null;
let cachedNebEnzymes: RestrictionEnzyme[] | null = null;

type HostedBrowserGlobals = {
  document?: {
    documentElement?: { dataset?: { dnaforgeRuntime?: string } };
  };
  location?: {
    origin?: string;
    pathname?: string;
    protocol?: string;
  };
};

function dataUrl(absPath: string): string {
  const normalizedPath = absPath.replace(/^\/+/u, '');
  const globals = globalThis as typeof globalThis & HostedBrowserGlobals;
  const runtime = globals.document?.documentElement?.dataset?.dnaforgeRuntime;
  const protocol = globals.location?.protocol;
  const origin = globals.location?.origin;
  if (runtime === 'hosted-browser' && (protocol === 'http:' || protocol === 'https:') && origin) {
    const pathname = globals.location?.pathname ?? '/';
    const basePath =
      pathname === '/hosted.html' || pathname.startsWith('/hosted/') ? '/hosted/' : '/';
    return new URL(normalizedPath, `${origin}${basePath}`).toString();
  }

  return `./${normalizedPath}`;
}

export async function loadAllEnzymes(): Promise<RestrictionEnzyme[]> {
  if (cachedEnzymes) {
    return cachedEnzymes;
  }

  const response = await fetch(dataUrl('/data/rebase/merged-enzymes.json'));
  if (!response.ok) {
    throw new Error(`Failed to load enzyme data: ${response.statusText}`);
  }

  const data = (await response.json()) as EnzymeDataFile;
  cachedEnzymes = data.enzymes;
  return cachedEnzymes;
}

export async function loadNebEnzymes(): Promise<RestrictionEnzyme[]> {
  if (cachedNebEnzymes) {
    return cachedNebEnzymes;
  }

  const response = await fetch(dataUrl('/data/rebase/neb-enzymes.json'));
  if (!response.ok) {
    throw new Error(`Failed to load NEB enzyme data: ${response.statusText}`);
  }

  const data = (await response.json()) as EnzymeDataFile;
  cachedNebEnzymes = data.enzymes;
  return cachedNebEnzymes;
}

export function filterByVendor(
  enzymes: RestrictionEnzyme[],
  vendorCode: VendorCode
): RestrictionEnzyme[] {
  return enzymes.filter((enzyme) => enzyme.suppliers.some((s) => s.code === vendorCode));
}

export function filterByName(
  enzymes: RestrictionEnzyme[],
  searchTerm: string
): RestrictionEnzyme[] {
  if (!searchTerm.trim()) {
    return enzymes;
  }
  const term = searchTerm.toLowerCase();
  return enzymes.filter((enzyme) => enzyme.name.toLowerCase().includes(term));
}

export function filterByRecognitionSequence(
  enzymes: RestrictionEnzyme[],
  searchTerm: string
): RestrictionEnzyme[] {
  if (!searchTerm.trim()) {
    return enzymes;
  }
  const term = searchTerm.toUpperCase();
  return enzymes.filter((enzyme) => enzyme.recognition_sequence.includes(term));
}

export function searchEnzymes(
  enzymes: RestrictionEnzyme[],
  searchTerm: string
): RestrictionEnzyme[] {
  if (!searchTerm.trim()) {
    return enzymes;
  }
  const term = searchTerm.toLowerCase();
  const termUpper = searchTerm.toUpperCase();

  return enzymes.filter(
    (enzyme) =>
      enzyme.name.toLowerCase().includes(term) ||
      (enzyme.recognition_sequence && enzyme.recognition_sequence.includes(termUpper))
  );
}

export function filterWithKnownCuts(enzymes: RestrictionEnzyme[]): RestrictionEnzyme[] {
  return enzymes.filter(
    (enzyme) => enzyme.cut_position_top !== null && enzyme.cut_position_bottom !== null
  );
}

export function sortByName(enzymes: RestrictionEnzyme[]): RestrictionEnzyme[] {
  return [...enzymes].sort((a, b) => a.name.localeCompare(b.name));
}

export function sortByRecognitionLength(enzymes: RestrictionEnzyme[]): RestrictionEnzyme[] {
  return [...enzymes].sort((a, b) => a.recognition_sequence_length - b.recognition_sequence_length);
}

export function clearEnzymeCache(): void {
  cachedEnzymes = null;
  cachedNebEnzymes = null;
}
