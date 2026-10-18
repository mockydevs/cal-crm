// Pictures whose size is still being read. A size arrives a moment after its picture is
// chosen or its address typed, and writes itself into the page then. Saving for a publish,
// a preview or a kept version waits for the ones on their way, so the size is in what is
// published and does not turn up afterwards as a change nobody made.

const onTheirWay = new Set<Promise<void>>();

/**
 * Counts a reading as on its way until it settles. The caller gets back the way to say it
 * is over, for a reading that is called off before it starts.
 */
export function pictureReading(): () => void {
  let over: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    over = resolve;
  });
  onTheirWay.add(reading);
  void reading.then(() => {
    onTheirWay.delete(reading);
  });
  return over;
}

/** Settles when every reading on its way now has ended. */
export async function picturesRead(): Promise<void> {
  await Promise.all([...onTheirWay]);
}

/** How many readings are on their way: for tests. */
export const picturesBeingRead = (): number => onTheirWay.size;
