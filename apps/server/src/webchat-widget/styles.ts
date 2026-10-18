// The web chat widget's look. It lives in a shadow root, so the website's styles do not
// reach in and these do not leak out. Colours are the CRM's own (the same tokens as the
// unsubscribe page); the font is the visitor's system font, so nothing is fetched.

/** Foreground and background pairs are tested for a contrast of at least 4.5 to 1. */
export const tokens = {
  surface: '#ffffff',
  ground: '#f2f5f1',
  ink: '#1d2a24',
  muted: '#56625b',
  line: '#c9d3ca',
  accent: '#0f7a68',
  accentInk: '#ffffff',
  accentHover: '#0c6253',
  danger: '#a3261d',
} as const;

// The host element is in the website's own document, where the website's rules reach it:
// one as blunt as `* { font-size: 40px !important }` wins over anything :host says here, and
// what it sets would be inherited by the whole widget. So the host carries nothing. The
// place on the screen and every inherited property are set on the frame inside the shadow
// root, which no rule of the website can match.
export const css = `
:host{all:initial}
aside{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483000;display:block;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;
color:${tokens.ink};color-scheme:light;text-align:left;direction:ltr}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
button,input,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer}
button:disabled{cursor:default;opacity:.6}
:focus-visible{outline:2px solid ${tokens.accent};outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.launcher{position:relative;display:flex;align-items:center;justify-content:center;width:56px;height:56px;margin-left:auto;
border:0;border-radius:50%;background:${tokens.accent};color:${tokens.accentInk};box-shadow:0 4px 14px rgba(29,42,36,.28)}
.launcher:hover{background:${tokens.accentHover}}
.launcher svg{width:26px;height:26px;fill:currentColor}
.badge{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:${tokens.danger};border:2px solid ${tokens.surface}}
.panel{display:flex;flex-direction:column;width:min(360px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 96px));
margin-bottom:12px;background:${tokens.surface};border:1px solid ${tokens.line};border-radius:16px;overflow:hidden;
box-shadow:0 12px 36px rgba(29,42,36,.24);transition:opacity .15s ease}
.head{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 16px;background:${tokens.accent};color:${tokens.accentInk}}
.head h2{flex:1;margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.close{width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:${tokens.accentInk};font-size:22px;line-height:1}
.close:hover{background:${tokens.accentHover}}
.close:focus-visible{outline-color:${tokens.accentInk}}
.body{display:flex;flex-direction:column;gap:12px;min-height:0;padding:16px;overflow-y:auto}
p{margin:0;overflow-wrap:anywhere}
.status,.privacy{color:${tokens.muted};font-size:14px}
.notice{color:${tokens.danger};font-size:14px;font-weight:500}
form{display:flex;flex-direction:column;gap:12px;margin:0}
label{display:flex;flex-direction:column;gap:4px;font-size:14px;font-weight:500}
label.check{flex-direction:row;align-items:flex-start;gap:8px;font-weight:400}
label.check input{width:18px;height:18px;margin-top:2px;flex:none;accent-color:${tokens.accent}}
.hint{color:${tokens.muted};font-weight:400}
input[type=text],input[type=email],textarea{width:100%;padding:10px 12px;font-size:16px;background:${tokens.surface};
border:1px solid ${tokens.muted};border-radius:10px}
textarea{resize:none;min-height:72px}
.primary{align-self:flex-end;min-height:44px;padding:10px 20px;border:0;border-radius:999px;background:${tokens.accent};
color:${tokens.accentInk};font-weight:600}
.primary:hover:not(:disabled){background:${tokens.accentHover}}
.chat{display:flex;flex-direction:column;gap:12px;min-height:0}
.log{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.item{max-width:85%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.item.visitor{align-self:flex-end;background:${tokens.accent};color:${tokens.accentInk}}
.item.team{align-self:flex-start;background:${tokens.ground};color:${tokens.ink}}
.item .meta{display:block;margin-top:4px;font-size:13px;white-space:normal}
.item.failed{background:${tokens.surface};color:${tokens.ink};border:1px solid ${tokens.danger}}
.item.failed .meta{color:${tokens.danger}}
.link{padding:0;border:0;background:none;color:inherit;font-size:13px;font-weight:600;text-decoration:underline}
.end{align-self:flex-start;color:${tokens.muted}}
.composer{flex-direction:row;align-items:flex-end;gap:8px}
.composer label{flex:1}
.composer textarea{min-height:44px;max-height:120px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.launcher,.primary,.item{border:1px solid}}
`;
