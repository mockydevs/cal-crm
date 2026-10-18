// The library as cards: a designed template shows a small picture of itself, drawn by the
// server's own preview (the same one the editor shows) once the card scrolls into view and
// kept while the template is unchanged; a plain-text one shows its first lines. Every card
// keeps the same size before and after its picture arrives. Fetched when the grid is chosen.
import { useLingui } from '@lingui/react/macro';
import { renderEmailPreview, type MessageTemplateSummary } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { nameButtonClassName, TickBox } from '../email-library/table';
import { RowMenu } from '../email-library/row-menu';
import { useBusiness } from '../workspace';
import { TypeTag, UsedIn, type RowProps } from './rows';

/** True once the element has come within a screen of the window, and stays true. */
function useSeen(): readonly [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  // Without a way to tell (an old browser), every picture is drawn at once.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (element === null || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '400px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [seen]);
  return [ref, seen];
}

function Thumbnail({ template }: { readonly template: MessageTemplateSummary }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { name } = template;
  const [ref, seen] = useSeen();
  const preview = useQuery({
    // A new revision is a new picture; the old one is never shown for it.
    queryKey: ['b', business.id, 'template-thumbnail', template.id, template.revision],
    queryFn: () =>
      apiIn(business.id).request(renderEmailPreview, {
        body: { template: template.id, footer: false, values: {} },
      }),
    enabled: seen && template.format === 'html',
    staleTime: Infinity,
    retry: false,
  });
  const html = preview.data?.html ?? null;
  return (
    <div
      ref={ref}
      aria-hidden
      className="relative h-40 overflow-hidden rounded-t-card border-b border-border bg-muted"
    >
      {template.format === 'text' ? (
        <p className="line-clamp-6 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-body">
          {template.preview}
        </p>
      ) : html === null ? null : (
        <iframe
          title={t`Preview of ${name}`}
          // Nothing in it runs or reaches the page: the server cleaned it, the frame holds it.
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          loading="lazy"
          // The email at 600px wide, shrunk to the card: 600 × 0.4 = 240px.
          className="pointer-events-none absolute top-0 left-0 h-[1000px] w-[600px] origin-top-left scale-40 border-0 bg-white"
        />
      )}
    </div>
  );
}

export default function TemplateGrid({
  rows,
  canTick,
}: {
  readonly rows: readonly RowProps[];
  readonly canTick: boolean;
}): ReactElement {
  const { t } = useLingui();
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {rows.map(({ item, ticked, onTick, actions, onOpen, onMenu, when }) => {
        const { name } = item;
        return (
          <li
            key={item.id}
            data-ticked={ticked ? true : undefined}
            className="flex min-w-0 flex-col rounded-card border border-border bg-card data-ticked:border-primary data-ticked:ring-1 data-ticked:ring-primary"
          >
            <Thumbnail template={item} />
            <div className="flex min-w-0 items-start gap-1 p-2">
              {canTick ? (
                <TickBox label={t`Select ${name}`} checked={ticked} onChange={onTick} />
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
                {onOpen === undefined ? (
                  <span className="truncate font-medium text-foreground">{name}</span>
                ) : (
                  <button type="button" className={nameButtonClassName} onClick={onOpen}>
                    {name}
                  </button>
                )}
                <span className="truncate text-xs text-muted-foreground">{item.subject}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <TypeTag format={item.format} />
                  <UsedIn template={item} />
                </div>
                <span className="text-xs text-muted-foreground">{when}</span>
              </div>
              {actions.length === 0 ? null : (
                <RowMenu label={t`Actions for ${name}`} actions={actions} onOpen={onMenu} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
