const REDACTIONS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[redacted-private-key]',
  ],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi, '$1:[redacted]@'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g, '[redacted-key]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/\bdna_key_[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]'],
  [/\b(xox[baprse]|xapp)-[A-Za-z0-9-]{10,}\b/g, '[redacted-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]'],
  [
    /\b(authorization|api[_-]?key|access[_-]?token|token|secret|password|passwd|bearer|session(?:id)?)\b(["'\s:=]+)([^\s"',;]{6,})/gi,
    '$1$2[redacted]',
  ],
  [/((?:\/Users|\/home)\/)[^/\s"':]+/g, '$1[redacted-user]'],
  [/([A-Za-z]:\\Users\\)[^\\\s"':]+/g, '$1[redacted-user]'],
];

export function redactSensitive(input: string): string {
  if (!input) return input;
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
