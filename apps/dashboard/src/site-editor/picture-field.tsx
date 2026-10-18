// A picture on a page, as a field: its address typed or pasted, or the picture chosen from
// Media Storage. Either way what the page keeps is an address anyone can open (a library
// file is made public first: ../site-media-choice.tsx). `measurePicture` loads a picture
// once in the browser to read its own width and height, which a published page writes on
// the image so nothing jumps while it loads.
import { Trans, useLingui } from '@lingui/react/macro';
import type { MediaFile } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Images } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { isMeasurable, pictureSize, type PictureSize } from '../site-media-rules';
import { useBusiness } from '../workspace';
import { AddressBox } from './field-parts';

const MediaChoice = lazy(() => import('../site-media-choice'));

/** How long a picture is waited for before it is taken as one that cannot be measured. */
const MEASURE_WITHIN_MS = 8000;

/**
 * A picture's own size, read by loading it once. Null for an address the editor cannot
 * load (a path on the site, a merge field), a picture that does not arrive in time, and
 * one with no size of its own.
 */
export function measurePicture(address: string | null): Promise<PictureSize | null> {
  if (!isMeasurable(address)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => {
      resolve(null);
    }, MEASURE_WITHIN_MS);
    const done = (size: PictureSize | null): void => {
      window.clearTimeout(timer);
      resolve(size);
    };
    image.addEventListener('load', () => {
      done(pictureSize({ width: image.naturalWidth, height: image.naturalHeight }));
    });
    image.addEventListener('error', () => {
      done(null);
    });
    // The picture's own server is told nothing of where it was asked from.
    image.referrerPolicy = 'no-referrer';
    image.src = address;
  });
}

/**
 * The address of a picture, with "Choose from Media Storage" beside it. `onChange` hears
 * an address the page document takes, or null when the box is emptied; `file` comes with
 * it when the picture was chosen from the library.
 */
export function PictureField({
  label,
  value,
  onChange,
  hint,
  pickerTitle,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly onChange: (address: string | null, file?: MediaFile) => void;
  readonly hint?: ReactNode;
  /** What the library's dialog is called: "Choose a picture". */
  readonly pickerTitle: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [choosing, setChoosing] = useState(false);
  // How many pictures the library has given: the box starts afresh for each, so letters
  // typed before (an address the page would not take) do not stay over the new address.
  const [chosen, setChosen] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setChoosing(false);
    // The dialog is gone by the next turn: the keyboard goes back to what opened it.
    window.setTimeout(() => {
      buttonRef.current?.focus();
    }, 0);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <AddressBox
        key={chosen}
        label={label}
        kind="media"
        value={value}
        onChange={onChange}
        hint={hint}
      />
      <Button
        ref={buttonRef}
        variant="secondary"
        size="small"
        className="self-start"
        aria-label={t`${label}: choose from Media Storage`}
        onClick={() => {
          setChoosing(true);
        }}
      >
        <Images aria-hidden className="size-4" strokeWidth={1.8} />
        <Trans>Choose from Media Storage</Trans>
      </Button>
      {choosing ? (
        <Suspense fallback={null}>
          <MediaChoice
            businessId={business.id}
            title={pickerTitle}
            onChosen={(address, file) => {
              setChosen((count) => count + 1);
              onChange(address, file);
              close();
            }}
            onClose={close}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
