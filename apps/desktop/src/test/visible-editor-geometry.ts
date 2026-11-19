import { vi } from 'vitest';

export function installVisibleEditorGeometry(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const bounds = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function () {
      if (this.matches('[data-decoration-id], [data-entity-query]')) return new DOMRect(120, 120, 80, 24);
      return original.call(this);
    });
  const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1200);
  const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  return () => {
    bounds.mockRestore();
    width.mockRestore();
    height.mockRestore();
  };
}
