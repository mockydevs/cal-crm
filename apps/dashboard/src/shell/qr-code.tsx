import { generate } from 'lean-qr';
import { useMemo, type ReactElement } from 'react';

export interface QrCodeProps {
  readonly text: string;
  /** What the code holds, for people who can't see it. */
  readonly label: string;
}

/** The empty border scanners need around a code, in modules (ISO/IEC 18004). */
const QUIET_ZONE = 4;

/**
 * A QR code drawn as SVG. It stays black on white in every theme, since that's what
 * phone cameras read best.
 */
export function QrCode({ text, label }: QrCodeProps): ReactElement {
  const { size, path } = useMemo(() => {
    const code = generate(text);
    let modules = '';
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        // One dark module: a 1-by-1 square, in SVG path commands.
        if (code.get(x, y)) {
          modules += ['M', String(x + QUIET_ZONE), ',', String(y + QUIET_ZONE), 'h1v1h-1z'].join(
            '',
          );
        }
      }
    }
    return { size: code.size + QUIET_ZONE * 2, path: modules };
  }, [text]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className="size-48 shrink-0 rounded-md bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
