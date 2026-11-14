/**
 * Draw the boot splash's wordmark (index.html) through an exact, nonzero
 * compound-path mask. Every revealed polygon has the same winding, so shared
 * edges are rasterized together without widening a reveal into a stroke that
 * has not started yet.
 *
 * Loaded async right after the splash, so it runs as soon as it arrives. It
 * draws once at the centre, from the moment the splash shows its mark (0.3 s
 * after the page's first byte), while the splash is still up; once drawn it
 * sets the splash's data-phase="loader", and the wordmark rises while the
 * loader fades in below. It leaves the wordmark drawn instead when the CSS
 * fallback has already shown the static wordmark (1.8 s, the rise then
 * follows at the fallback's 3.2 s, or at once when that has passed:
 * data-phase="settled"), with reduced motion, and after an app reset, whose
 * refresh screen showed the wordmark and loader in their final place: the new
 * page then shows them there at once (settled). When the app takes the screen
 * mid-draw, the drawing stops where it is and fades out with the splash; a
 * runtime that arrives after that leaves the splash as it is. The splash's
 * loader runs on the wall clock's phase, as the refresh screen's does, so it
 * does not jump across that reload. With no runtime (or invalid geometry), the
 * CSS fallback shows the authored silhouette and rises at 3.2 s.
 */
(function installWordmarkReveal() {
  type Point = [number, number];
  type Direction = 'wlr' | 'wrl' | 'wtb' | 'wbt' | 'wdiag';
  interface Stroke {
    points: Point[];
    direction: Direction;
    delay: number;
    duration: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }
  interface Instance {
    svg: SVGSVGElement;
    ink: SVGGElement;
    mask: SVGMaskElement;
    reveal: SVGPathElement;
    ghost: SVGRectElement;
    strokes: Stroke[];
    drawEnd: number;
  }

  const root = document.documentElement;
  if (root.hasAttribute('data-wordmark-runtime-ready')) return;
  root.setAttribute('data-wordmark-runtime-ready', 'true');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The splash shows its mark 0.3 s after it first styles, its CSS fallback
  // shows the static wordmark at 1.8 s and rises at 3.2 s, and its fade over
  // the app takes 0.3 s (index.html, boot-splash test pins these copies).
  const SPLASH_MARK_DELAY = 300;
  const SPLASH_INK_FALLBACK = 1800;
  const SPLASH_RISE_FALLBACK = 3200;
  const SPLASH_FADE = 300;
  // A drawing that never reports its end still lets the loader join this late.
  const SPLASH_RISE_GRACE = 300;
  // Written by src/core/session-reset.ts just before an app reset navigates.
  const CONTINUITY_KEY = 'mxqr-boot-continuity';
  const CONTINUITY_WINDOW = 15_000;
  const DRAW_BASE_DELAY = 500;
  const GHOST_START = 2500;
  const GHOST_DURATION = 400;
  const END = GHOST_START + GHOST_DURATION;
  const instances = new Map<SVGSVGElement, Instance>();
  let startTime: number | null = null;
  let settled = false;
  let frame: number | null = null;
  let nextMaskId = 0;
  let motion: MediaQueryList | undefined;
  try {
    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch {
    // Older embedded browsers still get the bounded reveal and static fallback.
  }

  /** The wordmark stands drawn (the splash CSS stops showing its fallback). */
  function complete(svg: SVGSVGElement): void {
    svg.dataset.wordmarkReady = 'true';
    svg.dataset.wordmarkDrawComplete = 'true';
  }

  function clean(svg: SVGSVGElement): SVGGElement | null {
    const ink = svg.querySelector<SVGGElement>(':scope > .wg');
    ink?.removeAttribute('mask');
    svg.querySelectorAll('[data-wordmark-mask]').forEach((mask) => mask.remove());
    return ink;
  }

  function finish(instance: Instance): void {
    instance.ink.removeAttribute('mask');
    instance.mask.remove();
    instances.delete(instance.svg);
    complete(instance.svg);
  }

  function stopFrame(): void {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  }

  function settle(): void {
    settled = true;
    stopFrame();
    for (const instance of instances.values()) finish(instance);
  }

  /**
   * Stop drawing where it is, mask and all: the splash is fading out over the
   * app. Drawing the rest at once would flash the whole wordmark in that fade.
   */
  function freeze(): void {
    settled = true;
    stopFrame();
  }

  function readStroke(element: SVGElement): Stroke | null {
    const number = (name: string) => Number(element.getAttribute(name));
    const delay = DRAW_BASE_DELAY + Number(element.dataset.wt);
    const duration = Number(element.dataset.wd);
    const direction = (['wlr', 'wrl', 'wtb', 'wbt', 'wdiag'] as const).find((name) =>
      element.classList.contains(name),
    );
    if (!direction || !Number.isFinite(delay) || !Number.isFinite(duration) || duration <= 0)
      return null;
    let points: Point[];
    if (element.localName === 'rect') {
      const x = number('x');
      const y = number('y');
      const width = number('width');
      const height = number('height');
      if (!(width > 0 && height > 0)) return null;
      points = [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ];
    } else if (element.localName === 'polygon') {
      const values = (element.getAttribute('points') ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (values.length < 6 || values.length % 2 !== 0) return null;
      points = [];
      for (let index = 0; index < values.length; index += 2) {
        points.push([values[index]!, values[index + 1]!]);
      }
    } else return null;
    if (!points.every((point) => point.every(Number.isFinite))) return null;
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    if (!(width > 0 && height > 0)) return null;
    return { points, direction, delay, duration, x, y, width, height };
  }

  function initialize(svg: SVGSVGElement): void {
    if (instances.has(svg)) return;
    const ink = clean(svg);
    if (!ink) return;
    if (settled || motion?.matches || svg.dataset.wordmarkDrawComplete === 'true') {
      complete(svg);
      return;
    }
    delete svg.dataset.wordmarkDrawComplete;
    const strokes: Stroke[] = [];
    for (const element of svg.querySelectorAll<SVGElement>('[data-wordmark-strokes] [data-wt]')) {
      const stroke = readStroke(element);
      if (!stroke) {
        complete(svg);
        return;
      }
      strokes.push(stroke);
    }
    const defs = svg.querySelector('defs');
    if (strokes.length === 0 || !defs) {
      complete(svg);
      return;
    }

    const mask = document.createElementNS(SVG_NS, 'mask');
    let id: string;
    do {
      id = `mxqr-wordmark-reveal-${++nextMaskId}`;
    } while (document.getElementById(id));
    mask.id = id;
    mask.setAttribute('data-wordmark-mask', '');
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'alpha');
    mask.setAttribute('x', '40');
    mask.setAttribute('y', '8');
    mask.setAttribute('width', '220');
    mask.setAttribute('height', '34');
    const ghost = document.createElementNS(SVG_NS, 'rect');
    ghost.setAttribute('data-wordmark-ghost', '');
    ghost.setAttribute('x', '40');
    ghost.setAttribute('y', '8');
    ghost.setAttribute('width', '220');
    ghost.setAttribute('height', '34');
    ghost.setAttribute('fill', 'white');
    ghost.setAttribute('opacity', '.15');
    const reveal = document.createElementNS(SVG_NS, 'path');
    reveal.setAttribute('data-wordmark-reveal', '');
    reveal.setAttribute('fill', 'white');
    reveal.setAttribute('fill-rule', 'nonzero');
    mask.append(ghost, reveal);
    defs.append(mask);
    ink.setAttribute('mask', `url(#${id})`);
    // The ink is now masked: the splash CSS stops hiding it.
    svg.dataset.wordmarkReady = 'true';
    instances.set(svg, {
      svg,
      ink,
      mask,
      reveal,
      ghost,
      strokes,
      drawEnd: Math.max(...strokes.map((stroke) => stroke.delay + stroke.duration)),
    });
  }

  function cubic(time: number, a: number, b: number): number {
    return 3 * (1 - time) * (1 - time) * time * a + 3 * (1 - time) * time * time * b + time ** 3;
  }

  function ease(value: number, x1 = 0.15, y1 = 0.5, x2 = 0.05, y2 = 1): number {
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    let low = 0;
    let high = 1;
    for (let index = 0; index < 24; index++) {
      const time = (low + high) / 2;
      if (cubic(time, x1, x2) < value) low = time;
      else high = time;
    }
    return cubic((low + high) / 2, y1, y2);
  }

  function clip(points: Point[], axis: 0 | 1, edge: number, greater: boolean): Point[] {
    const result: Point[] = [];
    const inside = (point: Point) => (greater ? point[axis] >= edge : point[axis] <= edge);
    for (let index = 0; index < points.length; index++) {
      const a = points[(index + points.length - 1) % points.length]!;
      const b = points[index]!;
      const aInside = inside(a);
      const bInside = inside(b);
      if (aInside !== bInside) {
        const fraction = (edge - a[axis]) / (b[axis] - a[axis]);
        result.push([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]);
      }
      if (bInside) result.push(b);
    }
    return result;
  }

  function outline(stroke: Stroke, elapsed: number): string {
    const progress = ease((elapsed - stroke.delay) / stroke.duration);
    if (progress <= 0) return '';
    let points = stroke.points;
    const { x, y, width, height, direction } = stroke;
    if (direction === 'wlr' || direction === 'wdiag')
      points = clip(points, 0, x + width * progress, false);
    if (direction === 'wrl') points = clip(points, 0, x + width * (1 - progress), true);
    if (direction === 'wtb' || direction === 'wdiag')
      points = clip(points, 1, y + height * progress, false);
    if (direction === 'wbt') points = clip(points, 1, y + height * (1 - progress), true);
    if (points.length < 3) return '';
    const area = points.reduce((sum, a, index) => {
      const b = points[(index + 1) % points.length]!;
      return sum + a[0] * b[1] - b[0] * a[1];
    }, 0);
    if (Math.abs(area) < 1e-10) return '';
    if (area < 0) points = [...points].reverse();
    return (
      points
        .map(
          (point, index) =>
            `${index ? 'L' : 'M'}${point.map((n) => Number(n.toFixed(7))).join(' ')}`,
        )
        .join('') + 'Z'
    );
  }

  function render(): void {
    frame = null;
    if (startTime === null || settled) return;
    const elapsed = performance.now() - startTime;
    for (const instance of instances.values()) {
      if (!instance.svg.isConnected) {
        // A detached header may be inserted again; leave its silhouette usable.
        instance.ink.removeAttribute('mask');
        instance.mask.remove();
        instances.delete(instance.svg);
        continue;
      }
      if (elapsed >= Math.max(END, instance.drawEnd)) {
        finish(instance);
        continue;
      }
      instance.reveal.setAttribute(
        'd',
        instance.strokes.map((stroke) => outline(stroke, elapsed)).join(''),
      );
      instance.ghost.setAttribute(
        'opacity',
        String(0.15 + 0.85 * ease((elapsed - GHOST_START) / GHOST_DURATION, 0.25, 0.1, 0.25, 1)),
      );
      if (elapsed >= instance.drawEnd) {
        complete(instance.svg);
        enterSplashPhase('loader');
      }
    }
    if (elapsed >= END && instances.size === 0) settled = true;
    if (instances.size > 0 && !document.hidden) frame = requestAnimationFrame(render);
  }

  function refresh(): void {
    if (startTime === null) return;
    stopFrame();
    render();
  }

  function start(): void {
    if (startTime !== null || settled) return;
    if (!splashUp()) {
      freeze();
      return;
    }
    startTime = performance.now();
    settled = Boolean(motion?.matches);
    if (settled) settle();
    else refresh();
  }

  /**
   * Move the splash to its next phase once: 'loader' (the wordmark rises and
   * the loader fades in) or 'settled' (the final place at once, no motion).
   */
  function enterSplashPhase(phase: 'loader' | 'settled'): void {
    const splash = document.querySelector<HTMLElement>('.boot-splash');
    if (!splash || splash.dataset.phase || !splashUp()) return;
    splash.dataset.phase = phase;
  }

  /** The splash still covers the page: the app has not taken the screen and boot has not failed. */
  function splashUp(): boolean {
    const classes = root.classList;
    return (
      classes.contains('setup-boot-block') &&
      !classes.contains('boot-splash-released') &&
      !classes.contains('setup-boot-failed')
    );
  }

  /** When the page's document began to arrive, on this page's clock. */
  function documentArrival(): number {
    try {
      const entry = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined;
      if (entry && entry.responseStart > 0) return entry.responseStart;
    } catch {
      // Older engines without navigation timing fall back to the runtime's start.
    }
    return performance.now();
  }

  /** Whether an app reset just navigated here (it showed the same wordmark and loader). */
  function takeContinuity(): boolean {
    try {
      const value = Number(sessionStorage.getItem(CONTINUITY_KEY));
      sessionStorage.removeItem(CONTINUITY_KEY);
      return Number.isFinite(value) && value > 0 && Date.now() - value < CONTINUITY_WINDOW;
    } catch {
      return false;
    }
  }

  /** Run a loader's animations on the wall clock's phase, as the refresh screen's loader does. */
  function alignToWallClock(spinner: Element | null): void {
    if (!spinner) return;
    const now = Date.now();
    for (const element of spinner.querySelectorAll<SVGElement>(':scope > svg, circle')) {
      const period = Number.parseFloat(getComputedStyle(element).animationDuration) * 1000;
      if (Number.isFinite(period) && period > 0) {
        element.style.animationDelay = `${-(now % period)}ms`;
      }
    }
  }

  /**
   * Take the splash out of rendering once its fade over the app has ended (or
   * its last-resort fade-out), so nothing inside it keeps animating hidden.
   * The loader keeps turning through the fade itself.
   */
  function retireSplashAfterFade(splash: HTMLElement | null): void {
    if (!splash) return;
    const retire = () => {
      splash.hidden = true;
    };
    splash.addEventListener('animationend', (event) => {
      if (event.target !== splash) return;
      if (
        event.animationName === 'boot-splash-out' ||
        event.animationName === 'boot-splash-fail-open'
      ) {
        retire();
      }
    });
    // Arrived after the app had already taken the screen: the fade may be over.
    if (!splashUp()) window.setTimeout(retire, SPLASH_FADE + 100);
  }

  function boot(): void {
    retireSplashAfterFade(document.querySelector<HTMLElement>('.boot-splash'));
    const svg = document.querySelector<SVGSVGElement>('.boot-splash-logo');
    if (!svg) return;
    alignToWallClock(document.querySelector('.boot-splash .boot-splash-spinner'));
    // Read (and clear) the reset's stamp first, so it never outlives this page.
    const continued = takeContinuity();
    // The app already took the screen: the splash fades out as it stands.
    if (!splashUp()) return;
    if (continued) {
      enterSplashPhase('settled');
      complete(svg);
      return;
    }
    const arrival = documentArrival();
    const sinceArrival = performance.now() - arrival;
    const riseAt = (ms: number) =>
      window.setTimeout(() => enterSplashPhase('loader'), Math.max(0, ms - sinceArrival));
    if (sinceArrival >= SPLASH_RISE_FALLBACK) {
      // The CSS fallback already showed the wordmark and raised it.
      enterSplashPhase('settled');
      complete(svg);
      return;
    }
    if (sinceArrival >= SPLASH_INK_FALLBACK) {
      // The static wordmark already showed; keep the fallback's rise time.
      complete(svg);
      riseAt(SPLASH_RISE_FALLBACK);
      return;
    }
    initialize(svg);
    if (!instances.has(svg)) {
      // Reduced motion or invalid geometry: the wordmark stands drawn.
      enterSplashPhase('loader');
      return;
    }
    // Stop where it is when the app takes the screen or boot fails mid-draw.
    const observer = new MutationObserver(() => {
      if (splashUp()) return;
      observer.disconnect();
      freeze();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const startIn = Math.max(0, SPLASH_MARK_DELAY - sinceArrival);
    window.setTimeout(start, startIn);
    // The drawing reports its end (render); a frame loop that never gets
    // there (a suspended tab) still lets the loader join just after.
    riseAt(sinceArrival + startIn + (instances.get(svg)?.drawEnd ?? 0) + SPLASH_RISE_GRACE);
  }

  document.addEventListener('visibilitychange', () => {
    stopFrame();
    if (!document.hidden) refresh();
  });
  window.addEventListener('pagehide', settle);
  const reduceMotion = () => {
    if (motion?.matches) settle();
  };
  if (motion?.addEventListener) motion.addEventListener('change', reduceMotion);
  else motion?.addListener(reduceMotion);
  boot();
})();
