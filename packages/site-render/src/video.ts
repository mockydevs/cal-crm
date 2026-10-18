// A video from YouTube or Vimeo is shown in the player each documents for embedding:
// https://www.youtube.com/embed/VIDEO_ID (developers.google.com/youtube/player_parameters:
// autoplay, controls, and loop with playlist set to the same id) and
// https://player.vimeo.com/video/ID (Vimeo's "Player parameters overview": autoplay,
// muted, loop, controls, each 1 or 0). YouTube's page lists no parameter that mutes, so
// `muted` is not passed to it.

export interface VideoOptions {
  readonly source: unknown;
  readonly url: unknown;
  readonly autoplay?: unknown;
  readonly controls?: unknown;
  readonly muted?: unknown;
  readonly loop?: unknown;
}

/** The origins a page's frames may come from, for its policy. */
export const VIDEO_FRAME_ORIGINS = {
  youtube: 'https://www.youtube.com',
  vimeo: 'https://player.vimeo.com',
} as const;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const VIMEO_ID = /^[0-9]{1,20}$/;

function parsed(url: unknown): URL | undefined {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  const address = new URL(url);
  return address.protocol === 'https:' ? address : undefined;
}

function youtubeId(address: URL): string | undefined {
  const parts = address.pathname.split('/').filter((part) => part !== '');
  let id: string | null | undefined;
  if (address.hostname === 'youtu.be') [id] = parts;
  else if (YOUTUBE_HOSTS.has(address.hostname))
    id =
      parts[0] === 'watch'
        ? address.searchParams.get('v')
        : parts[0] === 'embed' || parts[0] === 'shorts'
          ? parts[1]
          : undefined;
  return typeof id === 'string' && YOUTUBE_ID.test(id) ? id : undefined;
}

function vimeoId(address: URL): string | undefined {
  if (!VIMEO_HOSTS.has(address.hostname)) return undefined;
  const parts = address.pathname.split('/').filter((part) => part !== '');
  const id = address.hostname === 'player.vimeo.com' ? parts[1] : parts[0];
  return id !== undefined && VIMEO_ID.test(id) ? id : undefined;
}

/**
 * The player's address for a YouTube or Vimeo video, or undefined when the address given
 * is not one of theirs. Built from the video's id alone: nothing else of the address
 * given is kept.
 */
export function videoEmbedUrl(video: VideoOptions): string | undefined {
  const address = parsed(video.url);
  if (address === undefined) return undefined;
  const query = new URLSearchParams();
  if (video.source === 'youtube') {
    const id = youtubeId(address);
    if (id === undefined) return undefined;
    if (video.autoplay === true) query.set('autoplay', '1');
    if (video.controls === false) query.set('controls', '0');
    if (video.loop === true) {
      query.set('loop', '1');
      query.set('playlist', id);
    }
    const text = query.toString();
    return `${VIDEO_FRAME_ORIGINS.youtube}/embed/${id}${text === '' ? '' : `?${text}`}`;
  }
  if (video.source === 'vimeo') {
    const id = vimeoId(address);
    if (id === undefined) return undefined;
    if (video.autoplay === true) query.set('autoplay', '1');
    if (video.muted === true) query.set('muted', '1');
    if (video.loop === true) query.set('loop', '1');
    if (video.controls === false) query.set('controls', '0');
    const text = query.toString();
    return `${VIDEO_FRAME_ORIGINS.vimeo}/video/${id}${text === '' ? '' : `?${text}`}`;
  }
  return undefined;
}
