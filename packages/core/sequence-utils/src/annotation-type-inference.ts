const GENERIC_TYPES = new Set(['misc_feature', 'misc_feature ', '']);

const LABEL_RULES: Array<{ type: string; test: RegExp }> = [
  { type: 'CDS', test: /\bCDS\b/i },
  { type: 'mRNA', test: /\bmRNA\b/i },
  { type: 'tRNA', test: /\btRNA\b/i },
  { type: 'rRNA', test: /\brRNA\b/i },
  { type: 'snoRNA', test: /\bsnoRNA\b/i },
  { type: 'snRNA', test: /\bsnRNA\b/i },
  { type: 'ncRNA', test: /\bnc ?RNA\b/i },
  { type: 'gene', test: /\bgene\b/i },
  { type: 'rep_origin', test: /\bARS\d|autonomously replicating|origin of replication\b/i },
  { type: 'telomere', test: /\btelomer|^TEL\d|\bTEL0\d/i },
  { type: 'centromere', test: /\bcentromer|\bCEN\d\b/i },
  { type: 'LTR', test: /\blong terminal repeat\b|\bLTR\b|\bTy\d|retrotransposon/i },
  { type: 'mobile_element', test: /\btransposon\b|\bmobile element\b/i },
  { type: 'promoter', test: /\bpromoter\b/i },
  { type: 'terminator', test: /\bterminator\b/i },
  { type: 'regulatory', test: /\bregulatory\b|\benhancer\b/i },
  { type: 'repeat_region', test: /\brepeat\b/i },
];

export function inferFeatureTypeFromLabel(rawType: string, label: string | undefined): string {
  if (!GENERIC_TYPES.has(rawType)) return rawType;
  if (!label) return rawType;
  for (const rule of LABEL_RULES) {
    if (rule.test.test(label)) return rule.type;
  }
  return rawType;
}
