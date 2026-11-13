export const JETBRAINS_MONO_FONT_NAME = 'JetBrains Mono';

export const SEQUENCE_FONT_FAMILY = `"${JETBRAINS_MONO_FONT_NAME}", "SF Mono", "Fira Code", monospace`;
export const SEQUENCE_FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type SequenceFontSources = Record<(typeof SEQUENCE_FONT_WEIGHTS)[number], string>;

let sequenceFontSources: SequenceFontSources | undefined;

export function configureSequenceFonts(sources: SequenceFontSources): void {
  sequenceFontSources = sources;
}

export function getSequenceFontSources(): SequenceFontSources | undefined {
  return sequenceFontSources;
}

interface SequenceFontFace {
  family: string;
  weight: string;
  style: string;
  status: string;
  load(): Promise<unknown>;
}

export async function loadSequenceFonts<TFace extends SequenceFontFace>(
  fonts: { forEach(callback: (face: TFace) => void): void; add(face: TFace): unknown },
  sources: SequenceFontSources | undefined,
  createFace: (source: string, weight: string) => TFace
): Promise<void> {
  if (!sources) throw new Error('Sequence font assets have not been configured.');
  const faces: TFace[] = [];
  fonts.forEach((face) => {
    if (face.family.replace(/['"]/g, '') === JETBRAINS_MONO_FONT_NAME) faces.push(face);
  });
  await Promise.all(
    SEQUENCE_FONT_WEIGHTS.map(async (weight) => {
      if (!sources[weight]) throw new Error(`Missing bundled sequence font: ${weight}.`);
      const matches = faces.filter(
        (face) => face.weight === String(weight) && face.style === 'normal'
      );
      if (matches.length > 1)
        throw new Error(`Conflicting sequence font registrations: ${weight}.`);
      const face = matches[0] ?? createFace(sources[weight], String(weight));
      if (!matches.length) fonts.add(face);
      try {
        await face.load();
      } catch {
        throw new Error(`Bundled sequence font could not load: ${weight}.`);
      }
      if (face.status !== 'loaded') throw new Error(`Sequence font is not ready: ${weight}.`);
    })
  );
}
