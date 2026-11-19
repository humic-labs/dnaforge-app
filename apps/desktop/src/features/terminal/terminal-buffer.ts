import type { IBuffer } from '@xterm/xterm';

export function terminalBufferText(buffer: IBuffer, start = 0, end = buffer.length): string {
  let text = '';
  for (let index = start; index < end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > start && !line.isWrapped) text += '\n';
    text += line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
  }
  return text;
}
