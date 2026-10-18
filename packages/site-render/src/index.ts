// The renderer of site pages: a page document as static HTML and CSS. Nothing here reads a
// database, a clock or a network; `@repo/site-render/server` adds the policy and the tag
// the server sends with a page.
export { countdownStep, countdownText, MINUTE } from './countdown.js';
export { BASE_CSS, baseCss, BREAKPOINTS, declarations, DEVICE_QUERIES, Stylesheet } from './css.js';
export { escapeHtml, linkAddress, mediaAddress, mergeText, type MergeValues } from './escape.js';
export {
  pageChangesAt,
  pageElements,
  renderPage,
  type PageNeeds,
  type PageScripts,
  type RenderContext,
  type RenderedPage,
} from './render.js';
export { VIDEO_FRAME_ORIGINS, videoEmbedUrl, type VideoOptions } from './video.js';
