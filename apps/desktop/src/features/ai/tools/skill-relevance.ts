import type { AgentManagedSkill } from '../../../shared/agent-capability-controls';

type SkillDescriptor = Pick<AgentManagedSkill, 'name' | 'description'> & {
  source: Pick<NonNullable<AgentManagedSkill['source']>, 'publisher' | 'packName'> | null;
};

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function searchTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function tokenScore(
  queryToken: string,
  candidateTokens: readonly string[],
  weights: {
    exact: number;
    prefix: number;
  }
): number {
  if (candidateTokens.includes(queryToken)) return weights.exact;
  return candidateTokens.some(
    (candidate) => candidate.startsWith(queryToken) || queryToken.startsWith(candidate)
  )
    ? weights.prefix
    : 0;
}

export function matchScore(skill: SkillDescriptor, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const name = normalizeSearchText(skill.name);
  const description = normalizeSearchText(skill.description);
  const source = normalizeSearchText(
    skill.source ? `${skill.source.publisher} ${skill.source.packName}` : 'DNAForge local skill'
  );
  const queryTokens = searchTokens(query);
  const nameTokens = searchTokens(skill.name);
  const descriptionTokens = searchTokens(skill.description);
  const sourceTokens = searchTokens(source);

  let score = 0;
  if (name === normalizedQuery) score += 1_000;
  else if (name.includes(normalizedQuery)) score += 250;
  if (description.includes(normalizedQuery)) score += 120;
  for (const token of queryTokens) {
    score += tokenScore(token, nameTokens, { exact: 50, prefix: 35 });
    score += tokenScore(token, descriptionTokens, { exact: 12, prefix: 7 });
    score += tokenScore(token, sourceTokens, { exact: 3, prefix: 0 });
  }
  return score;
}
