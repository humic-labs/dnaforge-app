import { readSequenceFileGuarded } from '../../sequence/public/utils/guarded-read';

async function sha256Hex(value: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeReferenceHash(referencePath: string): Promise<string | null> {
  try {
    const content = await readSequenceFileGuarded(referencePath);
    const hashHex = await sha256Hex(content);
    return `sha256:${hashHex}`;
  } catch {
    return null;
  }
}

export async function computePairwiseQueryId(
  sessionId: string,
  queryPath: string
): Promise<string> {
  const canonical = JSON.stringify({ contract: 1, sessionId, queryPath });
  return `pairwise-query:${await sha256Hex(canonical)}`;
}

function normalizeNucleicSequence(sequence: string): string {
  return sequence.replace(/\s/g, '').toUpperCase();
}

export async function computePairwiseReferenceRevision(sequence: string): Promise<string> {
  const digest = await sha256Hex(JSON.stringify(normalizeNucleicSequence(sequence)));
  return `pairwise-reference-v1:sha256:${digest}`;
}

export async function computePairwiseQueryRevision(sequence: string): Promise<string> {
  const digest = await sha256Hex(JSON.stringify(normalizeNucleicSequence(sequence)));
  return `pairwise-query-v1:sha256:${digest}`;
}

export async function computePairwiseSessionSubjectId(
  documentId: string,
  sessionId: string
): Promise<string> {
  return `pairwise-session-alignment-subject-v1:sha256:${await sha256Hex(JSON.stringify({ document_id: documentId, session_id: sessionId }))}`;
}
