export interface FragmentColor {
  hex: string;
  text: string;
  bg: string;
}

export type AssemblyColorSchemeId =
  | 'tailwind'
  | 'radix'
  | 'carbon'
  | 'category10'
  | 'observable'
  | 'material'
  | 'okabeIto';

export interface AssemblyColorScheme {
  id: AssemblyColorSchemeId;
  label: string;
  description: string;
  source: string;
  colors: FragmentColor[];
}

export const DEFAULT_ASSEMBLY_COLOR_SCHEME: AssemblyColorSchemeId = 'tailwind';

function color(hex: string, text: string, bg: string): FragmentColor {
  return { hex, text, bg };
}

const TAILWIND_FRAGMENT_COLORS: FragmentColor[] = [
  color('#3b82f6', 'text-blue-600 dark:text-blue-400', 'bg-blue-500/10'),
  color('#10b981', 'text-emerald-600 dark:text-emerald-400', 'bg-emerald-500/10'),
  color('#f59e0b', 'text-amber-600 dark:text-amber-400', 'bg-amber-500/10'),
  color('#ef4444', 'text-red-600 dark:text-red-400', 'bg-red-500/10'),
  color('#8b5cf6', 'text-violet-600 dark:text-violet-400', 'bg-violet-500/10'),
  color('#06b6d4', 'text-cyan-600 dark:text-cyan-400', 'bg-cyan-500/10'),
  color('#f97316', 'text-orange-600 dark:text-orange-400', 'bg-orange-500/10'),
  color('#84cc16', 'text-lime-600 dark:text-lime-400', 'bg-lime-500/10'),
];

const RADIX_FRAGMENT_COLORS: FragmentColor[] = [
  color('#0090ff', 'text-blue-600 dark:text-blue-400', 'bg-blue-500/10'),
  color('#30a46c', 'text-emerald-600 dark:text-emerald-400', 'bg-emerald-500/10'),
  color('#ffc53d', 'text-amber-600 dark:text-amber-400', 'bg-amber-500/10'),
  color('#e5484d', 'text-red-600 dark:text-red-400', 'bg-red-500/10'),
  color('#8e4ec6', 'text-purple-600 dark:text-purple-400', 'bg-purple-500/10'),
  color('#00a2c7', 'text-cyan-600 dark:text-cyan-400', 'bg-cyan-500/10'),
  color('#f76b15', 'text-orange-600 dark:text-orange-400', 'bg-orange-500/10'),
  color('#99d52a', 'text-lime-600 dark:text-lime-400', 'bg-lime-500/10'),
];

const CARBON_FRAGMENT_COLORS: FragmentColor[] = [
  color('#6929c4', 'text-purple-600 dark:text-purple-400', 'bg-purple-500/10'),
  color('#1192e8', 'text-sky-600 dark:text-sky-400', 'bg-sky-500/10'),
  color('#005d5d', 'text-teal-700 dark:text-teal-400', 'bg-teal-500/10'),
  color('#9f1853', 'text-pink-700 dark:text-pink-400', 'bg-pink-500/10'),
  color('#fa4d56', 'text-red-600 dark:text-red-400', 'bg-red-500/10'),
  color('#198038', 'text-green-700 dark:text-green-400', 'bg-green-500/10'),
  color('#002d9c', 'text-blue-800 dark:text-blue-400', 'bg-blue-500/10'),
  color('#ee538b', 'text-rose-600 dark:text-rose-400', 'bg-rose-500/10'),
];

const CATEGORY10_FRAGMENT_COLORS: FragmentColor[] = [
  color('#1f77b4', 'text-blue-700 dark:text-blue-400', 'bg-blue-500/10'),
  color('#ff7f0e', 'text-orange-600 dark:text-orange-400', 'bg-orange-500/10'),
  color('#2ca02c', 'text-green-700 dark:text-green-400', 'bg-green-500/10'),
  color('#d62728', 'text-red-700 dark:text-red-400', 'bg-red-500/10'),
  color('#9467bd', 'text-purple-600 dark:text-purple-400', 'bg-purple-500/10'),
  color('#8c564b', 'text-stone-700 dark:text-stone-400', 'bg-stone-500/10'),
  color('#e377c2', 'text-pink-600 dark:text-pink-400', 'bg-pink-500/10'),
  color('#7f7f7f', 'text-neutral-600 dark:text-neutral-400', 'bg-neutral-500/10'),
  color('#bcbd22', 'text-lime-700 dark:text-lime-400', 'bg-lime-500/10'),
  color('#17becf', 'text-cyan-600 dark:text-cyan-400', 'bg-cyan-500/10'),
];

const OBSERVABLE_FRAGMENT_COLORS: FragmentColor[] = [
  color('#4269d0', 'text-blue-700 dark:text-blue-400', 'bg-blue-500/10'),
  color('#efb118', 'text-amber-600 dark:text-amber-400', 'bg-amber-500/10'),
  color('#ff725c', 'text-red-600 dark:text-red-400', 'bg-red-500/10'),
  color('#6cc5b0', 'text-teal-600 dark:text-teal-400', 'bg-teal-500/10'),
  color('#3ca951', 'text-green-600 dark:text-green-400', 'bg-green-500/10'),
  color('#ff8ab7', 'text-pink-600 dark:text-pink-400', 'bg-pink-500/10'),
  color('#a463f2', 'text-violet-600 dark:text-violet-400', 'bg-violet-500/10'),
  color('#97bbf5', 'text-sky-600 dark:text-sky-400', 'bg-sky-500/10'),
  color('#9c6b4e', 'text-stone-600 dark:text-stone-400', 'bg-stone-500/10'),
  color('#9498a0', 'text-slate-600 dark:text-slate-400', 'bg-slate-500/10'),
];

const MATERIAL_FRAGMENT_COLORS: FragmentColor[] = [
  color('#2196f3', 'text-blue-600 dark:text-blue-400', 'bg-blue-500/10'),
  color('#4caf50', 'text-green-600 dark:text-green-400', 'bg-green-500/10'),
  color('#ffc107', 'text-amber-600 dark:text-amber-400', 'bg-amber-500/10'),
  color('#f44336', 'text-red-600 dark:text-red-400', 'bg-red-500/10'),
  color('#673ab7', 'text-violet-700 dark:text-violet-400', 'bg-violet-500/10'),
  color('#00bcd4', 'text-cyan-600 dark:text-cyan-400', 'bg-cyan-500/10'),
  color('#ff9800', 'text-orange-600 dark:text-orange-400', 'bg-orange-500/10'),
  color('#cddc39', 'text-lime-600 dark:text-lime-400', 'bg-lime-500/10'),
];

const OKABE_ITO_FRAGMENT_COLORS: FragmentColor[] = [
  color('#0072b2', 'text-blue-700 dark:text-blue-400', 'bg-blue-500/10'),
  color('#e69f00', 'text-amber-700 dark:text-amber-400', 'bg-amber-500/10'),
  color('#009e73', 'text-emerald-700 dark:text-emerald-400', 'bg-emerald-500/10'),
  color('#d55e00', 'text-orange-700 dark:text-orange-400', 'bg-orange-500/10'),
  color('#56b4e9', 'text-sky-600 dark:text-sky-400', 'bg-sky-500/10'),
  color('#cc79a7', 'text-pink-600 dark:text-pink-400', 'bg-pink-500/10'),
  color('#f0e442', 'text-yellow-700 dark:text-yellow-300', 'bg-yellow-500/10'),
  color('#8f9499', 'text-slate-600 dark:text-slate-400', 'bg-slate-500/10'),
];

export const ASSEMBLY_COLOR_SCHEMES: Record<AssemblyColorSchemeId, AssemblyColorScheme> = {
  tailwind: {
    id: 'tailwind',
    label: 'Tailwind',
    description: 'Crisp, saturated UI colors that stay vivid on light and dark surfaces.',
    source: 'Tailwind default palette',
    colors: TAILWIND_FRAGMENT_COLORS,
  },
  radix: {
    id: 'radix',
    label: 'Radix',
    description: 'Clean app accents from Radix color scales; slightly calmer than Tailwind.',
    source: 'Radix Colors accent scales',
    colors: RADIX_FRAGMENT_COLORS,
  },
  carbon: {
    id: 'carbon',
    label: 'Carbon',
    description: 'Enterprise data-viz colors optimized for categorical contrast.',
    source: 'IBM Carbon categorical palette',
    colors: CARBON_FRAGMENT_COLORS,
  },
  category10: {
    id: 'category10',
    label: 'Category 10',
    description: 'Classic D3 categorical palette with stronger contrast than Tableau 10.',
    source: 'D3 Category 10 scheme',
    colors: CATEGORY10_FRAGMENT_COLORS,
  },
  observable: {
    id: 'observable',
    label: 'Observable',
    description: 'Modern notebook/data palette with strong contrast and softer edges.',
    source: 'D3 Observable 10 categorical scheme',
    colors: OBSERVABLE_FRAGMENT_COLORS,
  },
  material: {
    id: 'material',
    label: 'Material',
    description: 'Google Material 500-level colors: direct, bright, and familiar.',
    source: 'Material Design color palette',
    colors: MATERIAL_FRAGMENT_COLORS,
  },
  okabeIto: {
    id: 'okabeIto',
    label: 'Okabe-Ito',
    description: 'Colorblind-safe scientific palette adapted for dark app surfaces.',
    source: 'Okabe-Ito colorblind-safe palette',
    colors: OKABE_ITO_FRAGMENT_COLORS,
  },
};

export const ASSEMBLY_COLOR_SCHEME_OPTIONS = Object.values(ASSEMBLY_COLOR_SCHEMES).map(
  ({ id, label, description, source, colors }) => ({
    value: id,
    label,
    description,
    source,
    colors,
  })
);

export function resolveAssemblyColorSchemeId(value: unknown): AssemblyColorSchemeId {
  if (value === 'vivid') return 'tailwind';
  if (value === 'soft') return DEFAULT_ASSEMBLY_COLOR_SCHEME;
  if (value === 'tableau') return 'category10';
  return typeof value === 'string' && value in ASSEMBLY_COLOR_SCHEMES
    ? (value as AssemblyColorSchemeId)
    : DEFAULT_ASSEMBLY_COLOR_SCHEME;
}

export function getAssemblyColorScheme(
  schemeId: AssemblyColorSchemeId = DEFAULT_ASSEMBLY_COLOR_SCHEME
): AssemblyColorScheme {
  return ASSEMBLY_COLOR_SCHEMES[resolveAssemblyColorSchemeId(schemeId)];
}
