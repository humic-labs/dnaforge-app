import { REF_TOKEN_PATTERN } from './constants';

const ANY_REF_TOKEN_PATTERN = /\[\[ref:[^\]]+\]\]/g;

export interface ExtractedReferences {
  prose: string;
  referenceIds: string[];
}

export function extractMessageReferences(content: string): ExtractedReferences {
  const referenceIds: string[] = [];
  const uuidRe = new RegExp(REF_TOKEN_PATTERN, 'g');
  for (const match of content.matchAll(uuidRe)) {
    if (!referenceIds.includes(match[1])) referenceIds.push(match[1]);
  }

  const stripped = content.replace(ANY_REF_TOKEN_PATTERN, '');
  if (stripped === content) return { prose: content, referenceIds: [] };

  const withoutLegacyCaption = stripped.replace(/\n*[ \t]*Referenced entities:[ \t]*$/i, '');
  const prose = withoutLegacyCaption.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return { prose, referenceIds };
}
