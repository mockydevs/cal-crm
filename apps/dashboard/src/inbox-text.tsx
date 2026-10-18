// Text that came from outside, or was written for it: a message's body, a note. It is
// shown as text and nothing else. React writes each piece as a text node, so markup in a
// message is seen, never run; the only elements here are the links inbox-rules judged
// safe, whose words are the address itself.
import type { ReactElement } from 'react';
import { textPartsOf, type TextPart } from './inbox-rules';

export function MessageText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}): ReactElement {
  // Each piece with where it starts in the text: a key that is its own.
  const parts = textPartsOf(text).reduce<{ part: TextPart; at: number }[]>((placed, part) => {
    const last = placed.at(-1);
    return [...placed, { part, at: last === undefined ? 0 : last.at + last.part.text.length }];
  }, []);
  return (
    <p className={`min-w-0 wrap-anywhere whitespace-pre-wrap ${className ?? ''}`}>
      {parts.map(({ part, at }) =>
        part.kind === 'link' ? (
          <a
            key={at}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            referrerPolicy="no-referrer"
            className="underline underline-offset-2"
          >
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </p>
  );
}
