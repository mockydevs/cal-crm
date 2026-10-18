// The fields of an image element: the picture (typed, pasted or chosen from Media
// Storage), its own size as the page keeps it, its description for people who cannot see
// it, and where pressing it leads. The size is measured by loading the picture once in the
// browser, and written on the published page's image so the page does not jump while the
// picture loads; it never decides how large the picture is drawn (the look does).
import { Trans, useLingui } from '@lingui/react/macro';
import type { MediaFile, PageAction } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { altStateOf, isMeasurable, storedSize, type PictureSize } from '../site-media-rules';
import { useCanvasActions } from './canvas-api';
import type { CanvasNode } from './document-map';
import { smallLabelClassName, SwitchRow, TextBox } from './field-parts';
import { pictureReading } from './pending-pictures';
import { measurePicture, PictureField } from './picture-field';

const noteClassName = 'rounded-control bg-secondary px-3 py-2 text-xs leading-normal text-body';
const promptClassName =
  'rounded-control bg-attention px-3 py-2 text-xs leading-normal text-attention-foreground';

/** No size: the keys are taken off the element, so a page put back is the page it was. */
const NO_SIZE = { width: undefined, height: undefined } as const;

type Reading = 'idle' | 'reading' | 'unreadable';

/** How long after the last letter of a typed address its picture is loaded to be measured. */
const TYPING_PAUSE_MS = 500;

export function ImageFields({
  node,
  action,
}: {
  readonly node: CanvasNode;
  /** The field for where pressing the image leads: the panel's own, so this file needs no page facts. */
  readonly action: (
    value: PageAction | undefined,
    onChange: (next: PageAction) => void,
  ) => ReactNode;
}): ReactElement {
  const { t } = useLingui();
  const { setProps, read } = useCanvasActions();
  const { props } = node;
  const id = props.id;
  const src = typeof props['src'] === 'string' ? props['src'] : null;
  const alt = typeof props['alt'] === 'string' ? props['alt'] : '';
  const pressed = props['action'] as PageAction | undefined;
  const isLink = pressed !== undefined && pressed.type !== 'none';
  const size = storedSize(props);
  // A picture that came with no description was published as decoration, and is shown as
  // marked so; one chosen now owes a description or the mark.
  const [marked, setMarked] = useState(() => src !== null && alt.trim() === '');
  const [reading, setReading] = useState<Reading>('idle');
  const askedRef = useRef(0);
  const pauseRef = useRef<number | undefined>(undefined);
  const overRef = useRef<(() => void) | undefined>(undefined);

  /** Writes the size of the picture the element shows now, if it still shows that one. */
  const keep = (address: string, measured: PictureSize | null, asked: number): void => {
    if (asked !== askedRef.current) return;
    setReading(measured === null ? 'unreadable' : 'idle');
    if (read(id)?.props['src'] === address) setProps(id, { ...(measured ?? NO_SIZE) });
  };
  /**
   * Measures the picture at an address, now or after a pause. An address being typed is
   * one the page takes long before it is whole: only what is left standing is loaded.
   */
  const measure = (address: string, after = 0): void => {
    askedRef.current += 1;
    const asked = askedRef.current;
    window.clearTimeout(pauseRef.current);
    // A reading still in its pause is called off here; one already loading ends by itself.
    overRef.current?.();
    if (!isMeasurable(address)) {
      setReading('idle');
      return;
    }
    setReading('reading');
    // Counted from now, pause included: a publish pressed meanwhile waits for the size.
    const over = pictureReading();
    overRef.current = over;
    pauseRef.current = window.setTimeout(() => {
      void measurePicture(address).then((measured) => {
        keep(address, measured, asked);
        over();
      });
    }, after);
  };
  const choose = (address: string | null, file?: MediaFile): void => {
    askedRef.current += 1;
    const asked = askedRef.current;
    window.clearTimeout(pauseRef.current);
    overRef.current?.();
    if (address === null) {
      setReading('idle');
      setProps(id, { src: null, ...NO_SIZE });
      return;
    }
    // A new picture owes a description, whatever the old one had been marked as.
    if (address !== src) setMarked(false);
    if (file === undefined) {
      // Typed or pasted: shown at once, measured once the typing has stopped.
      setProps(id, { src: address, ...NO_SIZE });
      measure(address, TYPING_PAUSE_MS);
      return;
    }
    // From the library: measured first, so the picture and its size arrive as one change.
    setReading('reading');
    const over = pictureReading();
    void measurePicture(address).then((measured) => {
      if (asked === askedRef.current) {
        setReading(measured === null ? 'unreadable' : 'idle');
        setProps(id, { src: address, ...(measured ?? NO_SIZE) });
      }
      over();
    });
  };

  const state = altStateOf({ alt, isLink, markedDecorative: marked });
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  return (
    <>
      <PictureField
        label={t`Image address`}
        value={src}
        onChange={choose}
        pickerTitle={<Trans>Choose a picture</Trans>}
        hint={
          <Trans>
            Choose a picture from Media Storage, or paste the web address of one, starting with
            https://.
          </Trans>
        }
      />
      {src === null ? null : (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="picture-size">
          <p className={smallLabelClassName}>
            <Trans>Picture size</Trans>
          </p>
          <p role="status" className="text-xs leading-normal text-body">
            {reading === 'reading' ? (
              <Trans>Reading the picture's size…</Trans>
            ) : size !== null ? (
              <Trans>
                {width} × {height} px
              </Trans>
            ) : reading === 'unreadable' ? (
              <Trans>
                The picture's size couldn't be read. Check that the address opens a picture.
              </Trans>
            ) : isMeasurable(src) ? (
              <Trans>
                Not stored yet. With it, the published page keeps the picture's place while it
                loads.
              </Trans>
            ) : (
              <Trans>
                Not stored: a size is read only from a full web address (https://), not from a path
                or a merge field.
              </Trans>
            )}
          </p>
          {isMeasurable(src) ? (
            <Button
              variant="secondary"
              size="small"
              className="self-start"
              disabled={reading === 'reading'}
              onClick={() => {
                measure(src);
              }}
            >
              <Trans>Reset to the picture's size</Trans>
            </Button>
          ) : null}
        </div>
      )}
      <TextBox
        label={t`Description for screen readers`}
        value={alt}
        maxLength={500}
        onChange={(next) => {
          if (next.trim() !== '') setMarked(false);
          setProps(id, { alt: next });
        }}
        hint={<Trans>What the picture shows, for people who can't see it.</Trans>}
      />
      {src === null ? null : state === 'link_needs_words' ? (
        <p role="status" className={promptClassName} data-testid="alt-prompt">
          <Trans>
            This picture is a link, so it needs a description: it tells people who can't see it
            where the link goes. The page can't be published without one.
          </Trans>
        </p>
      ) : state === 'owed' ? (
        <p role="status" className={promptClassName} data-testid="alt-prompt">
          <Trans>Describe the picture, or mark it below as decoration only.</Trans>
        </p>
      ) : null}
      {isLink ? null : (
        <SwitchRow
          label={t`Decoration only`}
          checked={state === 'decorative'}
          onChange={(next) => {
            setMarked(next);
            if (next && alt !== '') setProps(id, { alt: '' });
          }}
          hint={
            state === 'decorative' ? (
              <Trans>Screen readers pass over it. It has no description.</Trans>
            ) : (
              <Trans>For a picture that adds nothing to what the page says.</Trans>
            )
          }
        />
      )}
      {action(pressed, (next) => {
        setProps(id, { action: next });
      })}
      {src === null ? (
        <p className={noteClassName}>
          <Trans>The page can't be published until this image has a picture.</Trans>
        </p>
      ) : null}
    </>
  );
}
