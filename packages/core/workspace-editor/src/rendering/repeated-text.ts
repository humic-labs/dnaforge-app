import type { SequenceDrawingContext } from './drawing-context';

export function repeatedTextPainter(ctx: SequenceDrawingContext, y: number) {
  if (!ctx.prepareRepeatedText) return (text: string, x: number) => ctx.fillText(text, x, y);
  const glyphs = new Map<string, ((x: number) => void) | null>();
  return (text: string, x: number) => {
    let paint = glyphs.get(text);
    if (paint === undefined) {
      paint = ctx.prepareRepeatedText!(text, y);
      glyphs.set(text, paint);
    }
    if (paint) paint(x);
    else ctx.fillText(text, x, y);
  };
}
