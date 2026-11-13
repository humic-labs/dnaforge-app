export interface MarkdownBlockSegment {
  key: string;
  source: string;
  completed: boolean;
  startOffset: number;
  endOffset: number;
}

interface Fence {
  marker: '`' | '~';
  length: number;
}

function fenceAt(line: string): Fence | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  return {
    marker: match[1][0] as Fence['marker'],
    length: match[1].length,
  };
}

function hasUnescapedPipe(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue;
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) return true;
  }
  return false;
}

function isTableDelimiterRow(line: string): boolean {
  const multiColumn = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;
  const singleColumn = /^[ \t]*\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/;
  return multiColumn.test(line) || singleColumn.test(line);
}

export function containsGfmTable(source: string): boolean {
  const lines = source.split(/\r?\n/);
  let fence: Fence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const candidate = fenceAt(line);
    if (candidate) {
      if (!fence) {
        fence = candidate;
        continue;
      }
      if (
        candidate.marker === fence.marker &&
        candidate.length >= fence.length &&
        line.trim() === candidate.marker.repeat(candidate.length)
      ) {
        fence = null;
      }
      continue;
    }

    if (fence) continue;
    if (
      hasUnescapedPipe(line) &&
      index + 1 < lines.length &&
      isTableDelimiterRow(lines[index + 1])
    ) {
      return true;
    }
  }

  return false;
}

export function splitMarkdownBlocks(source: string): MarkdownBlockSegment[] {
  if (source.length === 0) return [];

  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [source];
  const blocks: MarkdownBlockSegment[] = [];
  let buffer = '';
  let bufferStart = 0;
  let consumed = 0;
  let fence: Fence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    buffer += line;
    consumed += line.length;

    const candidate = fenceAt(line);
    if (candidate) {
      if (!fence) {
        fence = candidate;
      } else if (
        candidate.marker === fence.marker &&
        candidate.length >= fence.length &&
        line.trim() === candidate.marker.repeat(candidate.length)
      ) {
        fence = null;
      }
    }

    if (fence || line.trim().length > 0) continue;

    while (index + 1 < lines.length && lines[index + 1].trim().length === 0) {
      index += 1;
      buffer += lines[index];
      consumed += lines[index].length;
    }
    blocks.push({
      key: `markdown-block-${blocks.length}`,
      source: buffer,
      completed: true,
      startOffset: bufferStart,
      endOffset: consumed,
    });
    buffer = '';
    bufferStart = consumed;
  }

  if (buffer.length > 0) {
    blocks.push({
      key: `markdown-block-${blocks.length}`,
      source: buffer,
      completed: false,
      startOffset: bufferStart,
      endOffset: consumed,
    });
  }

  return blocks;
}
