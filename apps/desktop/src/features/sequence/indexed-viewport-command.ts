export interface IndexedViewportCommand {
  id: number;
  chrom: string;
  start0: number;
  end0: number;
}

export interface IndexedViewportApply {
  chrom: string;
  start0: number;
  end0: number;
}

export interface IndexedAssemblyCoordinates {
  chromosomes: ReadonlyArray<{
    chrom: string;
    length: number;
  }>;
}

export interface IndexedRendererViewport {
  chrom: string;
  start: number;
  end: number;
}

export function normalizeIndexedViewportForPersistence(
  range: Readonly<{ start: number; end: number }> | null,
  length: number
): { start0: number; end0: number } | null {
  if (!range || length <= 0 || !Number.isFinite(range.start) || !Number.isFinite(range.end)) {
    return null;
  }
  const snapRoundoff = (value: number): number => {
    const integer = Math.round(value);
    const roundoff = Number.EPSILON * Math.max(1, Math.abs(value)) * 2;
    return Math.abs(value - integer) <= roundoff ? integer : value;
  };
  const start0 = Math.max(
    0,
    Math.min(Math.max(0, length - 1), Math.floor(snapRoundoff(range.start)))
  );
  const end0 = Math.max(start0 + 1, Math.min(length, Math.ceil(snapRoundoff(range.end))));
  return { start0, end0 };
}

export function takeIndexedViewportCommand(
  lastCommandId: number | null,
  command?: IndexedViewportCommand | null
): IndexedViewportApply | null {
  if (!command || command.id === lastCommandId) return null;
  if (command.chrom.trim().length === 0) return null;
  if (command.start0 < 0 || command.end0 <= command.start0) return null;
  return { chrom: command.chrom, start0: command.start0, end0: command.end0 };
}

function chromosomeGlobalStart(
  chrom: string,
  assembly?: IndexedAssemblyCoordinates
): number | null {
  if (!assembly) return 0;
  let offset = 0;
  for (const chromosome of assembly.chromosomes) {
    if (chromosome.chrom === chrom) return offset;
    offset += chromosome.length;
  }
  return null;
}

export function projectIndexedViewportCommand(
  command: IndexedViewportApply,
  assembly?: IndexedAssemblyCoordinates
): IndexedRendererViewport | null {
  const offset = chromosomeGlobalStart(command.chrom, assembly);
  if (offset === null) return null;
  return {
    chrom: command.chrom,
    start: offset + command.start0,
    end: offset + command.end0,
  };
}

export function projectIndexedLiveViewport(
  chrom: string,
  range: Readonly<{ start: number; end: number }>,
  assembly?: IndexedAssemblyCoordinates
): IndexedViewportApply | null {
  const offset = chromosomeGlobalStart(chrom, assembly);
  if (offset === null) return null;
  const chromosome = assembly?.chromosomes.find((candidate) => candidate.chrom === chrom);
  return projectChromosomeRange(chrom, range, offset, chromosome?.length);
}

function projectChromosomeRange(
  chrom: string,
  range: Readonly<{ start: number; end: number }>,
  offset: number,
  chromosomeLength?: number
): IndexedViewportApply | null {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
    return null;
  }
  const roundoff = Number.EPSILON * Math.max(1, Math.abs(range.start), Math.abs(range.end)) * 2;
  const localStart = range.start - offset;
  const localEnd = range.end - offset;
  const start0 = localStart < 0 && localStart >= -roundoff ? 0 : localStart;
  const end0 =
    chromosomeLength !== undefined &&
    localEnd > chromosomeLength &&
    localEnd <= chromosomeLength + roundoff
      ? chromosomeLength
      : localEnd;
  if (start0 < 0 || end0 <= start0) return null;
  if (chromosomeLength !== undefined && end0 > chromosomeLength) return null;
  return { chrom, start0, end0 };
}

export function projectIndexedAssemblyLiveViewport(
  range: Readonly<{ start: number; end: number }>,
  assembly: IndexedAssemblyCoordinates
): IndexedViewportApply | null {
  let offset = 0;
  for (const chromosome of assembly.chromosomes) {
    const projected = projectChromosomeRange(chromosome.chrom, range, offset, chromosome.length);
    if (projected) return projected;
    offset += chromosome.length;
  }
  return null;
}
