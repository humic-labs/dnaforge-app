export function contentOverflowsX(el: HTMLElement, epsilonPx = 1): boolean {
  return el.scrollWidth > el.clientWidth + epsilonPx;
}

export function contentOverflowsY(el: HTMLElement, epsilonPx = 1): boolean {
  return el.scrollHeight > el.clientHeight + epsilonPx;
}
