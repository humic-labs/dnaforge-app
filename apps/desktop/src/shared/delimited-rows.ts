export function parseDelimitedRows(
  text: string,
  delimiter: ',' | '\t',
  options: { skipEmptyLines?: boolean } = {}
): { ok: true; rows: string[][] } | { ok: false; error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStartedWithQuote = false;
  let rowHasInput = false;

  const pushField = () => {
    row.push(field);
    field = '';
    fieldStartedWithQuote = false;
  };

  const pushRow = () => {
    pushField();
    if (!options.skipEmptyLines || rowHasInput) rows.push(row);
    row = [];
    rowHasInput = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (char !== '\n' && char !== '\r') rowHasInput = true;

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      pushField();
      continue;
    }

    if (char === '\n') {
      pushRow();
      continue;
    }

    if (char === '\r') {
      if (nextChar === '\n') i++;
      pushRow();
      continue;
    }

    if (fieldStartedWithQuote) {
      return { ok: false, error: 'Unexpected text after closing quote.' };
    }

    if (char === '"') {
      if (field.length !== 0) return { ok: false, error: 'Unexpected quote in an unquoted field.' };
      inQuotes = true;
      fieldStartedWithQuote = true;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    return { ok: false, error: 'Unterminated quoted field.' };
  }

  pushField();
  if (rowHasInput || row.length > 1 || row.some((cell) => cell.trim() !== '')) {
    rows.push(row);
  }

  return { ok: true, rows };
}
