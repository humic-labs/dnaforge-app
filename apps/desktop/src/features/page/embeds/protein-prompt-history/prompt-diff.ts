export type PromptChange = { kind: 'unchanged' | 'added' | 'removed'; lines: string[] };

export function diffRecordedPrompt(before: string, after: string): PromptChange[] {
  if (before === after) return [{ kind: 'unchanged', lines: before.split('\n') }];
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix);
  const right = b.slice(prefix, b.length - suffix);
  const changes: PromptChange[] = [];
  const append = (kind: PromptChange['kind'], lines: string[]) => {
    if (!lines.length) return;
    const last = changes[changes.length - 1];
    if (last?.kind === kind) last.lines.push(...lines);
    else changes.push({ kind, lines: [...lines] });
  };
  append('unchanged', a.slice(0, prefix));
  if (left.length * right.length > 4_000_000) {
    append('removed', left);
    append('added', right);
  } else {
    const width = right.length + 1;
    const lengths = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        lengths[i * width + j] =
          left[i] === right[j]
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        append('unchanged', [left[i++]]);
        j++;
      } else if (
        i < left.length &&
        (j === right.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
      ) {
        append('removed', [left[i++]]);
      } else append('added', [right[j++]]);
    }
  }
  append('unchanged', a.slice(a.length - suffix));
  return changes;
}
