// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasPan } from './automation-canvas-pan';

const capture = vi.fn();
const release = vi.fn();
let captured = false;

beforeEach(() => {
  captured = false;
  capture.mockReset().mockImplementation(() => {
    captured = true;
  });
  release.mockReset().mockImplementation(() => {
    captured = false;
  });
  // jsdom captures no pointers.
  Element.prototype.setPointerCapture = capture;
  Element.prototype.releasePointerCapture = release;
  Element.prototype.hasPointerCapture = () => captured;
});
afterEach(cleanup);

function Sheet({ mounted = true }: { readonly mounted?: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const unusedRef = useRef<HTMLDivElement>(null);
  const pan = useCanvasPan(mounted ? ref : unusedRef);
  return (
    <div
      ref={ref}
      data-testid="scroller"
      data-panning={pan.panning}
      onPointerDown={pan.onPointerDown}
      onPointerMove={pan.onPointerMove}
      onPointerUp={pan.onPointerUp}
      onPointerCancel={pan.onPointerUp}
    >
      <div data-testid="background">
        <button type="button">Add</button>
        <div data-canvas-box>
          <span data-testid="card">Send an email</span>
        </div>
      </div>
    </div>
  );
}

const scroller = (): HTMLElement => screen.getByTestId('scroller');
const press = (target: HTMLElement, more: Record<string, unknown> = {}): void => {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    button: 0,
    pointerType: 'mouse',
    clientX: 300,
    clientY: 200,
    ...more,
  });
};

describe('dragging the canvas background', () => {
  it('starts a pan on a press on the background and scrolls by the drag, the other way', () => {
    render(<Sheet />);
    scroller().scrollLeft = 100;
    scroller().scrollTop = 50;
    expect(scroller().dataset['panning']).toBe('false');
    press(screen.getByTestId('background'));
    expect(scroller().dataset['panning']).toBe('true');
    expect(capture).toHaveBeenCalledWith(1);
    // Dragged 40 left and 30 up: the drawing follows the hand, so the view moves on.
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 260, clientY: 170 });
    expect(scroller().scrollLeft).toBe(140);
    expect(scroller().scrollTop).toBe(80);
    // Measured from where the press began, not from the last move.
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 320, clientY: 210 });
    expect(scroller().scrollLeft).toBe(80);
    expect(scroller().scrollTop).toBe(40);
  });

  it('ends on release, and gives the pointer back', () => {
    render(<Sheet />);
    press(screen.getByTestId('background'));
    fireEvent.pointerUp(scroller(), { pointerId: 1 });
    expect(scroller().dataset['panning']).toBe('false');
    expect(release).toHaveBeenCalledWith(1);
    scroller().scrollLeft = 10;
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(scroller().scrollLeft).toBe(10);
    // A release with nothing held does nothing.
    fireEvent.pointerUp(scroller(), { pointerId: 1 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ends when the press is cancelled, even if the pointer was never captured', () => {
    render(<Sheet />);
    capture.mockImplementation(() => undefined);
    press(screen.getByTestId('background'));
    fireEvent.pointerCancel(scroller(), { pointerId: 1 });
    expect(scroller().dataset['panning']).toBe('false');
    expect(release).not.toHaveBeenCalled();
  });

  it('leaves a press on a button or on a card to them', () => {
    render(<Sheet />);
    press(screen.getByRole('button', { name: 'Add' }));
    press(screen.getByTestId('card'));
    expect(scroller().dataset['panning']).toBe('false');
    expect(capture).not.toHaveBeenCalled();
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(scroller().scrollLeft).toBe(0);
  });

  it('leaves a finger to scroll by itself, and another mouse button alone', () => {
    render(<Sheet />);
    press(screen.getByTestId('background'), { pointerType: 'touch' });
    press(screen.getByTestId('background'), { button: 2 });
    expect(scroller().dataset['panning']).toBe('false');
    // A pen pans as a mouse does.
    press(screen.getByTestId('background'), { pointerType: 'pen' });
    expect(scroller().dataset['panning']).toBe('true');
  });

  it('does nothing before the canvas is on the page', () => {
    render(<Sheet mounted={false} />);
    press(screen.getByTestId('background'));
    expect(scroller().dataset['panning']).toBe('false');
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 0, clientY: 0 });
    expect(capture).not.toHaveBeenCalled();
  });
});
