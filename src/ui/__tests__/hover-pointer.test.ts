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
/**
 * Chromium 86 and 87 (for example 2022 LG webOS TVs, docs/known-accepted.md
 * #20) know :focus-visible but not :where(), so they drop every gated rule
 * whole. They read the ungated rings under this condition instead.
 */
const NO_WHERE = '@supports not selector(:where(*))';

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

  it('tells hover input from touch with the one test that turns hover on', async () => {
    installAnyHover(false);
    const { initHoverPointer, isHoverInput } = await freshHoverPointer();
    initHoverPointer();
    const input = (pointerType: string): PointerEvent =>
      pointer('pointermove', pointerType) as PointerEvent;

    expect(isHoverInput(input('mouse'))).toBe(true);
    expect(isHoverInput(input('pen'))).toBe(true);
    expect(isHoverInput(input('touch'))).toBe(false);
    // An event that names no pointer type follows the gate and never turns it on.
    expect(isHoverInput(input(''))).toBe(false);
    document.dispatchEvent(input(''));
    expect(flagged()).toBe(false);
    document.dispatchEvent(input('pen'));
    expect(flagged()).toBe(true);
    expect(isHoverInput(input(''))).toBe(true);
    expect(isHoverInput(input('touch'))).toBe(false);
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

  it('leaves the custom scrollbar no hover test of its own', () => {
    // It asks the owner whether an event is hover input and whether its bar
    // is hovered, so its reveal and hold cannot drift from the gate.
    const source = readFileSync(resolve('src/ui/custom-scrollbar.ts'), 'utf8');
    expect(source).not.toMatch(/\bpointerType\b/u);
    expect(source).toMatch(/\bisHoverInput\(/u);
    expect(source).toMatch(/\bisHovered\(/u);
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

function releaseKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
}

/**
 * Lets the current task end, as a browser's does after a key's events and
 * their default actions, and the tasks queued in it run: a timer set or a
 * message posted earlier, as at a keydown, comes before these. Node hands
 * port messages over in the order they were posted (Windows) or the ports
 * were opened (elsewhere), and the keyboard owner opens its port at install.
 */
async function endTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const channel = new MessageChannel();
  await new Promise((resolve) => {
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  });
  channel.port1.close();
}

/** Lets the microtasks queued so far run, as a browser does after each listener. */
async function microtasks(): Promise<void> {
  await Promise.resolve();
}

/**
 * A MessageChannel that hands its message over as WebKit does (review finding
 * H6-R1): a task later than Chromium, so a 0 ms timer set after the post runs
 * first. WebKit's port queues a task that queues the message's own; here each
 * of the two is a 0 ms timer.
 */
class LateMessageChannel {
  readonly port1: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null };
  readonly port2 = {
    postMessage: (data: unknown): void => {
      setTimeout(() => {
        setTimeout(() => this.port1.onmessage?.(new MessageEvent('message', { data })), 0);
      }, 0);
    },
  };
}

/** The arrows, Home, End and the page keys. */
const NAVIGATION_KEYS = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];

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

/** The at-rule a rule sits in, written as `@name params`, or null for none. */
function atRuleOf(node: Node | undefined): string | null {
  if (node?.type !== 'atrule') return null;
  const { name, params } = node as AtRule;
  return `@${name} ${compact(params)}`;
}

/** Whether a rule is part of the ring that engines without :where() read. */
function readWithoutWhere(rule: Rule): boolean {
  for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
    if (atRuleOf(parent) === NO_WHERE) return true;
  }
  return false;
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

  it('counts the arrows, Home, End and the page keys on a widget they move through or move', () => {
    const widgets = [
      '<input type="range" min="0" max="100" value="40">',
      '<input type="radio" name="choice">',
      '<select><option>One</option><option>Two</option></select>',
      '<div role="tab" tabindex="0">Playlist</div>',
      '<button type="button" role="tab">Chat</button>',
      '<div role="option" tabindex="-1">English</div>',
      '<div role="separator" tabindex="0" aria-valuenow="50"></div>',
      '<div role="listbox" tabindex="0"></div>',
      '<div role="slider" tabindex="0" aria-valuenow="5"></div>',
    ];
    for (const html of widgets) {
      const widget = mount(html);
      for (const key of NAVIGATION_KEYS) {
        document.dispatchEvent(pointer('pointerdown', 'mouse'));
        press(widget, key);
        releaseKey(widget, key);
        expect(keyboardNavigation(), `${key} on ${html}`).toBe('on');
      }
      widget.remove();
    }
  });

  it('leaves the arrows, Home, End and the page keys on a plain button, link or switch to scrolling', () => {
    // A mouse user who clicks a track and scrolls the playlist with the
    // arrows or Page Down (src/ui/playlist-follow.ts reads those keys as
    // scrolling) gets no ring on the track, nor on the next window.
    const plain = [
      '<button type="button" class="track-name">Track</button>',
      '<a href="#settings">Settings</a>',
      '<canvas role="button" tabindex="0"></canvas>',
      '<div role="button" tabindex="0">Sync</div>',
      '<div role="link" tabindex="0">Help</div>',
      '<button type="button" role="switch" aria-checked="false">Password</button>',
      '<div role="checkbox" tabindex="0" aria-checked="false"></div>',
      '<input type="checkbox">',
      '<input type="button" value="Go">',
      '<details><summary>More</summary></details>',
    ];
    for (const html of plain) {
      const control = mount(html);
      const target = control.querySelector('summary') ?? control;
      for (const key of NAVIGATION_KEYS) {
        press(target, key);
        releaseKey(target, key);
      }
      expect(keyboardNavigation(), html).toBe('off');
      control.remove();
    }
  });

  it('counts an arrow, Home, End or page key that moves focus, wherever it was pressed', () => {
    // A TV remote's arrows move focus by spatial navigation from the page, a
    // panel or a plain button alike, and an app's own arrow handler may move
    // focus from any of them.
    const landing = mount('<button type="button">Next</button>');
    const targets: [string, HTMLElement][] = [
      ['the page', document.body],
      ['a panel', mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>')],
      ['a plain button', mount('<button type="button">Play</button>')],
      ['a text field', mount('<input type="text">')],
    ];
    for (const [label, target] of targets) {
      for (const key of NAVIGATION_KEYS) {
        document.dispatchEvent(pointer('pointerdown', 'mouse'));
        landing.blur();
        press(target, key);
        // The key's default action or a handler moves focus in its own task.
        landing.focus();
        releaseKey(target, key);
        expect(keyboardNavigation(), `${key} on ${label}`).toBe('on');
      }
    }
    // A plain button group whose own arrow handler moves focus.
    const [first, second] = [mount('<button>A</button>'), mount('<button>B</button>')];
    first.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') second.focus();
    });
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    first.focus();
    press(first, 'ArrowRight');
    releaseKey(first, 'ArrowRight');
    expect(keyboardNavigation()).toBe('on');
  });

  it('leaves a focus move alone once the key is up, after a pointer press, another key or a scroll, or when the window loses focus', () => {
    // A window that opens by itself focuses its control: that is no
    // navigation, even just after an arrow that only scrolled.
    const opened = mount('<button type="button">Stay</button>');
    const panel = mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>');
    const between: [string, () => void][] = [
      ['the key up', () => releaseKey(document.body, 'ArrowDown')],
      ['a pointer press', () => document.dispatchEvent(pointer('pointerdown', 'mouse'))],
      ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
      ['another key', () => press(document.body, 'a')],
      // Any scroll ends the key's turn, the key's own or another, the page's
      // or an element's (whose scroll event does not bubble): a focus move
      // that a scroll brings about, such as a button that hides under focus
      // (the chat's scroll-down button), is the page's, not the key's.
      ['the page scrolling', () => document.dispatchEvent(new Event('scroll', { bubbles: true }))],
      ['a panel scrolling', () => panel.dispatchEvent(new Event('scroll'))],
    ];
    for (const [label, step] of between) {
      opened.blur();
      press(document.body, 'ArrowDown');
      step();
      opened.focus();
      expect(keyboardNavigation(), label).toBe('off');
    }
    // Keys that press, play, close or type, and shortcuts, never count a focus
    // move, even one made while they are down.
    const keys: [string, KeyboardEventInit][] = [
      [' ', {}],
      ['Enter', {}],
      ['Escape', {}],
      ['a', {}],
      ['ArrowLeft', { altKey: true }],
      ['ArrowDown', { ctrlKey: true }],
      ['End', { metaKey: true }],
    ];
    for (const [key, init] of keys) {
      opened.blur();
      press(document.body, key, init);
      opened.focus();
      releaseKey(document.body, key);
      expect(keyboardNavigation(), `${key} ${JSON.stringify(init)}`).toBe('off');
    }
  });

  it("leaves a focus move alone once the key's task has ended, though the key is still down", async () => {
    // Review finding H-6. A window that opens by itself (an audio recovery
    // prompt, the update dialog) opens in a later task than any key's and
    // focuses its control there (src/ui/dom.ts) or from a timer
    // (src/ui/dialog.ts). That is no navigation, even while a mouse user's
    // caret key or command completion Tab in the chat field is down (about a
    // tenth of a second), or while a page key or an arrow is held on a panel
    // or a clicked track with nothing left to scroll (the whole hold, with no
    // scroll to end it).
    const opened = mount('<button type="button">Later</button>');
    const completing = mount('<input type="text">');
    completing.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') event.preventDefault();
    });
    const holds: [string, HTMLElement, string, number][] = [
      ['a caret key in a text field', mount('<input type="text">'), 'ArrowLeft', 0],
      ['a Tab that a text field keeps for a completion', completing, 'Tab', 0],
      [
        'a page key held on a panel with nothing to scroll',
        mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>'),
        'PageDown',
        2,
      ],
      [
        'an arrow held on a clicked track with nothing to scroll',
        mount('<button type="button" class="track-name">Track</button>'),
        'ArrowDown',
        2,
      ],
    ];
    for (const [label, holder, key, repeats] of holds) {
      document.dispatchEvent(pointer('pointerdown', 'mouse'));
      holder.focus();
      press(holder, key, { cancelable: true });
      await endTask();
      // A held key repeats, each repeat in a task of its own.
      for (let count = 0; count < repeats; count += 1) {
        press(holder, key, { cancelable: true, repeat: true });
        await endTask();
      }
      // The window opens, and focuses its control, before the key is up.
      opened.focus();
      expect(keyboardNavigation(), label).toBe('off');
      releaseKey(holder, key);
    }
  });

  it("ends the key's turn before a timer set after its keydown, where the port's message comes later", async () => {
    // Review finding H6-R1. WebKit hands a port's message over a task later
    // than Chromium, after a 0 ms timer set behind the post (Playwright's
    // WebKit 26.6: the timer first in every run). A window that opens by
    // itself from such a timer while a caret key, a completion Tab or a page
    // key is still down focused its control inside the key's turn there, and
    // its control rang.
    vi.stubGlobal('MessageChannel', LateMessageChannel);
    try {
      (await freshHoverPointer()).initHoverPointer();
    } finally {
      vi.unstubAllGlobals();
    }
    /** Lets the late port's two hops run, with any task queued before them. */
    const settle = async (): Promise<void> => {
      await endTask();
      await endTask();
    };
    const opened = mount('<button type="button">Later</button>');
    const completing = mount('<input type="text">');
    completing.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') event.preventDefault();
    });
    const holds: [string, HTMLElement, string, number][] = [
      ['a caret key in a text field', mount('<input type="text">'), 'ArrowLeft', 0],
      ['a Tab that a text field keeps for a completion', completing, 'Tab', 0],
      [
        'a page key held on a panel with nothing to scroll',
        mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>'),
        'PageDown',
        2,
      ],
      [
        'an arrow held on a clicked track with nothing to scroll',
        mount('<button type="button" class="track-name">Track</button>'),
        'ArrowDown',
        2,
      ],
    ];
    for (const [label, holder, key, repeats] of holds) {
      document.dispatchEvent(pointer('pointerdown', 'mouse'));
      holder.focus();
      press(holder, key, { cancelable: true });
      for (let count = 0; count < repeats; count += 1) {
        await settle();
        press(holder, key, { cancelable: true, repeat: true });
      }
      // The window opens from a timer set after the keydown, here at once,
      // and focuses its control before the key is up.
      await new Promise<void>((resolve) => {
        window.setTimeout(() => {
          opened.focus();
          resolve();
        }, 0);
      });
      expect(keyboardNavigation(), label).toBe('off');
      releaseKey(holder, key);
      await settle();
    }
  });

  it("still counts a focus move in the key's own task, after its listeners' microtasks, at every repeat", async () => {
    // Spatial navigation (a TV remote's D-pad) moves focus in the keydown's
    // default action: after every listener, and the microtasks a browser
    // runs after each of them, in the keydown's task.
    const landing = mount('<button type="button">Next</button>');
    const targets: [string, HTMLElement][] = [
      ['the page', document.body],
      ['a panel', mount('<div class="tab-content" role="tabpanel" tabindex="-1"></div>')],
      ['a plain button', mount('<button type="button">Play</button>')],
      ['a text field', mount('<input type="text">')],
    ];
    for (const [label, target] of targets) {
      document.dispatchEvent(pointer('pointerdown', 'mouse'));
      landing.blur();
      press(target, 'ArrowDown');
      await microtasks();
      landing.focus();
      expect(keyboardNavigation(), label).toBe('on');
      await endTask();
      releaseKey(target, 'ArrowDown');
    }
    // A held D-pad moves focus at a repeat, after earlier tasks have ended.
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    landing.blur();
    press(document.body, 'ArrowDown');
    await endTask();
    press(document.body, 'ArrowDown', { repeat: true });
    await microtasks();
    landing.focus();
    expect(keyboardNavigation(), 'a repeat').toBe('on');
    await endTask();
    releaseKey(document.body, 'ArrowDown');

    // The playlist's keyboard reorder (src/ui/playlist-reorder.ts
    // moveKeyboard): the handle's own keydown listener moves its row, which
    // takes focus off the handle, and focuses the handle again.
    const list = mount(
      '<ul><li><button type="button">1</button></li><li><button type="button">2</button></li></ul>',
    );
    const [firstRow, secondRow] = [...list.children] as [HTMLElement, HTMLElement];
    const handle = firstRow.querySelector('button')!;
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      list.insertBefore(firstRow, secondRow.nextSibling);
      handle.focus({ preventScroll: true });
    });
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    handle.focus();
    press(handle, 'ArrowDown', { cancelable: true });
    expect(list.lastElementChild, 'the row moved').toBe(firstRow);
    expect(keyboardNavigation(), 'the playlist reorder').toBe('on');
    await endTask();
    releaseKey(handle, 'ArrowDown');
  });

  it('leaves a Tab that a text field takes for itself, keeping focus, to the field', () => {
    // The chat's command completion takes Tab (preventDefault) and keeps
    // focus in the field: a mouse user completing a command is not
    // navigating, and the next window opens without a ring.
    for (const html of ['<input type="text">', '<textarea></textarea>']) {
      const field = mount(html);
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') event.preventDefault();
      });
      for (const shiftKey of [false, true]) {
        document.dispatchEvent(pointer('pointerdown', 'mouse'));
        field.focus();
        press(field, 'Tab', { cancelable: true, shiftKey });
        releaseKey(field, 'Tab');
        expect(keyboardNavigation(), `${html} shift=${shiftKey}`).toBe('off');
      }
      // A keyboard user keeps their rings through it.
      press(document.body, 'Tab');
      field.focus();
      press(field, 'Tab', { cancelable: true });
      releaseKey(field, 'Tab');
      expect(keyboardNavigation(), html).toBe('on');
      field.remove();
    }
  });

  it('counts a Tab that leaves a text field, or that a focus trap takes and moves', () => {
    const field = mount('<input type="text">');
    const other = mount('<button type="button">OK</button>');

    // The browser moves focus out of the field.
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    field.focus();
    press(field, 'Tab', { cancelable: true });
    releaseKey(field, 'Tab');
    expect(keyboardNavigation(), 'Tab out of a field').toBe('on');

    // A dialog's focus trap on the window (src/ui/dialog.ts) takes the Tab
    // and moves focus itself.
    const trap = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      (document.activeElement === other ? field : other).focus();
    };
    window.addEventListener('keydown', trap);
    try {
      document.dispatchEvent(pointer('pointerdown', 'mouse'));
      field.focus();
      press(field, 'Tab', { cancelable: true });
      releaseKey(field, 'Tab');
      expect(keyboardNavigation(), 'a trap moving focus from a field').toBe('on');

      // A one-button dialog's trap wraps focus onto the same button.
      document.dispatchEvent(pointer('pointerdown', 'mouse'));
      other.focus();
      window.removeEventListener('keydown', trap);
      const wrap = (event: KeyboardEvent): void => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        other.focus();
      };
      window.addEventListener('keydown', wrap);
      press(other, 'Tab', { cancelable: true });
      releaseKey(other, 'Tab');
      window.removeEventListener('keydown', wrap);
      expect(keyboardNavigation(), 'a one-button wrap').toBe('on');
    } finally {
      window.removeEventListener('keydown', trap);
    }

    // A field handler that stops the key before the window, while the
    // browser still moves focus out of the field.
    const stopping = mount('<input type="text">');
    stopping.addEventListener('keydown', (event) => event.stopPropagation());
    document.dispatchEvent(pointer('pointerdown', 'mouse'));
    stopping.focus();
    press(stopping, 'Tab', { cancelable: true });
    other.focus();
    releaseKey(stopping, 'Tab');
    expect(keyboardNavigation(), 'Tab past a stopping handler').toBe('on');
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
      // Engines that drop the gate read their own copy (the next test).
      .filter((site) => !readWithoutWhere(site.rule))
      .map((site) => `${site.file}:${site.line} ${site.selector}`);
    expect(outside).toEqual([]);
  });

  it('gives an engine without :where() the app rings the gate takes from it, after each gated rule', () => {
    // Chromium 86 and 87 drop every gated rule, so no keyboard mark reaches
    // them. The play panel's Sync and Play media buttons, the carousel arrows
    // and the chat's YouTube buttons turn the browser's own ring off, and the
    // PIN dialog's radios are transparent: without a ring of the app's own
    // they would show no focus at all there. Each copy follows its gated rule in
    // the same layer, so those engines keep the cascade the app had before
    // the gate: the global ring after those resets, the browser's
    // :focus-visible deciding where it shows.
    const copies = [
      [':focus-visible', `${RING} :focus-visible`],
      [
        '.dialog-choice-radio:focus-visible + .dialog-choice-surface',
        `${RING} .dialog-choice-radio:focus-visible + .dialog-choice-surface`,
      ],
    ] as const;
    for (const [ungated, gated] of copies) {
      const original = selectorSites().filter(
        (site) =>
          compact(site.selector) === compact(gated) &&
          atRuleOf(site.rule.parent)?.startsWith('@layer ') === true,
      );
      expect(original, gated).toHaveLength(1);
      let next = original[0]!.rule.next();
      while (next?.type === 'comment') next = next.next();
      expect(atRuleOf(next), gated).toBe(NO_WHERE);
      const inside: { selector: string; declarations: string[] }[] = [];
      (next as AtRule).each((node) => {
        if (node.type === 'rule') {
          inside.push({ selector: compact(node.selector), declarations: declarations(node) });
        }
      });
      expect(inside, gated).toEqual([
        { selector: compact(ungated), declarations: declarations(original[0]!.rule) },
      ]);
    }
    const fallback = selectorSites()
      .filter((site) => readWithoutWhere(site.rule))
      .map((site) => compact(site.selector));
    expect(fallback.sort()).toEqual(copies.map(([ungated]) => compact(ungated)).sort());
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

  it('draws the chat log and playlist rings on their own edges, as on the panels', () => {
    // Focus waits on them after a keyboard action: the chat log when its
    // scroll-down button hides under focus, the list when the last rows
    // picked for removal go. A ring outside them is clipped by the chat
    // drawer and by the playlist's scroller.
    for (const container of ['.chat-drawer-messages', '.playlist-ul']) {
      expect(compactRulesFor(`${RING} ${container}:focus-visible`), container).toEqual([
        { conditions: [], declarations: ['outline-offset: -2px'] },
      ]);
    }
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
