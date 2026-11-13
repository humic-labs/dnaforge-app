export function bindMolstarCanvasCursor(canvas: HTMLCanvasElement): () => void {
  const original = canvas.style.cursor;
  let down: { x: number; y: number; id: number } | null = null;
  const clear = () => {
    down = null;
    canvas.style.cursor = 'default';
  };
  const press = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    down = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const move = (event: PointerEvent) => {
    if (event.buttons === 0) return clear();
    if (!down || event.pointerId !== down.id) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 3)
      canvas.style.cursor = 'grabbing';
  };
  clear();
  canvas.addEventListener('pointerdown', press);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', clear, true);
  window.addEventListener('pointercancel', clear, true);
  window.addEventListener('blur', clear);
  return () => {
    canvas.removeEventListener('pointerdown', press);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', clear, true);
    window.removeEventListener('pointercancel', clear, true);
    window.removeEventListener('blur', clear);
    down = null;
    canvas.style.cursor = original;
  };
}
