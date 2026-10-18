// The form embed's look. It lives in a shadow root, so the website's styles do not reach in
// and these do not leak out. Colours are the CRM's own (the same tokens as the web chat
// widget); the font is the visitor's system font, so nothing is fetched.

/** Foreground and background pairs are tested for a contrast of at least 4.5 to 1. */
export const tokens = {
  surface: '#ffffff',
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
// what it sets would be inherited by the whole form. So the host carries nothing. Every
// inherited property is set on the frame inside the shadow root, which no rule of the
// website can match.
export const css = `
:host{all:initial}
section{all:initial;display:block;box-sizing:border-box;width:100%;max-width:560px;padding:20px;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;
color:${tokens.ink};background:${tokens.surface};color-scheme:light;text-align:left;direction:ltr;
border:1px solid ${tokens.line};border-radius:16px}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
h2{margin:0 0 8px;font-size:20px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
p{margin:0;overflow-wrap:anywhere}
.description{margin-bottom:16px;color:${tokens.muted};white-space:pre-wrap}
form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:15px;font-weight:500;overflow-wrap:anywhere}
.req{color:${tokens.muted};font-weight:400}
.hint{color:${tokens.muted};font-size:14px}
.error,.notice{color:${tokens.danger};font-size:14px;font-weight:500}
input,select,textarea,button{font:inherit;color:inherit;margin:0}
input[type=text],input[type=email],input[type=tel],input[type=date],select,textarea{width:100%;min-height:44px;
padding:10px 12px;font-size:16px;background:${tokens.surface};border:1px solid ${tokens.muted};border-radius:10px}
textarea{min-height:112px;resize:vertical}
[aria-invalid=true]{border-color:${tokens.danger};border-width:2px}
input[type=url],select[multiple]{width:100%;min-height:44px;padding:10px 12px;font-size:16px;
background:${tokens.surface};border:1px solid ${tokens.muted};border-radius:10px}
select[multiple]{min-height:132px}
::placeholder{color:${tokens.muted};opacity:1}
label.check{display:flex;align-items:flex-start;gap:10px;font-weight:400}
label.check input{width:20px;height:20px;margin-top:1px;flex:none;accent-color:${tokens.accent}}
fieldset{margin:0;padding:0;border:0;min-width:0;display:flex;flex-direction:column;gap:8px}
legend{padding:0;margin-bottom:6px;font-size:15px;font-weight:500;overflow-wrap:anywhere}
fieldset.rating{flex-direction:row;flex-wrap:wrap;gap:8px}
fieldset.rating legend{float:left;width:100%}
fieldset.rating label.check{align-items:center;gap:6px;min-height:44px;padding:0 12px;
border:1px solid ${tokens.muted};border-radius:10px}
fieldset[aria-invalid=true]{border:0;padding-left:10px;border-left:2px solid ${tokens.danger}}
h3{margin:8px 0 0;font-size:17px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.content{white-space:pre-wrap}
a{color:${tokens.accent};text-decoration:underline}
.preview{margin-bottom:16px;padding:10px 12px;border:1px solid ${tokens.line};border-radius:10px;
color:${tokens.muted};font-size:14px}
:focus-visible{outline:2px solid ${tokens.accent};outline-offset:2px}
.primary{align-self:flex-start;min-height:44px;padding:10px 24px;border:0;border-radius:999px;
background:${tokens.accent};color:${tokens.accentInk};font-weight:600;cursor:pointer}
.primary:hover:not(:disabled){background:${tokens.accentHover}}
.primary:disabled{cursor:default;opacity:.6}
.status{color:${tokens.muted}}
.botcheck{color:${tokens.muted};font-size:14px}
.done{white-space:pre-wrap;font-weight:500}
.trap{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
@media (forced-colors:active){.primary{border:1px solid}}
`;
