// The popups' script. With no script a popup already opens from a link
// that points at it and closes from its own Close link (the `:target` rule of the page's
// stylesheet). This adds what CSS cannot do:
//
// - opening by itself: some seconds after the page loads (`data-pt="delay"`, `data-pd`),
//   or when the visitor is about to leave (`data-pt="exit"`). On a device with a pointer
//   that hovers, leaving is the pointer going out through the top of the page. On a touch
//   screen there is no such sign, so it is the visitor having read down at least one
//   screen and then scrolled back up half a screen or more, as people do to reach the
//   address bar;
// - once in a visit: a popup that opened by itself is remembered for the browser tab
//   (session storage, no cookie) and not opened by itself again, unless the page says
//   every time (`data-pf="always"`). Where storage is refused it simply opens again;
// - a dialog a keyboard and a screen reader can use (WAI-ARIA Authoring Practices, Dialog
//   (Modal) pattern): focus moves into the popup when it opens, Tab and Shift+Tab stay
//   inside it, Escape closes it, focus goes back to where it was, and the page behind is
//   inert meanwhile. Popups stand beside `main` in the page, so making `main` inert makes
//   everything but the popups inert.
//
// It reads what the renderer wrote (render.ts) and nothing else, writes no markup, asks
// nothing of any server, and runs nothing a page's author wrote.

const FOCUSABLE = 'a[href],button,input,select,textarea,iframe,[tabindex]';

/** Starts the popups of the page. */
export function startPopups(doc: Document, win: Window): void {
  const main = doc.querySelector('main');
  let open: HTMLElement | undefined;
  /** What had the focus before the first popup opened: it gets it back. */
  let before: Element | null = null;
  /** Popups that came due while another was open: each opens when its turn comes. */
  const waiting: HTMLElement[] = [];

  const popupOf = (id: string): HTMLElement | undefined => {
    const found = id === '' ? null : doc.getElementById(id);
    return found?.classList.contains('pp') === true ? found : undefined;
  };
  const key = (popup: HTMLElement): string => `pp:${win.location.pathname}:${popup.id}`;
  const seen = (popup: HTMLElement): boolean => {
    try {
      return win.sessionStorage.getItem(key(popup)) !== null;
    } catch {
      return false;
    }
  };
  const remember = (popup: HTMLElement): void => {
    try {
      win.sessionStorage.setItem(key(popup), '1');
    } catch {
      // Storage is refused or full: the popup may open again, which is all that is lost.
    }
  };
  const focusable = (popup: HTMLElement): HTMLElement[] =>
    [...popup.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (each) => each.tabIndex >= 0 && !each.hasAttribute('disabled'),
    );

  const show = (popup: HTMLElement): void => {
    if (open === popup) return;
    if (open === undefined) before = doc.activeElement;
    else open.classList.remove('on');
    open = popup;
    popup.classList.add('on');
    main?.toggleAttribute('inert', true);
    (focusable(popup)[0] ?? popup).focus();
  };

  /** Opens a popup by itself: true when it did, or will when the open one closes. */
  const offer = (popup: HTMLElement): boolean => {
    const always = popup.dataset['pf'] === 'always';
    if (open === popup || waiting.includes(popup) || (!always && seen(popup))) return false;
    if (open !== undefined) {
      waiting.push(popup);
      return true;
    }
    if (!always) remember(popup);
    show(popup);
    return true;
  };

  const close = (): void => {
    const popup = open;
    if (popup === undefined) return;
    open = undefined;
    popup.classList.remove('on');
    main?.toggleAttribute('inert', false);
    if (before instanceof HTMLElement && before.isConnected) before.focus();
    before = null;
    for (let next = waiting.shift(); next !== undefined; next = waiting.shift())
      if (offer(next)) break;
  };

  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    // Outside the box, on what dims the page.
    if (open !== undefined && target === open) {
      close();
      return;
    }
    const link = target?.closest('a[href^="#"]');
    if (link === null || link === undefined) return;
    if (open?.contains(link) === true && link.classList.contains('px')) {
      event.preventDefault();
      close();
      return;
    }
    const popup = popupOf((link.getAttribute('href') ?? '').slice(1));
    if (popup === undefined) return;
    event.preventDefault();
    show(popup);
  });

  doc.addEventListener('keydown', (event) => {
    if (open === undefined) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const inside = focusable(open);
    const first = inside[0];
    const last = inside[inside.length - 1];
    const active = doc.activeElement;
    if (first === undefined || last === undefined) {
      // Nothing to move to: the focus stays on the popup itself.
      event.preventDefault();
    } else if (event.shiftKey && (active === first || active === open)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // A page opened at a popup's own address shows it already (`:target`): make that one a
  // dialog too, and move the address off it the way its Close link would, so that from
  // here on only this script says which popup is open.
  const named = (): void => {
    const popup = popupOf(win.location.hash.slice(1));
    if (popup === undefined) return;
    show(popup);
    win.location.hash = '_';
  };
  win.addEventListener('hashchange', named);
  named();

  const leaving: HTMLElement[] = [];
  for (const popup of doc.querySelectorAll<HTMLElement>('.pp[id]')) {
    const { pt, pd } = popup.dataset;
    if (pt === 'delay') win.setTimeout(() => offer(popup), Number(pd) * 1000 || 0);
    if (pt === 'exit') leaving.push(popup);
  }
  if (leaving.length === 0) return;
  /** At most one popup for one leaving, and only the first time. */
  const leave = (): void => {
    for (const popup of leaving.splice(0)) if (offer(popup)) break;
  };
  if (win.matchMedia('(hover: hover)').matches) {
    doc.documentElement.addEventListener('mouseleave', (event) => {
      if (event.clientY <= 0) leave();
    });
    return;
  }
  let deepest = 0;
  win.addEventListener(
    'scroll',
    () => {
      deepest = Math.max(deepest, win.scrollY);
      if (deepest >= win.innerHeight && win.scrollY <= deepest - win.innerHeight / 2) leave();
    },
    { passive: true },
  );
}
