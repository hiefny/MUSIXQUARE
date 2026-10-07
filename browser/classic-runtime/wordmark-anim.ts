/**
 * Draw one wordmark silhouette through an exact, nonzero compound-path mask.
 * Every revealed polygon has the same winding, so shared edges are rasterized
 * together without widening a reveal into a stroke that has not started yet.
 *
 * Setup owns when the entrance is visible and sends mxqr:wordmark-start once.
 * Its desktop-header copier sends mxqr:wordmark-refresh after replacing markup.
 * With no runtime (or invalid geometry), the authored silhouette stays visible.
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
  if (root.hasAttribute('data-wordmark-runtime-ready')) {
    document.dispatchEvent(new CustomEvent('mxqr:wordmark-refresh'));
    return;
  }
  root.setAttribute('data-wordmark-runtime-ready', 'true');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DRAW_BASE_DELAY = 500;
  const GHOST_START = 2500;
  const GHOST_DURATION = 400;
  const END = GHOST_START + GHOST_DURATION;
  const instances = new Map<SVGSVGElement, Instance>();
  const completed = new WeakSet<SVGSVGElement>();
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

  function complete(svg: SVGSVGElement): void {
    svg.dataset.wordmarkDrawComplete = 'true';
    if (completed.has(svg)) return;
    completed.add(svg);
    svg.dispatchEvent(new CustomEvent('mxqr:wordmark-draw-complete', { bubbles: true }));
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
    if (settled || motion?.matches || completed.has(svg)) {
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
      if (elapsed >= instance.drawEnd) complete(instance.svg);
    }
    if (elapsed >= END && instances.size === 0) settled = true;
    if (instances.size > 0 && !document.hidden) frame = requestAnimationFrame(render);
  }

  function refresh(): void {
    if (startTime === null) return;
    stopFrame();
    document.querySelectorAll<SVGSVGElement>('.logo-welcome').forEach(initialize);
    render();
  }

  function start(): void {
    if (startTime !== null) return;
    startTime = performance.now();
    // A delayed/blocked classic asset must never replay behind an already shown greeting.
    settled = Boolean(
      motion?.matches || document.querySelector('.setup-brand-greeting-stage.is-greeting-visible'),
    );
    refresh();
  }

  document.addEventListener('mxqr:wordmark-start', start);
  document.addEventListener('mxqr:wordmark-refresh', refresh);
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
  if (root.hasAttribute('data-wordmark-start-requested')) start();
})();
