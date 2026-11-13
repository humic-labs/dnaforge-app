import type { TabViewState } from '../canvas/public/types';

export function primerBindingToViewState(bindingStart: number, bindingEnd: number): TabViewState {
  return {
    scrollPosition: bindingStart,
    highlightRange: {
      start: bindingStart - 1,
      end: bindingEnd - 1,
    },
  };
}
