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

/**
 * Owner request (2026-11-18): a focus ring is for a person navigating by
 * keyboard. A click, a tap, a key that only plays or types, or a window that
 * opens by itself never brings one. The same owner marks
 * <html data-keyboard-navigation="on|off">, and every focus ring rule reads
 * it through one leading gate. Without the owner (a page where the app script
 * never ran) the attribute is absent and the browser's own :focus-visible
 * decides, as before.
 */
const RING = ":where(html:not([data-keyboard-navigation='off']))";
const NO_RING = ":where(html[data-keyboard-navigation='off'])";
const FORCED = '@media (forced-colors: active)';
const FORCED_FIELDS =
  ":is(input:not([type='range']):not([type='hidden']), textarea, select, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], [role='combobox'])";
const FORCED_CONTROLS = ":is(a, button, [role='button'], [role='switch'], [role='tab'])";

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
      if (/data-hover-pointer|\bhoverPointer\b/u.test(source)) writers.push(file);
    }
    expect(writers).toEqual([]);
  });
});

describe('playlist row icons on the hover gate', () => {
  it('turns the minus blue on hover and on keyboard focus', () => {
    expect(rulesFor(`${GATE} .btn-playlist-select:hover`)).toEqual([
      { conditions: [], declarations: ['color: var(--primary)'] },
    ]);
    const focus = rulesFor(`${RING} .btn-playlist-select:focus-visible`);
    expect(focus).toHaveLength(1);
    expect(focus[0]!.conditions).toEqual([]);
    expect(focus[0]!.declarations).toContain('color: var(--primary)');
  });

  it('turns the expand chevron blue on hover and on keyboard focus, like the minus', () => {
    const hover = rulesFor(`${GATE} .expand-toggle:hover`);
    expect(hover).toHaveLength(1);
    expect(hover[0]!.declarations).toContain('color: var(--primary)');
    const focus = rulesFor(`${RING} .expand-toggle:focus-visible`);
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
    expect(
      rulesFor(`${RING} .playlist-reorder-handle:focus-visible .playlist-reorder-grip`),
    ).toEqual([{ conditions: [], declarations: ['opacity: 1', 'transform: scale(1)'] }]);
    expect(rulesFor(`${RING} .playlist-reorder-handle:focus-visible .track-idx`)).toEqual([
      { conditions: [], declarations: ['opacity: 0', 'transform: scale(0.82)'] },
    ]);
  });

  it('lights the minus instead of the grip when an edit-mode row is hovered', () => {
    expect(
      rulesFor(`${GATE} .playlist-ul.has-removal-selection .track-item:hover .btn-playlist-select`),
    ).toEqual([{ conditions: [], declarations: ['color: var(--primary)'] }]);
  });
});

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

function keyboardNavigation(): string | null {
  return document.documentElement.getAttribute('data-keyboard-navigation');
}

function mount(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const element = holder.firstElementChild as HTMLElement;
  document.body.appendChild(element);
  return element;
}

/** Selector text with whitespace collapsed and none just inside parentheses. */
function compact(selector: string): string {
  return selector.replace(/\s+/gu, ' ').replace(/\(\s+/gu, '(').replace(/\s+\)/gu, ')').trim();
}

/** Every rule listing this selector, with its media conditions and declarations. */
function compactRulesFor(selector: string): { conditions: string[]; declarations: string[] }[] {
  return selectorSites()
    .filter((site) => compact(site.selector) === compact(selector))
    .map((site) => {
      const conditions: string[] = [];
      for (let parent: Node | undefined = site.rule.parent; parent; parent = parent.parent) {
        if (parent.type !== 'atrule') continue;
        const { name, params } = parent as AtRule;
        if (name !== 'layer') conditions.push(`@${name} ${compact(params)}`);
      }
      const list: string[] = [];
      site.rule.each((node) => {
        if (node.type === 'decl') {
          list.push(`${node.prop}: ${compact(node.value)}${node.important ? ' !important' : ''}`);
        }
      });
      return { conditions, declarations: list };
    });
}

/** Panels the skip link and a click on their empty space can focus. */
const TAB_PANELS = ['tab-play', 'tab-playlist', 'tab-connect', 'tab-guide', 'tab-settings'];

describe('keyboard navigation owner', () => {
  let installed: HoverPointerModule;

  beforeEach(async () => {
    document.documentElement.removeAttribute('data-keyboard-navigation');
    installAnyHover(true);
    installed = await freshHoverPointer();
    installed.initHoverPointer();
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-keyboard-navigation');
    document.documentElement.removeAttribute('data-hover-pointer');
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('starts with no keyboard navigation, so a window opening by itself draws no ring', () => {
    expect(keyboardNavigation()).toBe('off');
  });

  it('turns keyboard navigation on with Tab and Shift+Tab, and off on every press', () => {
    for (const pointerType of ['mouse', 'pen', 'touch']) {
      press(document.body, 'Tab');
      expect(keyboardNavigation(), pointerType).toBe('on');
      // Moving a pointer is not a press: a keyboard user may nudge the mouse.
      document.dispatchEvent(pointer('pointermove', pointerType));
      document.dispatchEvent(pointer('pointerover', pointerType));
      expect(keyboardNavigation(), pointerType).toBe('on');
      document.dispatchEvent(pointer('pointerdown', pointerType));
      expect(keyboardNavigation(), pointerType).toBe('off');
    }
    press(document.body, 'Tab', { shiftKey: true });
    expect(keyboardNavigation()).toBe('on');
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    // Safari moves focus to every control with Option+Tab.
    press(document.body, 'Tab', { altKey: true });
    expect(keyboardNavigation()).toBe('on');
  });

  it('leaves Tab held with Ctrl or Cmd to the browser', () => {
    press(document.body, 'Tab', { ctrlKey: true });
    press(document.body, 'Tab', { metaKey: true });
    expect(keyboardNavigation()).toBe('off');
  });

  it('counts the arrows, Home, End and the page keys on a control', () => {
    const controls = [
      '<button type="button">Play</button>',
      '<a href="#settings">Settings</a>',
      '<input type="range" min="0" max="100" value="40">',
      '<input type="radio" name="choice">',
      '<select><option>One</option><option>Two</option></select>',
      '<div role="tab" tabindex="0">Playlist</div>',
      '<div role="option" tabindex="-1">English</div>',
      '<canvas role="button" tabindex="0"></canvas>',
      '<div role="separator" tabindex="0" aria-valuenow="50"></div>',
      '<div role="listbox" tabindex="0"></div>',
    ];
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp'];
    for (const html of controls) {
      const control = mount(html);
      for (const key of [...keys, 'PageDown']) {
        document.dispatchEvent(pointer('pointerdown', 'mouse'));
        press(control, key);
        expect(keyboardNavigation(), `${key} on ${html}`).toBe('on');
      }
      control.remove();
    }
  });

  it('leaves the arrows on the page, a panel or a field to scrolling and typing', () => {
    const notControls = [
      '<div id="panel" class="tab-content" role="tabpanel" tabindex="-1"></div>',
      '<div class="chat-drawer" role="region" tabindex="-1"></div>',
      '<div role="log" tabindex="-1"></div>',
      '<div role="dialog" tabindex="-1"></div>',
      // A reading dialog's message and a copyable chat bubble scroll or copy.
      '<div class="dialog-message" tabindex="0"></div>',
      '<div class="chat-bubble" role="group" tabindex="0"></div>',
      '<input type="text">',
      '<input type="number">',
      '<textarea></textarea>',
      '<div contenteditable="true" role="combobox" tabindex="0"></div>',
    ];
    const targets = [document.body, ...notControls.map(mount)];
    for (const target of targets) {
      for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
        press(target, key);
        press(target, 'PageUp');
        press(target, 'PageDown');
      }
      expect(keyboardNavigation(), target.outerHTML).toBe('off');
    }
    // Alt+Left is the browser's Back; Ctrl and Cmd arrows jump words or ends.
    const button = mount('<button type="button">Next</button>');
    press(button, 'ArrowLeft', { altKey: true });
    press(button, 'ArrowDown', { ctrlKey: true });
    press(button, 'End', { metaKey: true });
    expect(keyboardNavigation()).toBe('off');
  });

  it('never counts a key that presses, plays, closes or types', () => {
    const targets = [
      document.body,
      mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>'),
      mount('<button type="button">Play</button>'),
      mount('<input type="text">'),
    ];
    const keys = [' ', 'Enter', 'Escape', 'a', 'Shift', 'Control', 'Backspace', 'Delete', 'F6'];
    for (const target of targets) {
      for (const key of keys) press(target, key);
    }
    expect(keyboardNavigation()).toBe('off');
  });

  it('keeps a keyboard user on keyboard navigation through Space, Enter, Escape and typing', () => {
    press(document.body, 'Tab');
    const targets = [
      document.body,
      mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>'),
      mount('<button type="button">Play</button>'),
      mount('<input type="text">'),
    ];
    for (const target of targets) {
      for (const key of [' ', 'Enter', 'Escape', 'x', 'ArrowDown', 'PageDown']) {
        press(target, key);
      }
    }
    expect(keyboardNavigation()).toBe('on');
  });

  it('lets only hover-pointer.ts write the keyboard navigation flag', () => {
    const writers: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file === 'src/ui/hover-pointer.ts') continue;
      const source = readFileSync(resolve(file), 'utf8');
      if (/data-keyboard-navigation/u.test(source)) writers.push(file);
    }
    expect(writers).toEqual([]);
  });

  it('leaves no component its own pointer-focus mark beside the one owner', () => {
    // Sliders, the dialog's choice page and the language list each kept a
    // class that hid their ring after a pointer press; the owner now decides.
    const marks = /is-pointer-focused|dialog-choice-pointer-focus|language-option-initial-/u;
    const sites = [
      ...sourceFiles('src').filter((file) => marks.test(readFileSync(resolve(file), 'utf8'))),
      ...STYLESHEETS.filter((file) => marks.test(readFileSync(resolve(file), 'utf8'))),
    ];
    expect(sites).toEqual([]);
  });
});

describe('one keyboard gate for focus rings in the app stylesheets', () => {
  /** A rule that only takes a ring away draws nothing for the gate to hold back. */
  const onlyHides = (site: SelectorSite): boolean => {
    const list = declarations(site.rule);
    return list.length > 0 && list.every((entry) => /^outline(?:-style)?: none$/u.test(entry));
  };

  it('puts every focus ring rule under the keyboard gate', () => {
    const outside = selectorSites()
      .filter((site) => site.selector.includes(':focus-visible'))
      .filter((site) => afterGate(site.selector, RING) === null && !onlyHides(site))
      // A field's focus mark shows on every focus, as its blue underline does.
      .filter((site) => compact(site.selector) !== compact(`${FORCED_FIELDS}:focus-visible`))
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(outside).toEqual([]);
  });

  it('turns the browser ring off everywhere outside keyboard navigation', () => {
    expect(compactRulesFor(`${NO_RING} :focus-visible`)).toEqual([
      { conditions: [], declarations: ['outline: none'] },
    ]);
    expect(compactRulesFor(`${RING} :focus-visible`)).toEqual([
      {
        conditions: [],
        declarations: ['outline: 2px solid var(--primary)', 'outline-offset: 2px'],
      },
    ]);
    // Outside keyboard navigation nothing is drawn, only taken away.
    const drawing = selectorSites()
      .filter((site) => afterGate(site.selector, NO_RING) !== null && !onlyHides(site))
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(drawing).toEqual([]);
  });

  it('uses the keyboard flag only as the leading, zero-specificity gate', () => {
    const misplaced = selectorSites()
      .filter((site) => site.selector.includes('data-keyboard-navigation'))
      .filter((site) => {
        const rest = afterGate(site.selector, RING) ?? afterGate(site.selector, NO_RING);
        return rest === null || rest.includes('data-keyboard-navigation');
      })
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(misplaced).toEqual([]);
  });

  it('draws a tab panel ring on the panel edge, over its divider lines, on every panel', () => {
    const panelRing = compactRulesFor(`${RING} .tab-content:focus-visible`);
    expect(panelRing).toEqual([{ conditions: [], declarations: ['outline-offset: -2px'] }]);
    // The global ring is 2px wide: offset -2px puts it exactly inside the
    // panel's border box, over the 1px column dividers its borders draw.
    const ring = compactRulesFor(`${RING} :focus-visible`)[0]!.declarations;
    expect(ring).toContain('outline: 2px solid var(--primary)');
    const dividers = compactRulesFor('#tab-play')
      .concat(compactRulesFor('#tab-playlist'))
      .flatMap((found) => found.declarations)
      .filter((entry) => /^border-(?:inline-end|bottom):/u.test(entry));
    expect(dividers.length).toBeGreaterThan(0);
    for (const divider of dividers) expect(divider).toMatch(/: 1px solid var\(--divider\)$/u);
    // Every panel is a .tab-content, and none has a focus look of its own.
    const html = readFileSync(resolve('index.html'), 'utf8');
    for (const id of TAB_PANELS) {
      expect(html, id).toMatch(
        new RegExp(`id="${id}"\\s+class="tab-content[^"]*"\\s+role="tabpanel"`, 'u'),
      );
    }
    const ownLooks = selectorSites()
      .filter((site) => /:focus/u.test(site.selector))
      .filter((site) => TAB_PANELS.some((id) => site.selector.includes(`#${id}`)))
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(ownLooks).toEqual([]);
  });

  it('keeps a field focus mark on every focus in forced colours and rings controls by keyboard only', () => {
    expect(compactRulesFor(`${FORCED_FIELDS}:focus-visible`)).toEqual([
      {
        conditions: [FORCED],
        declarations: ['outline: 3px solid Highlight !important', 'outline-offset: 2px !important'],
      },
    ]);
    expect(compactRulesFor(`${RING} ${FORCED_CONTROLS}:focus-visible`)).toEqual([
      {
        conditions: [FORCED],
        declarations: ['outline: 3px solid Highlight !important', 'outline-offset: 2px !important'],
      },
    ]);
  });
});
