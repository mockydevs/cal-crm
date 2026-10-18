// The colours a stage can be given in the pipeline dialog. Each is one of the design
// system's tokens (packages/ui/src/styles/globals.css), never a value written here: the
// swatch is drawn with the token's class, and what is saved is the token's value as the
// page has it when the swatch is pressed, since the server keeps a stage's colour as
// `#rrggbb` (packages/contracts/src/pipelines.ts).

/** A colour on offer: the token it is, and the class that fills a swatch with it. */
export interface StageColorChoice {
  readonly key: 'blue' | 'green' | 'amber' | 'red' | 'gray' | 'mint' | 'peach' | 'sky' | 'violet';
  readonly token: string;
  readonly className: string;
}

export const stageColorChoices: readonly StageColorChoice[] = [
  { key: 'blue', token: '--assistant-pill-ink', className: 'bg-assistant-foreground' },
  { key: 'green', token: '--success', className: 'bg-success' },
  { key: 'amber', token: '--attention-ink', className: 'bg-attention-foreground' },
  { key: 'red', token: '--danger', className: 'bg-destructive' },
  { key: 'gray', token: '--muted', className: 'bg-muted-foreground' },
  { key: 'mint', token: '--success-line', className: 'bg-success-line' },
  { key: 'peach', token: '--avatar-1', className: 'bg-avatar-1' },
  { key: 'sky', token: '--avatar-2', className: 'bg-avatar-2' },
  { key: 'violet', token: '--avatar-3', className: 'bg-avatar-3' },
];

const HEX = /^#[0-9a-f]{6}$/;
const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/;

/**
 * A token's value as the server takes a colour: `#rrggbb` in lower case. Undefined when the
 * page gives the token no value, or one that is not a plain hex colour, so nothing the
 * server would refuse is ever sent.
 */
export function stageColorOf(
  choice: Pick<StageColorChoice, 'token'>,
  styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
): string | undefined {
  const value = styles.getPropertyValue(choice.token).trim().toLowerCase();
  const long = value.replace(SHORT_HEX, '#$1$1$2$2$3$3');
  return HEX.test(long) ? long : undefined;
}
