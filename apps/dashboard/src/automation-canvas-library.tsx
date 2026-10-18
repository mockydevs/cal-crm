// The list of actions beside the canvas: the same list the step panel shows, where a row
// can also be dragged onto the drawing. Its own chunk, fetched when someone first asks to
// add an action from the canvas's Add menu.
import { useEffect, useRef, type DragEvent, type ReactElement } from 'react';
import { needsWords, Picker } from './automation-picker';
import type { StepPicker } from './automation-availability';
import { stepLabel } from './automation-summary';

/** The list's search box, as distinct from the hidden input a select keeps. */
const SEARCH_BOX = 'input[type="search"]';

interface LibraryStep {
  readonly type: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
}

export interface CanvasLibraryProps {
  readonly picker: StepPicker<LibraryStep>;
  readonly onChoose: (type: string) => void;
  readonly onDragStart: (type: string, event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd: () => void;
}

export default function CanvasLibrary({
  picker,
  onChoose,
  onDragStart,
  onDragEnd,
}: CanvasLibraryProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  // Just asked for: the keyboard starts in the search box, once the menu that asked has
  // closed and let go of it.
  useEffect(() => {
    const timer = setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>(SEARCH_BOX)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const asItem = (step: LibraryStep) => ({
    type: step.type,
    name: stepLabel(step.type) ?? step.type,
    description: step.description,
  });
  return (
    <div ref={listRef}>
      <Picker
        owner="step"
        items={picker.groups.flatMap((group) => group.steps).map(asItem)}
        unavailable={picker.unavailable.map(({ step, missing }) => ({
          item: asItem(step),
          needs: needsWords(missing),
        }))}
        onChoose={onChoose}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}
