import { expect, it } from 'vitest';
import { pictureReading, picturesBeingRead, picturesRead } from './pending-pictures';

it('waits for every reading on its way, and for none when there is none', async () => {
  await picturesRead();
  const first = pictureReading();
  const second = pictureReading();
  expect(picturesBeingRead()).toBe(2);
  let settled = false;
  const waited = picturesRead().then(() => {
    settled = true;
  });
  first();
  await Promise.resolve();
  expect(settled).toBe(false);
  second();
  await waited;
  expect(settled).toBe(true);
  expect(picturesBeingRead()).toBe(0);
});

it('takes a reading called off twice as over once', async () => {
  const over = pictureReading();
  over();
  over();
  await picturesRead();
  expect(picturesBeingRead()).toBe(0);
});
