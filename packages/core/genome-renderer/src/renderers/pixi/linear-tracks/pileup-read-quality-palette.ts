export type PileupReadQualityTheme = 'light' | 'dark';
export type PileupReadQualityRgb = readonly [red: number, green: number, blue: number];

export const PILEUP_READ_BODY_COLOR_BY_THEME = {
  light: 0xa8ceff,
  dark: 0x1d4ed8,
} as const;

function rgbFromNumber(color: number): PileupReadQualityRgb {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

export const PILEUP_READ_QUALITY_STOPS = [
  {
    label: 'Q0',
    score: 0,
    colors: { light: [221, 44, 44], dark: [221, 44, 44] },
  },
  {
    label: '10',
    score: 10,
    colors: { light: [233, 100, 12], dark: [233, 100, 12] },
  },
  {
    label: '20',
    score: 20,
    colors: { light: [206, 150, 9], dark: [206, 150, 9] },
  },
  {
    label: '30',
    score: 30,
    colors: { light: [56, 159, 76], dark: [56, 159, 76] },
  },
  {
    label: '40+',
    score: 40,
    colors: {
      light: rgbFromNumber(PILEUP_READ_BODY_COLOR_BY_THEME.dark),
      dark: rgbFromNumber(PILEUP_READ_BODY_COLOR_BY_THEME.dark),
    },
  },
] as const;

export const PILEUP_READ_QUALITY_MAX_SCORE =
  PILEUP_READ_QUALITY_STOPS[PILEUP_READ_QUALITY_STOPS.length - 1].score;

export function pileupReadQualityRgb(
  score: number,
  theme: PileupReadQualityTheme
): PileupReadQualityRgb {
  const bounded = Math.max(0, Math.min(PILEUP_READ_QUALITY_MAX_SCORE, score));
  const upperIndex = PILEUP_READ_QUALITY_STOPS.findIndex((stop) => stop.score >= bounded);
  const upperStop = PILEUP_READ_QUALITY_STOPS[Math.max(0, upperIndex)]!;
  const lowerStop = PILEUP_READ_QUALITY_STOPS[Math.max(0, upperIndex - 1)]!;
  const upper = upperStop.colors[theme];
  const lower = lowerStop.colors[theme];
  const span = upperStop.score - lowerStop.score;
  const ratio = span > 0 ? (bounded - lowerStop.score) / span : 0;
  return lower.map((channel, index) => Math.round(channel + (upper[index]! - channel) * ratio)) as [
    number,
    number,
    number,
  ];
}

export function pileupReadQualityCss(score: number, theme: PileupReadQualityTheme): string {
  return `rgb(${pileupReadQualityRgb(score, theme).join(', ')})`;
}

export function pileupReadQualityColorNumber(score: number, theme: PileupReadQualityTheme): number {
  const [red, green, blue] = pileupReadQualityRgb(score, theme);
  return (red << 16) | (green << 8) | blue;
}

export function pileupReadQualityGradientCss(theme: PileupReadQualityTheme): string {
  return `linear-gradient(to right, ${PILEUP_READ_QUALITY_STOPS.map(
    (stop) =>
      `${pileupReadQualityCss(stop.score, theme)} ${(stop.score / PILEUP_READ_QUALITY_MAX_SCORE) * 100}%`
  ).join(', ')})`;
}
