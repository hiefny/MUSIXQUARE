/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Node, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HoverPointerModule = typeof import('../hover-pointer.ts');

/**
 * Owner direction (2026-10-27, UI audit items 4 and 10): laptop and studio
 * (tablet posture) modes of one convertible must hover alike. One runtime
 * flag decides whether the user can hover right now, and every hover rule and
 * script hover check reads it.
 */
const GATE = ':where(html[data-hover-pointer])';
const NO_HOVER_GATE = ':where(html:not([data-hover-pointer]))';
const OUTSIDE_EDIT_MODE = ':where(.playlist-ul:not(.has-removal-selection))';

const STYLESHEETS = readdirSync(resolve('css'))
  .filter((file) => file.endsWith('.css'))
  .map((file) => `css/${file}`);

function pointer(type: string, pointerType: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

function installAnyHover(matches: boolean | null) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: matches ?? false,
    media: '(any-hover: hover)',
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn(),
  };
  const matchMedia = vi.fn((media: string) => {
    if (media !== '(any-hover: hover)') throw new Error(`Unexpected media query: ${media}`);
    return query;
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matches === null ? undefined : matchMedia,
  });
  return {
    matchMedia,
    change(next: boolean) {
      query.matches = next;
      const event = { matches: next, media: query.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

async function freshHoverPointer(): Promise<HoverPointerModule> {
  vi.resetModules();
  return import('../hover-pointer.ts');
}

function flagged(): boolean {
  return document.documentElement.hasAttribute('data-hover-pointer');
}

function normalized(selector: string): string {
  return selector.replace(/\s+/gu, ' ').trim();
}

interface SelectorSite {
  file: string;
  line: number;
  selector: string;
  rule: Rule;
}

function selectorSites(): SelectorSite[] {
  const sites: SelectorSite[] = [];
  for (const file of STYLESHEETS) {
    parseCss(readFileSync(resolve(file), 'utf8')).walkRules((rule) => {
      // Keyframe stops are not selectors.
      if (rule.parent?.type === 'atrule' && /keyframes$/u.test(rule.parent.name)) return;
      for (const selector of rule.selectors) {
        sites.push({
          file,
          line: rule.source?.start?.line ?? 0,
          selector: normalized(selector),
          rule,
        });
      }
    });
  }
  return sites;
}

function declarations(rule: Rule): string[] {
  const list: string[] = [];
  rule.each((node) => {
    if (node.type === 'decl') list.push(`${node.prop}: ${node.value}`);
  });
  return list;
}

/** Every rule (with its at-rule chain) that lists exactly this selector. */
function rulesFor(selector: string): { conditions: string[]; declarations: string[] }[] {
  return selectorSites()
    .filter((site) => site.selector === selector)
    .map((site) => {
      const conditions: string[] = [];
      for (let parent: Node | undefined = site.rule.parent; parent; parent = parent.parent) {
        if (parent.type !== 'atrule') continue;
        const { name, params } = parent as AtRule;
        if (name !== 'layer') conditions.push(`@${name} ${params}`);
      }
      return { conditions, declarations: declarations(site.rule) };
    });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(dir), { recursive: true, encoding: 'utf8' })
    .filter(
      (file) =>
        /\.(?:ts|tsx|mts)$/u.test(file) &&
        !file.endsWith('.d.ts') &&
        !/(?:^|[\\/])__tests__[\\/]/u.test(file),
    )
    .map((file) => join(dir, file).replaceAll('\\', '/'));
}

describe('hover pointer owner', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-hover-pointer');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-hover-pointer');
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('starts from any-hover and follows its changes', async () => {
    const anyHover = installAnyHover(true);
    const { initHoverPointer } = await freshHoverPointer();

    initHoverPointer();
    expect(flagged()).toBe(true);

    // A convertible folding into tablet posture turns its touchpad off.
    anyHover.change(false);
    expect(flagged()).toBe(false);
    anyHover.change(true);
    expect(flagged()).toBe(true);
  });

  it('marks a pen or mouse as a hover pointer and clears it on touch', async () => {
    installAnyHover(false);
    const { initHoverPointer } = await freshHoverPointer();

    initHoverPointer();
    expect(flagged()).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'touch'));
    expect(flagged()).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'pen'));
    expect(flagged()).toBe(true);

    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    expect(flagged()).toBe(true);

    document.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(flagged()).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'mouse'));
    expect(flagged()).toBe(true);
  });

  it('marks a pen or mouse on its first boundary event, before mouseenter', async () => {
    // In tablet posture the first pen or mouse movement can enter a control
    // before any pointermove; pointerover arrives ahead of mouseenter, so a
    // mouseenter handler already reads the hover flag.
    installAnyHover(false);
    const { hasHoverPointer, initHoverPointer } = await freshHoverPointer();
    initHoverPointer();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const seen: boolean[] = [];
    target.addEventListener('mouseenter', () => seen.push(hasHoverPointer()));
    try {
      target.dispatchEvent(pointer('pointerover', 'touch'));
      expect(flagged()).toBe(false);
      target.dispatchEvent(pointer('pointerover', 'pen'));
      target.dispatchEvent(new MouseEvent('mouseenter'));
      expect(seen).toEqual([true]);
      document.dispatchEvent(pointer('pointerdown', 'touch'));
      expect(flagged()).toBe(false);
      target.dispatchEvent(pointer('pointerover', 'mouse'));
      expect(flagged()).toBe(true);
    } finally {
      target.remove();
    }
  });

  it('installs once and still follows input where matchMedia is missing', async () => {
    const anyHover = installAnyHover(true);
    const { initHoverPointer } = await freshHoverPointer();
    initHoverPointer();
    initHoverPointer();
    expect(anyHover.matchMedia).toHaveBeenCalledTimes(1);

    installAnyHover(null);
    document.documentElement.removeAttribute('data-hover-pointer');
    const legacy = await freshHoverPointer();
    expect(() => legacy.initHoverPointer()).not.toThrow();
    expect(flagged()).toBe(false);
    document.dispatchEvent(pointer('pointermove', 'mouse'));
    expect(flagged()).toBe(true);
  });

  it('answers script hover checks from the same flag', async () => {
    installAnyHover(false);
    const { hasHoverPointer, initHoverPointer, isHovered } = await freshHoverPointer();
    initHoverPointer();
    const button = document.createElement('button');
    const hovered = vi.spyOn(button, 'matches').mockReturnValue(true);

    // A touch press leaves :hover latched on the tapped element; that is not hover.
    expect(hasHoverPointer()).toBe(false);
    expect(isHovered(button)).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'mouse'));
    expect(hasHoverPointer()).toBe(true);
    expect(isHovered(button)).toBe(true);
    expect(hovered).toHaveBeenLastCalledWith(':hover');

    hovered.mockReturnValue(false);
    expect(isHovered(button)).toBe(false);
  });

  it('is installed on its own, before every UI module', () => {
    const app = readFileSync(resolve('src/app.ts'), 'utf8');
    const install = app.indexOf("safeInit('HoverPointer', initHoverPointer);");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(app.indexOf("safeInit('OverlayObservers'"));
    // A failing hover owner must not take the playlist down with it.
    expect(app).toContain("safeInit('PlaylistView', initPlaylistView);");
    expect(app.match(/initHoverPointer\(/gu) ?? []).toHaveLength(0);
  });
});

/**
 * The rest of a selector after its leading gate, or null without one. The gate
 * is followed by a descendant (` .row:hover`) or by more conditions on the
 * same html element (`[data-theme='light'] .row:hover`).
 */
function afterGate(selector: string, gate: string): string | null {
  if (!selector.startsWith(gate)) return null;
  const rest = selector.slice(gate.length);
  return rest.startsWith(' ') || rest.startsWith('[') ? rest : null;
}

describe('one hover gate in the app stylesheets', () => {
  it('puts every :hover rule under the runtime gate', () => {
    const outside = selectorSites()
      .filter((site) => site.selector.includes(':hover'))
      .filter((site) => afterGate(site.selector, GATE) === null)
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(outside).toEqual([]);
  });

  it('keeps html-level conditions on the gated html element itself', () => {
    // The gate, data-theme and data-contrast all live on <html>: written as a
    // descendant of the gate, such a condition could never match.
    const unreachable = selectorSites()
      .filter((site) => {
        const rest = afterGate(site.selector, GATE) ?? afterGate(site.selector, NO_HOVER_GATE);
        return rest !== null && /^ (?:html\b|:root\b|\[data-(?:theme|contrast)\b)/u.test(rest);
      })
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(unreachable).toEqual([]);
  });

  it('uses the flag only as the leading, zero-specificity gate', () => {
    const misplaced = selectorSites()
      .filter((site) => site.selector.includes('data-hover-pointer'))
      .filter((site) => {
        const rest =
          afterGate(site.selector, GATE) ??
          afterGate(site.selector, NO_HOVER_GATE) ??
          site.selector;
        return rest.includes('data-hover-pointer');
      })
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(misplaced).toEqual([]);

    const hoverWithoutHover = selectorSites()
      .filter((site) => afterGate(site.selector, NO_HOVER_GATE) !== null)
      .filter((site) => site.selector.includes(':hover'))
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(hoverWithoutHover).toEqual([]);
  });

  it('asks no media query whether the user can hover or how coarse the pointer is', () => {
    const queries: string[] = [];
    for (const file of STYLESHEETS) {
      parseCss(readFileSync(resolve(file), 'utf8')).walkAtRules((rule) => {
        if (/\b(?:any-)?(?:hover|pointer)\s*:/u.test(rule.params)) {
          queries.push(`${file}:${rule.source?.start?.line ?? 0} @${rule.name} ${rule.params}`);
        }
      });
    }
    expect(queries).toEqual([]);
  });

  it('leaves hover detection in scripts to hover-pointer.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file === 'src/ui/hover-pointer.ts') continue;
      const source = readFileSync(resolve(file), 'utf8');
      if (
        /['"`][^'"`\n]*\((?:any-)?(?:hover|pointer)\s*:/u.test(source) ||
        /['"`][^'"`\n]*:hover\b/u.test(source)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets only hover-pointer.ts write the hover flag', () => {
    const writers: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file === 'src/ui/hover-pointer.ts') continue;
      const source = readFileSync(resolve(file), 'utf8');
      if (/data-hover-pointer|hoverPointer/u.test(source)) writers.push(file);
    }
    expect(writers).toEqual([]);
  });
});

describe('playlist row icons on the hover gate', () => {
  it('turns the minus blue on hover and on keyboard focus', () => {
    expect(rulesFor(`${GATE} .btn-playlist-select:hover`)).toEqual([
      { conditions: [], declarations: ['color: var(--primary)'] },
    ]);
    const focus = rulesFor('.btn-playlist-select:focus-visible');
    expect(focus).toHaveLength(1);
    expect(focus[0]!.conditions).toEqual([]);
    expect(focus[0]!.declarations).toContain('color: var(--primary)');
  });

  it('turns the expand chevron blue on hover and on keyboard focus, like the minus', () => {
    const hover = rulesFor(`${GATE} .expand-toggle:hover`);
    expect(hover).toHaveLength(1);
    expect(hover[0]!.declarations).toContain('color: var(--primary)');
    const focus = rulesFor('.expand-toggle:focus-visible');
    expect(focus).toHaveLength(1);
    expect(focus[0]!.conditions).toEqual([]);
    expect(focus[0]!.declarations).toContain('color: var(--primary)');
  });

  it('reveals the reorder grip on row hover only outside edit mode', () => {
    for (const target of ['.track-idx', '.playlist-reorder-grip']) {
      const rowHover = selectorSites().filter((site) =>
        site.selector.includes(`.track-item:hover .playlist-reorder-handle ${target}`),
      );
      expect(rowHover.map((site) => site.selector)).toEqual([
        `${GATE} ${OUTSIDE_EDIT_MODE} .track-item:hover .playlist-reorder-handle ${target}`,
      ]);
    }
    // Keyboard focus reveals the grip whatever the pointer can do.
    expect(rulesFor('.playlist-reorder-handle:focus-visible .playlist-reorder-grip')).toEqual([
      { conditions: [], declarations: ['opacity: 1', 'transform: scale(1)'] },
    ]);
    expect(rulesFor('.playlist-reorder-handle:focus-visible .track-idx')).toEqual([
      { conditions: [], declarations: ['opacity: 0', 'transform: scale(0.82)'] },
    ]);
  });

  it('lights the minus instead of the grip when an edit-mode row is hovered', () => {
    expect(
      rulesFor(`${GATE} .playlist-ul.has-removal-selection .track-item:hover .btn-playlist-select`),
    ).toEqual([{ conditions: [], declarations: ['color: var(--primary)'] }]);
  });
});
