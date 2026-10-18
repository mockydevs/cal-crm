// The formatted-text editor of an email: a toolbar over the text. It is fetched when an
// email is first edited, and it alone carries the editing library (tiptap), so neither the
// workflow builder nor the templates page waits for it.
//
// The toolbar is a real one: one stop for the Tab key, the arrow keys move between its
// tools, each tool has a name and says whether it is on. What a tool needs to ask (a
// link's address, a picture's description, a button's words) is asked in a small named
// group under the toolbar, which the keyboard goes into and Escape leaves.
//
// What it gives back is the HTML as it is saved: merge fields as {{path}} text, and only
// what the server's allowlist keeps (extensions.ts, email-html.ts).
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  Baseline,
  Bold,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  MailX,
  Maximize2,
  Minus,
  MousePointerClick,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Underline,
  Undo2,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  chipsFromTokens,
  cleanPastedHtml,
  emailImageAddress,
  emailLinkAddress,
  tokenOf,
  tokensFromChips,
} from './email-html';
import {
  BUTTON_COLOUR,
  emailExtensions,
  hexColour,
  IMAGE_WIDTHS,
  LINE_HEIGHTS,
  type Alignment,
} from './extensions';
import { paletteWith, UNSUBSCRIBE_FIELD } from './rules';

const MediaPicker = lazy(() => import('../media/picker'));

export interface RichTextProps {
  /** What the text is, such as "Email body": the name of the editing area. */
  readonly label: string;
  /** The formatted content as it is stored: merge fields as {{path}} text. */
  readonly html: string;
  /**
   * The list that inserts a merge field, drawn as a tool of the toolbar: it is given what
   * to do with the path chosen. Handed in, so this chunk holds the editing library alone
   * and not the list's own popup.
   */
  readonly fieldPicker: (insert: (path: string) => void) => ReactNode;
  /** Whether a path is a field this email can fill in. */
  readonly isKnown: (path: string) => boolean;
  /** The business's own colours, offered beside the palette. */
  readonly brand?: readonly string[];
  /** The business whose Media Storage a picture is chosen from. */
  readonly businessId: string;
  /** A few tools only, for a short message written in a panel. */
  readonly compact?: boolean;
  /** Opens the whole editor from the compact one. */
  readonly onExpand?: (() => void) | undefined;
  readonly invalid?: boolean;
  readonly describedBy?: string | undefined;
  /** Given the content as it is saved, each time it changes. */
  readonly onChange: (html: string) => void;
}

const toolClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-secondary aria-pressed:text-foreground lg:size-8';
const selectToolClassName =
  'min-h-11 max-w-36 shrink-0 rounded-control border border-transparent bg-transparent px-1 text-sm font-medium text-body outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8';
const iconProps = { 'aria-hidden': true, className: 'size-4', strokeWidth: 2 } as const;

function Tool({
  label,
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  /** Whether it is on, for a tool that is on or off; left out for one that just acts. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      data-tool
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={toolClassName}
      // The text keeps its selection: a press is not a move of focus.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Rule = (): ReactElement => (
  <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 self-center bg-border" />
);

type Asking =
  | { readonly kind: 'link'; readonly href: string }
  | {
      readonly kind: 'picture';
      readonly src: string;
      readonly alt: string;
      readonly width: string;
      readonly changing: boolean;
    }
  | {
      readonly kind: 'button';
      readonly label: string;
      readonly href: string;
      readonly colour: string;
      readonly changing: boolean;
    }
  | { readonly kind: 'colour'; readonly of: 'textColour' | 'highlight' };

function toolbarState(editor: Editor) {
  const block = editor.isActive('picture')
    ? 'picture'
    : editor.isActive('emailButton')
      ? 'emailButton'
      : editor.isActive('heading')
        ? 'heading'
        : 'paragraph';
  const attributes = editor.getAttributes(block);
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    link: editor.isActive('link'),
    bullets: editor.isActive('bulletList'),
    numbers: editor.isActive('orderedList'),
    block,
    level: editor.isActive('heading') ? Number(editor.getAttributes('heading')['level']) : 0,
    align: ((block === 'picture' || block === 'emailButton'
      ? attributes['align']
      : attributes['textAlign']) ?? 'left') as Alignment,
    lineHeight: (attributes['lineHeight'] ?? null) as string | null,
    textColour: (editor.getAttributes('textColour')['colour'] ?? null) as string | null,
    highlight: (editor.getAttributes('highlight')['colour'] ?? null) as string | null,
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  };
}

export default function RichText({
  label,
  html,
  fieldPicker,
  isKnown,
  brand = [],
  businessId,
  compact = false,
  onExpand,
  invalid = false,
  describedBy,
  onChange,
}: RichTextProps): ReactElement {
  const { t } = useLingui();
  const askId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<Asking>();
  const [choosingPicture, setChoosingPicture] = useState(false);
  const [problem, setProblem] = useState<string>();
  // A picture that was chosen and cannot be used: it is private.
  const [privatePicture, setPrivatePicture] = useState<string>();
  // What is done with a change is whatever the latest drawing says.
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  const unknownTitle = t`No send can fill this field in here.`;
  // The fields are those of the email being edited: they are read once, as it opens.
  const [extensions] = useState(() => emailExtensions({ isKnown, unknownTitle }));
  const editor = useEditor({
    extensions,
    content: chipsFromTokens(html),
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        // eslint-disable-next-line lingui/no-unlocalized-strings -- class names
        class: `email-text min-w-0 px-4 py-3 outline-none ${compact ? 'min-h-32' : 'min-h-72'}`,
      },
      transformPastedHTML: (pasted) => chipsFromTokens(cleanPastedHtml(pasted)),
    },
    onUpdate: ({ editor: changed }) => {
      changeRef.current(tokensFromChips(changed.getHTML()));
    },
  });
  const state = useEditorState({ editor, selector: (context) => toolbarState(context.editor) });

  // One stop for the Tab key: the tool the keyboard was last on, else the first.
  useLayoutEffect(() => {
    const tools = [...(toolbarRef.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])];
    if (tools.some((tool) => tool.tabIndex === 0 && !tool.hasAttribute('disabled'))) return;
    tools.forEach((tool, index) => {
      tool.tabIndex = index === 0 ? 0 : -1;
    });
  });
  const rove = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { key } = event;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    const tools = [
      ...(toolbarRef.current?.querySelectorAll<HTMLElement>('[data-tool]:not(:disabled)') ?? []),
    ];
    const at = tools.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tools.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : -1) + tools.length) % tools.length;
    tools[next]?.focus();
  };

  // What a tool asks is asked under the toolbar: the keyboard goes to its first box.
  const askingKind = asking?.kind;
  useEffect(() => {
    if (askingKind === undefined) return;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a selector, not words
    askRef.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [askingKind]);

  const palette = paletteWith(brand).map((colour) => {
    const { value } = colour;
    return { ...colour, label: colour.brand ? t`Brand colour ${value}` : colour.name };
  });
  /**
   * Puts a block (a picture, a button, a divider) after what is selected, never in its
   * place: with a picture selected, a button goes under the picture.
   */
  const insertBlock = (block: { type: string; attrs?: Record<string, unknown> }): void => {
    editor.chain().focus().insertContentAt(editor.state.selection.to, block).run();
  };
  const done = (): void => {
    setAsking(undefined);
    setProblem(undefined);
    editor.commands.focus();
  };
  const align = (to: Alignment): void => {
    const value = to === 'left' ? null : to;
    if (state.block === 'picture' || state.block === 'emailButton')
      editor.chain().focus().updateAttributes(state.block, { align: value }).run();
    else
      editor
        .chain()
        .focus()
        .updateAttributes('paragraph', { textAlign: value })
        .updateAttributes('heading', { textAlign: value })
        .run();
  };

  const applyLink = (typed: string): void => {
    const href = emailLinkAddress(typed);
    if (href === undefined) {
      setProblem(t`Give a web address, an email address, a phone link or one merge field.`);
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !state.link)
      chain
        .insertContent({
          type: 'text',
          text: typed.trim(),
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    else chain.setMark('link', { href }).run();
    done();
  };

  const ask = asking;
  return (
    <div
      className={`flex min-w-0 flex-col rounded-xl border bg-card ${invalid ? 'border-destructive' : 'border-input'}`}
    >
      {}
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label={t`Formatting`}
        aria-controls={askId}
        className="flex min-w-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1"
        onKeyDown={rove}
        onFocusCapture={(event) => {
          const tool = (event.target as HTMLElement).closest<HTMLElement>('[data-tool]');
          if (tool === null) return;
          for (const each of toolbarRef.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])
            each.tabIndex = each === tool ? 0 : -1;
        }}
      >
        {compact ? null : (
          <>
            <select
              data-tool
              aria-label={t`Paragraph style`}
              title={t`Paragraph style`}
              className={selectToolClassName}
              value={String(state.level)}
              onChange={(event) => {
                const level = Number(event.target.value);
                if (level === 0) editor.chain().focus().setNode('paragraph').run();
                else editor.chain().focus().setNode('heading', { level }).run();
              }}
            >
              <option value="0">{t`Paragraph`}</option>
              {['1', '2', '3'].map((level) => (
                <option key={level} value={level}>
                  {t`Heading ${level}`}
                </option>
              ))}
            </select>
            <Rule />
          </>
        )}
        <Tool
          label={t`Bold`}
          pressed={state.bold}
          onClick={() => editor.chain().focus().toggleMark('bold').run()}
        >
          <Bold {...iconProps} />
        </Tool>
        <Tool
          label={t`Italic`}
          pressed={state.italic}
          onClick={() => editor.chain().focus().toggleMark('italic').run()}
        >
          <Italic {...iconProps} />
        </Tool>
        <Tool
          label={t`Underline`}
          pressed={state.underline}
          onClick={() => editor.chain().focus().toggleMark('underline').run()}
        >
          <Underline {...iconProps} />
        </Tool>
        {compact ? null : (
          <>
            <Tool
              label={t`Strikethrough`}
              pressed={state.strike}
              onClick={() => editor.chain().focus().toggleMark('strike').run()}
            >
              <Strikethrough {...iconProps} />
            </Tool>
            <Tool
              label={t`Text colour`}
              pressed={ask?.kind === 'colour' && ask.of === 'textColour'}
              onClick={() => {
                setAsking({ kind: 'colour', of: 'textColour' });
              }}
            >
              <Baseline {...iconProps} />
            </Tool>
            <Tool
              label={t`Highlight`}
              pressed={ask?.kind === 'colour' && ask.of === 'highlight'}
              onClick={() => {
                setAsking({ kind: 'colour', of: 'highlight' });
              }}
            >
              <Highlighter {...iconProps} />
            </Tool>
          </>
        )}
        <Rule />
        <Tool
          label={t`Link`}
          pressed={state.link}
          onClick={() => {
            setAsking({ kind: 'link', href: String(editor.getAttributes('link')['href'] ?? '') });
          }}
        >
          <Link2 {...iconProps} />
        </Tool>
        {compact ? null : (
          <>
            <Tool
              label={t`Picture`}
              pressed={state.block === 'picture'}
              onClick={() => {
                if (state.block !== 'picture') {
                  setChoosingPicture(true);
                  return;
                }
                const held = editor.getAttributes('picture');
                setAsking({
                  kind: 'picture',
                  src: String(held['src']),
                  alt: String(held['alt'] ?? ''),
                  width: String(held['width'] ?? '100%'),
                  changing: true,
                });
              }}
            >
              <ImagePlus {...iconProps} />
            </Tool>
            <Tool
              label={t`Button`}
              pressed={state.block === 'emailButton'}
              onClick={() => {
                const held =
                  state.block === 'emailButton' ? editor.getAttributes('emailButton') : {};
                setAsking({
                  kind: 'button',
                  label: String(held['label'] ?? ''),
                  href: String(held['href'] ?? ''),
                  colour: String(held['colour'] ?? brand[0] ?? BUTTON_COLOUR),
                  changing: state.block === 'emailButton',
                });
              }}
            >
              <MousePointerClick {...iconProps} />
            </Tool>
            <Tool
              label={t`Divider`}
              onClick={() => {
                insertBlock({ type: 'divider' });
              }}
            >
              <Minus {...iconProps} />
            </Tool>
            <Rule />
            <Tool
              label={t`Align left`}
              pressed={state.align === 'left'}
              onClick={() => {
                align('left');
              }}
            >
              <TextAlignStart {...iconProps} />
            </Tool>
            <Tool
              label={t`Align centre`}
              pressed={state.align === 'center'}
              onClick={() => {
                align('center');
              }}
            >
              <TextAlignCenter {...iconProps} />
            </Tool>
            <Tool
              label={t`Align right`}
              pressed={state.align === 'right'}
              onClick={() => {
                align('right');
              }}
            >
              <TextAlignEnd {...iconProps} />
            </Tool>
            <select
              data-tool
              aria-label={t`Line height`}
              title={t`Line height`}
              className={selectToolClassName}
              value={state.lineHeight ?? ''}
              onChange={(event) => {
                const height = event.target.value === '' ? null : event.target.value;
                editor
                  .chain()
                  .focus()
                  .updateAttributes('paragraph', { lineHeight: height })
                  .updateAttributes('heading', { lineHeight: height })
                  .run();
              }}
            >
              <option value="">{t`Line height: normal`}</option>
              {LINE_HEIGHTS.map((height) => (
                <option key={height} value={height}>
                  {t`Line height: ${height}`}
                </option>
              ))}
            </select>
          </>
        )}
        <Rule />
        <Tool
          label={t`Bulleted list`}
          pressed={state.bullets}
          onClick={() => editor.chain().focus().toggleList('bulletList', 'listItem').run()}
        >
          <List {...iconProps} />
        </Tool>
        <Tool
          label={t`Numbered list`}
          pressed={state.numbers}
          onClick={() => editor.chain().focus().toggleList('orderedList', 'listItem').run()}
        >
          <ListOrdered {...iconProps} />
        </Tool>
        <Rule />
        {fieldPicker((path) => {
          editor.chain().focus().insertContent({ type: 'mergeField', attrs: { path } }).run();
        })}
        {compact ? null : (
          <>
            <Tool
              label={t`Insert an unsubscribe link`}
              onClick={() =>
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: 'text',
                    text: t`Unsubscribe`,
                    marks: [{ type: 'link', attrs: { href: tokenOf(UNSUBSCRIBE_FIELD) } }],
                  })
                  .run()
              }
            >
              <MailX {...iconProps} />
            </Tool>
            <Rule />
            <Tool
              label={t`Clear formatting`}
              onClick={() =>
                editor
                  .chain()
                  .focus()
                  .unsetAllMarks()
                  .clearNodes()
                  .resetAttributes('paragraph', ['textAlign', 'lineHeight'])
                  .run()
              }
            >
              <RemoveFormatting {...iconProps} />
            </Tool>
            <Tool
              label={t`Undo`}
              disabled={!state.canUndo}
              onClick={() => editor.chain().focus().undo().run()}
            >
              <Undo2 {...iconProps} />
            </Tool>
            <Tool
              label={t`Redo`}
              disabled={!state.canRedo}
              onClick={() => editor.chain().focus().redo().run()}
            >
              <Redo2 {...iconProps} />
            </Tool>
          </>
        )}
        {onExpand === undefined ? null : (
          <Tool label={t`Open in the editor`} onClick={onExpand}>
            <Maximize2 {...iconProps} />
          </Tool>
        )}
      </div>

      <div id={askId} ref={askRef}>
        {ask === undefined ? null : (
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions -- Escape leaves the group, from any control in it
          <div
            role="group"
            aria-label={
              ask.kind === 'link'
                ? t`Link`
                : ask.kind === 'picture'
                  ? t`Picture`
                  : ask.kind === 'button'
                    ? t`Button`
                    : ask.of === 'textColour'
                      ? t`Text colour`
                      : t`Highlight`
            }
            className="flex min-w-0 flex-wrap items-end gap-2 border-b border-border bg-background px-3 py-2"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              done();
            }}
          >
            {ask.kind === 'colour' ? (
              <>
                {palette.map((colour) => (
                  <button
                    key={colour.value}
                    type="button"
                    aria-label={colour.label}
                    title={colour.label}
                    aria-pressed={state[ask.of] === colour.value}
                    className="size-8 shrink-0 rounded-full border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                    style={{ backgroundColor: colour.value }}
                    onClick={() => {
                      editor.chain().focus().setMark(ask.of, { colour: colour.value }).run();
                      done();
                    }}
                  />
                ))}
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    editor.chain().focus().unsetMark(ask.of).run();
                    done();
                  }}
                >
                  {ask.of === 'textColour' ? <Trans>No colour</Trans> : <Trans>No highlight</Trans>}
                </Button>
              </>
            ) : null}
            {ask.kind === 'link' ? (
              <>
                <Labelled label={t`Link address`}>
                  <Input
                    value={ask.href}
                    maxLength={2000}
                    placeholder="https://"
                    aria-invalid={problem !== undefined}
                    onChange={(event) => {
                      setAsking({ kind: 'link', href: event.target.value });
                      setProblem(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      applyLink(ask.href);
                    }}
                  />
                </Labelled>
                <Button
                  size="small"
                  onClick={() => {
                    applyLink(ask.href);
                  }}
                >
                  <Trans>Apply link</Trans>
                </Button>
                {state.link ? (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => {
                      editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
                      done();
                    }}
                  >
                    <Trans>Remove link</Trans>
                  </Button>
                ) : null}
              </>
            ) : null}
            {ask.kind === 'picture' ? (
              <>
                <Labelled label={t`Description (alt text)`}>
                  <Input
                    value={ask.alt}
                    maxLength={500}
                    aria-required
                    aria-invalid={problem !== undefined}
                    onChange={(event) => {
                      setAsking({ ...ask, alt: event.target.value });
                      setProblem(undefined);
                    }}
                  />
                </Labelled>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    <Trans>Width</Trans>
                  </span>
                  <select
                    className="min-h-11 rounded-control border border-input bg-card px-2 text-md lg:min-h-9"
                    value={ask.width}
                    onChange={(event) => {
                      setAsking({ ...ask, width: event.target.value });
                    }}
                  >
                    {[...new Set([...IMAGE_WIDTHS, ask.width])].map((width) => (
                      <option key={width} value={width}>
                        {width === '100%' ? t`Full width` : t`${width} pixels`}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="small"
                  onClick={() => {
                    if (ask.alt.trim() === '') {
                      setProblem(
                        t`Describe the picture: the description is read aloud, and shown when pictures are off.`,
                      );
                      return;
                    }
                    const attrs = { src: ask.src, alt: ask.alt.trim(), width: ask.width };
                    if (ask.changing)
                      editor.chain().focus().updateAttributes('picture', attrs).run();
                    else insertBlock({ type: 'picture', attrs });
                    done();
                  }}
                >
                  {ask.changing ? <Trans>Update picture</Trans> : <Trans>Insert picture</Trans>}
                </Button>
              </>
            ) : null}
            {ask.kind === 'button' ? (
              <>
                <Labelled label={t`Button label`}>
                  <Input
                    value={ask.label}
                    maxLength={80}
                    aria-required
                    onChange={(event) => {
                      setAsking({ ...ask, label: event.target.value });
                      setProblem(undefined);
                    }}
                  />
                </Labelled>
                <Labelled label={t`Button link`}>
                  <Input
                    value={ask.href}
                    maxLength={2000}
                    placeholder="https://"
                    aria-required
                    onChange={(event) => {
                      setAsking({ ...ask, href: event.target.value });
                      setProblem(undefined);
                    }}
                  />
                </Labelled>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    <Trans>Colour</Trans>
                  </span>
                  <select
                    className="min-h-11 rounded-control border border-input bg-card px-2 text-md lg:min-h-9"
                    value={ask.colour}
                    onChange={(event) => {
                      setAsking({ ...ask, colour: event.target.value });
                    }}
                  >
                    {[
                      ...new Map(
                        [
                          { value: hexColour(ask.colour) ?? BUTTON_COLOUR, name: ask.colour },
                          { value: BUTTON_COLOUR, name: t`Blue` },
                          ...palette.map((colour) => ({
                            value: colour.value,
                            name: colour.label,
                          })),
                        ].map((colour) => [colour.value, colour] as const),
                      ).values(),
                    ].map((colour) => (
                      <option key={colour.value} value={colour.value}>
                        {colour.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="small"
                  onClick={() => {
                    const href = emailLinkAddress(ask.href);
                    if (ask.label.trim() === '' || href === undefined) {
                      setProblem(t`Give the button its words and a link to open.`);
                      return;
                    }
                    const attrs = { label: ask.label.trim(), href, colour: ask.colour };
                    if (ask.changing)
                      editor.chain().focus().updateAttributes('emailButton', attrs).run();
                    else insertBlock({ type: 'emailButton', attrs });
                    done();
                  }}
                >
                  {ask.changing ? <Trans>Update button</Trans> : <Trans>Insert button</Trans>}
                </Button>
              </>
            ) : null}
            <Button variant="quiet" size="small" onClick={done}>
              <Trans>Cancel</Trans>
            </Button>
            {problem === undefined ? null : (
              <p role="alert" className="basis-full text-sm font-medium text-destructive">
                {problem}
              </p>
            )}
          </div>
        )}
      </div>

      <EditorContent
        editor={editor}
        aria-describedby={describedBy}
        className="max-h-[60dvh] min-w-0 overflow-y-auto rounded-b-xl bg-white text-[15px] leading-normal text-[#111827] [&_.email-text_a]:text-[#1d4ed8] [&_.email-text_a]:underline [&_.email-text_h1]:my-2 [&_.email-text_h1]:text-[26px] [&_.email-text_h1]:font-bold [&_.email-text_h2]:my-2 [&_.email-text_h2]:text-[21px] [&_.email-text_h2]:font-bold [&_.email-text_h3]:my-2 [&_.email-text_h3]:text-[17px] [&_.email-text_h3]:font-bold [&_.email-text_hr]:my-3 [&_.email-text_hr]:border-[#d0d5dd] [&_.email-text_img]:my-2 [&_.email-text_ol]:list-decimal [&_.email-text_ol]:pl-6 [&_.email-text_p]:my-2 [&_.email-text_table]:my-2 [&_.email-text_ul]:list-disc [&_.email-text_ul]:pl-6 [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-[#2563eb]"
      />

      {choosingPicture ? (
        <Suspense fallback={null}>
          <MediaPicker
            businessId={businessId}
            title={<Trans>Choose a picture</Trans>}
            kinds={['image']}
            onClose={() => {
              setChoosingPicture(false);
            }}
            onChoose={(file) => {
              setChoosingPicture(false);
              const src = emailImageAddress(file.publicUrl);
              if (src === undefined) {
                setProblem(undefined);
                setAsking(undefined);
                setPrivatePicture(file.name);
                return;
              }
              setPrivatePicture(undefined);
              setAsking({ kind: 'picture', src, alt: '', width: '100%', changing: false });
            }}
          />
        </Suspense>
      ) : null}
      {privatePicture === undefined ? null : (
        <p role="alert" className="border-t border-border px-3 py-2 text-sm text-destructive">
          {t`“${privatePicture}” is private, so a mail app could not load it. Make it public in Media Storage, then choose it again.`}
        </p>
      )}
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <label className="flex min-w-40 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
