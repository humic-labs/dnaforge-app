export function inventoryCodeInput(raw: string) {
  const terminator = raw.endsWith('\r\n')
    ? 'CRLF'
    : raw.endsWith('\n')
      ? 'LF'
      : raw.endsWith('\r')
        ? 'CR'
        : null;
  return {
    raw,
    value: terminator ? raw.slice(0, terminator === 'CRLF' ? -2 : -1) : raw,
    terminator,
  };
}

export function inventoryRawTextOffset(raw: string, offset: number) {
  let index = 0;
  for (let normalized = 0; normalized < offset && index < raw.length; normalized += 1)
    index += raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
  return index;
}
