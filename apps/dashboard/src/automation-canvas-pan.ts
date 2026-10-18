import { useRef, useState, type PointerEvent, type RefObject } from 'react';

// Dragging the drawing's empty background moves it, like a hand on paper: the canvas is a
// scrolling box, and the drag scrolls it. A finger already scrolls it, so only a mouse or a
// pen is taken; anything that can be pressed or dragged itself keeps its own press.
const OWN_PRESS =
  'button, a, input, textarea, select, summary, label, [role="button"], [role="menuitem"], [role="option"], [draggable="true"], [data-canvas-box]';

export interface CanvasPan {
  /** True while the background is held, for the closed-hand cursor. */
  readonly panning: boolean;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
}

export function useCanvasPan(scrollerRef: RefObject<HTMLElement | null>): CanvasPan {
  const heldRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const release = (event: PointerEvent<HTMLElement>) => {
    if (heldRef.current === null) return;
    heldRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    panning,
    onPointerDown: (event) => {
      const scroller = scrollerRef.current;
      if (scroller === null || event.button !== 0 || event.pointerType === 'touch') return;
      if (event.target instanceof Element && event.target.closest(OWN_PRESS) !== null) return;
      heldRef.current = {
        x: event.clientX,
        y: event.clientY,
        left: scroller.scrollLeft,
        top: scroller.scrollTop,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    },
    onPointerMove: (event) => {
      const scroller = scrollerRef.current;
      const from = heldRef.current;
      if (scroller === null || from === null) return;
      scroller.scrollLeft = from.left - (event.clientX - from.x);
      scroller.scrollTop = from.top - (event.clientY - from.y);
    },
    onPointerUp: release,
  };
}
