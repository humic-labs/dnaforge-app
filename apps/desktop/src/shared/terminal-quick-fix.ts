export type TerminalQuickFix =
  | { kind: 'command'; command: string }
  | { kind: 'link'; url: string }
  | { kind: 'port'; port: number };

export interface TerminalPortRelease {
  token: string;
  port: number;
  terminalTitle: string;
}

export function terminalOccupiedPorts(output: string): number[] {
  const pattern =
    /(?:address already in use (?:0\.0\.0\.0|127\.0\.0\.1|localhost|::):|Unable to bind [^ ]*:|can't listen on port |listen EADDRINUSE [^ ]*:)(\d{1,5})(?!\d)/g;
  const bounded = output
    .slice(-64_000)
    .replace(/\r/g, '')
    .trimEnd()
    .split('\n')
    .slice(-30)
    .join('\n');
  return [...new Set([...bounded.matchAll(pattern)].map((match) => Number(match[1])))].filter(
    (port) => port > 0 && port <= 65535
  );
}
