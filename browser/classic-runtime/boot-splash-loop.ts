/**
 * Looping boot-splash preview runtime for /designsystem (embedded under
 * Loading states) and /designsystem/loading (standalone full-screen view).
 *
 * Uses the exact nonzero compound-path mask reveal from wordmark-anim.ts and
 * the 9.0.843 rise + Material Elastic Spinner choreography, then holds for
 * 3 s before a smooth 0.9 s fade-out to a blank stage and seamless restart.
 */
(function installBootSplashLoop() {
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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPLASH_MARK_DELAY = 300;
  const DRAW_BASE_DELAY = 500;
  const GHOST_START = 2500;
  const GHOST_DURATION = 400;
  const END = GHOST_START + GHOST_DURATION;
  const RISE_DURATION = 1200;
  const HOLD_AFTER_LOADER_MS = 3000;
  const FADEOUT_DURATION = 950;
  const BLANK_HOLD_MS = 600;

  let nextMaskId = 0;
  let motionQuery: MediaQueryList | undefined;
  try {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  } catch {
    // Older embedded browsers still run the bounded reveal loop.
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

  function readStroke(element: SVGElement): Stroke | null {
    const number = (name: string) => Number(element.getAttribute(name));
    const delay = DRAW_BASE_DELAY + Number(element.dataset.wt);
    const duration = Number(element.dataset.wd);
    const direction = (['wlr', 'wrl', 'wtb', 'wbt', 'wdiag'] as const).find((name) =>
      element.classList.contains(name),
    );
    if (!direction || !Number.isFinite(delay) || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }
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
    } else {
      return null;
    }
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

  function outline(stroke: Stroke, elapsed: number): string {
    const progress = ease((elapsed - stroke.delay) / stroke.duration);
    if (progress <= 0) return '';
    let points = stroke.points;
    const { x, y, width, height, direction } = stroke;
    if (direction === 'wlr' || direction === 'wdiag') {
      points = clip(points, 0, x + width * progress, false);
    }
    if (direction === 'wrl') points = clip(points, 0, x + width * (1 - progress), true);
    if (direction === 'wtb' || direction === 'wdiag') {
      points = clip(points, 1, y + height * progress, false);
    }
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

  function mountLoop(container: HTMLElement): void {
    const stage = container.querySelector<HTMLElement>('[data-boot-splash-stage]');
    const initialMark = stage?.querySelector<HTMLElement>('.boot-splash-mark');
    if (!stage || !initialMark) return;

    const markBlueprint = initialMark.cloneNode(true) as HTMLElement;
    const embedded = container.dataset.bootSplashLoop === 'embedded';
    let inView = !embedded;
    let rafId: number | null = null;
    let timers: number[] = [];
    let cycleToken = 0;

    function clearPending(): void {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      for (const timerId of timers) window.clearTimeout(timerId);
      timers = [];
    }

    function after(ms: number, fn: () => void, token: number): void {
      const timerId = window.setTimeout(() => {
        if (token !== cycleToken) return;
        fn();
      }, ms);
      timers.push(timerId);
    }

    function settleStatic(): void {
      clearPending();
      cycleToken++;
      delete container.dataset.loop;
      container.dataset.phase = 'settled';
      const freshMark = markBlueprint.cloneNode(true) as HTMLElement;
      stage!.replaceChildren(freshMark);
      const svg = freshMark.querySelector<SVGSVGElement>('.boot-splash-logo');
      if (svg) svg.dataset.wordmarkReady = 'true';
    }

    function runCycle(): void {
      clearPending();
      const token = ++cycleToken;

      if (motionQuery?.matches) {
        settleStatic();
        return;
      }
      if (document.hidden || !inView) return;

      delete container.dataset.phase;
      delete container.dataset.loop;
      const freshMark = markBlueprint.cloneNode(true) as HTMLElement;
      stage!.replaceChildren(freshMark);

      const svg = freshMark.querySelector<SVGSVGElement>('.boot-splash-logo');
      const ink = svg?.querySelector<SVGGElement>(':scope > .wg');
      const defs = svg?.querySelector('defs');
      if (!svg || !ink || !defs) {
        settleStatic();
        return;
      }

      const strokes: Stroke[] = [];
      for (const element of svg.querySelectorAll<SVGElement>('[data-wordmark-strokes] [data-wt]')) {
        const stroke = readStroke(element);
        if (!stroke) {
          settleStatic();
          return;
        }
        strokes.push(stroke);
      }
      if (strokes.length === 0) {
        settleStatic();
        return;
      }
      const drawEnd = Math.max(...strokes.map((stroke) => stroke.delay + stroke.duration));

      const mask = document.createElementNS(SVG_NS, 'mask');
      let maskId: string;
      do {
        maskId = `mxqr-wordmark-loop-${++nextMaskId}`;
      } while (document.getElementById(maskId));
      mask.id = maskId;
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
      ink.setAttribute('mask', `url(#${maskId})`);
      svg.dataset.wordmarkReady = 'true';

      let loaderEntered = false;
      function enterLoader(): void {
        if (loaderEntered || token !== cycleToken) return;
        loaderEntered = true;
        container.dataset.phase = 'loader';
        after(
          RISE_DURATION + HOLD_AFTER_LOADER_MS,
          () => {
            container.dataset.loop = 'fadeout';
            after(
              FADEOUT_DURATION,
              () => {
                container.dataset.loop = 'blank';
                after(BLANK_HOLD_MS, runCycle, token);
              },
              token,
            );
          },
          token,
        );
      }

      after(
        SPLASH_MARK_DELAY,
        () => {
          const startTime = performance.now();
          function frame(): void {
            rafId = null;
            if (token !== cycleToken) return;
            const elapsed = performance.now() - startTime;
            if (elapsed >= Math.max(END, drawEnd)) {
              ink!.removeAttribute('mask');
              mask.remove();
              enterLoader();
              return;
            }
            reveal.setAttribute('d', strokes.map((stroke) => outline(stroke, elapsed)).join(''));
            ghost.setAttribute(
              'opacity',
              String(
                0.15 + 0.85 * ease((elapsed - GHOST_START) / GHOST_DURATION, 0.25, 0.1, 0.25, 1),
              ),
            );
            if (elapsed >= drawEnd) {
              enterLoader();
            }
            if (!document.hidden && inView) {
              rafId = requestAnimationFrame(frame);
            }
          }
          rafId = requestAnimationFrame(frame);
        },
        token,
      );
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearPending();
      } else if (inView) {
        runCycle();
      }
    });

    if (motionQuery) {
      const onMotionChange = () => {
        if (motionQuery?.matches) settleStatic();
        else if (!document.hidden && inView) runCycle();
      };
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', onMotionChange);
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(onMotionChange);
      }
    }

    if (embedded && typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting);
          if (visible === inView) return;
          inView = visible;
          if (inView) {
            runCycle();
          } else {
            clearPending();
          }
        },
        { threshold: 0.1 },
      );
      observer.observe(container);
    } else {
      inView = true;
      runCycle();
    }
  }

  for (const container of document.querySelectorAll<HTMLElement>('[data-boot-splash-loop]')) {
    mountLoop(container);
    if (
      container.dataset.bootSplashLoop === 'fullscreen' &&
      container instanceof HTMLAnchorElement
    ) {
      const cameFromDesignSystem = (() => {
        try {
          if (!document.referrer || window.history.length <= 1) return false;
          const ref = new URL(document.referrer);
          return (
            ref.origin === window.location.origin &&
            (ref.pathname === '/designsystem' || ref.pathname === '/designsystem/')
          );
        } catch {
          return false;
        }
      })();
      container.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        if (cameFromDesignSystem) {
          event.preventDefault();
          window.history.back();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          container.click();
        }
      });
    }
  }
})();
