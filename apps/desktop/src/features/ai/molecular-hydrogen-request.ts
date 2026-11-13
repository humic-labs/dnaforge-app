const requests = new Map<string, string>();

export function explicitHydrogenAtomRequest(content: string): string | undefined {
  for (const sentence of content.split(/[.!?;\n]+/)) {
    const text = sentence.trim();
    if (
      /["'“”‘’`]|\b(?:not|never|hide|omit|exclude|without|unless|if|why|did|don't|do not)\b/i.test(
        text
      )
    )
      continue;
    if (
      /^(?:(?:please|now|also)\s+|(?:can|could|would|will)\s+you\s+)*(?:show|display|include|draw|render|reveal|enable)\b[^.!?;\n]{0,120}\b(?:hydrogen\s+atoms?|hydrogens)\b/i.test(
        text
      )
    )
      return text.slice(0, 500);
  }
  return undefined;
}

export function registerMolecularHydrogenRequest(turnId: string, content: string): () => void {
  requests.delete(turnId);
  const request = explicitHydrogenAtomRequest(content);
  if (request) requests.set(turnId, request);
  while (requests.size > 128) requests.delete(requests.keys().next().value!);
  return () => requests.delete(turnId);
}

export function molecularHydrogenRequestForTurn(turnId?: string): string | undefined {
  return turnId ? requests.get(turnId) : undefined;
}
