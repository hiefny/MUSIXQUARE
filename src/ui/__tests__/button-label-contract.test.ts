/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Declaration, type Node, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

// Owner decision (2026-10-27): every action button reads one label style, so
// labels differ only by color. Each component rule reads the button label
// tokens itself, the same way component rules read --radius-pill; a global
// override would lose to cascade layers and ID selectors.
const LABEL_TOKENS: Readonly<Record<string, string>> = {
  'font-size': 'var(--button-label-size)',
  'font-weight': 'var(--button-label-weight)',
  'line-height': 'var(--button-label-line-height)',
  'letter-spacing': 'var(--button-label-letter-spacing)',
};
const LABEL_VALUES: Readonly<Record<string, string>> = {
  '--button-label-size': '15px',
  '--button-label-weight': '700',
  '--button-label-line-height': '1.25',
  '--button-label-letter-spacing': 'normal',
};
const FONT_PROPERTIES = ['font', 'font-family', ...Object.keys(LABEL_TOKENS)];

// A verb label on a pill, plus the selection bar's text action. Their rules
// may declare label typography only through the tokens above, and may not
// paint a hard-coded red (destructive labels read --danger-foreground).
const ACTION_BUTTON_CLASSES = [
  'dialog-primary',
  'dialog-secondary',
  'btn-ob-primary',
  'btn-ob-secondary',
  'accent-action-btn',
  'leave-session-btn',
  'btn-copy-invite-link',
  'file-select-btn',
  'playlist-selection-toggle',
  'sync-reset-btn',
  'sync-done-btn',
] as const;

// Buttons that keep their own label size and share the rest of the label style.
const OWN_SIZE_CLASSES: Readonly<Record<string, string>> = {
  'ch-opt':
    'Choice cards sit two to four per row down to 360px. They keep 14px until ' +
    '15px is shown to fit every locale, and share the label weight, line height ' +
    'and letter spacing.',
};

// Every other button class in index.html and the TypeScript templates, with
// the reason it is not an action button. A new button class must join one list.
const NOT_ACTION_BUTTONS: Readonly<Record<string, string>> = {
  'btn-ob-text-link': 'Setup text link: an underlined secondary link, not a pill.',
  'btn-ob-icon': 'Icon-only setup button.',
  'nav-item': 'Bottom navigation: a small label under an icon.',
  'subtab-pill': 'Settings section tab, not an action.',
  'role-badge': 'Header status badge: a small fixed-width pill.',
  'd-op-btn': 'Device row permission chip: a small fixed-width pill.',
  'sync-nudge-btn': 'Manual sync nudge chip with a numeric label.',
  'administrator-action-button': 'Icon-only device row action.',
  'administrator-permission-row': 'Option row in a list; its label is content.',
  'language-option': 'Option row in a list; its label is content.',
  'yt-search-result': 'Search result row; its label is content.',
  'track-name': 'Playlist row title; its label is content.',
  'track-leading': 'Playlist row number and reorder grip.',
  'expand-toggle': 'Icon-only disclosure.',
  'device-expand-toggle': 'Icon-only disclosure.',
  'btn-playlist-select': 'Icon-only selection mark.',
  'btn-playlist-remove': 'Icon-only upload cancel.',
  'playlist-selection-action': 'Icon-only selection bar circle.',
  'playlist-switch-button': 'Icon-only playlist switch.',
  'btn-kick-device': 'Icon-only device row action.',
  'btn-kick-physical-device': 'Icon-only device row action.',
  'chat-youtube-btn': 'YouTube card inside a chat bubble.',
  'chat-preview-btn': 'Chat preview bar showing the latest message.',
  'chat-drawer-close': 'Icon-only chat control.',
  'chat-pinned-notice-dismiss': 'Icon-only chat control.',
  'chat-pinned-notice-open': 'Icon-only chat control.',
  'chat-scroll-down-btn': 'Icon-only scroll control.',
  'chat-send-btn': 'Icon-only chat control.',
  'clearable-editor-button': 'Icon-only clear control inside an input.',
  'onboarding-diagnostics-action': 'Developer diagnostics overlay in a monospace face.',
  'account-dialog-title-edit': 'The account title itself, editable in place.',
  'setup-language-button': 'The setup greeting heading, which opens the language list.',
  'settings-invite-wrapper': 'Invite code display.',
  'settings-sync-indicator': 'Sync status indicator.',
  'demo-step-next': 'Demo step navigation pill, part of the step indicator.',
  'demo-play-button': 'Icon-only demo control.',
  'demo-settings-button': 'Icon-only demo control.',
  'ctrl-btn': 'Icon-only transport control.',
  'play-fab': 'Icon-only play button.',
  'volume-icon-button': 'Icon-only volume control.',
  'tab-action-btn': 'Icon-only playlist header action.',
  'fullscreen-btn': 'Icon-only header control.',
  'header-help-btn': 'Icon-only header control.',
  'app-logo': 'Header logo.',
  'room-password-refresh': 'Icon-only password control.',
  'room-password-toggle': 'Icon-only password control.',
  'setup-qr-close': 'Icon-only camera control.',
  'setup-qr-scan-button': 'Icon-only camera control.',
  'yt-search-submit-btn': 'Icon-only search control.',
  'ob-dot': 'Carousel page dot.',
  'ob-nav-arrow': 'Icon-only carousel arrow.',
  'account-google-button': 'Google sign-in button, drawn to the Google brand specification.',
};

// Unclassed buttons in index.html, named by the container that styles them.
const CONTAINER_BUTTONS: Readonly<Record<string, string>> = {
  '.demo-step-nav': 'Demo step indicator steps.',
  '.demo-role-segmented': 'Demo role segmented control.',
  '.bootstrap-failure':
    'Startup failure fallback outside the app shell; it inherits the page font.',
};

// Buttons that TypeScript creates without a class and styles inline.
const INLINE_STYLED_BUTTONS: Readonly<Record<string, string>> = {
  'src/ui/screensaver.ts:fallbackBack': 'Back control over a screensaver that failed to load.',
  'src/youtube/iframe.ts:overlayButton': 'Full-frame tap target over the YouTube player.',
};

// Elements inside an action button that are not its label.
const NESTED_EXCEPTIONS: Readonly<Record<string, string>> = {
  'feature-badge': 'BETA status badge beside the system audio label.',
  'btn-icon-bg': 'Media source icon tile; the YouTube tile keeps the brand red.',
};

// Viewport compactions that may resize an action label, with the reason.
const DEMO_FINISH_PAIR =
  'The demo finish pair sits two per row in 54px pills on phones up to 420px; ' +
  'the smaller label keeps both localized labels beside their icons.';
const COMPACT_OVERRIDES: ReadonlyArray<{
  condition: string;
  selector: string;
  declaration: string;
  reason: string;
}> = [
  {
    condition: '@media (max-width: 420px)',
    selector: '.demo-large-actions .accent-action-btn',
    declaration: 'font-size: 13px',
    reason: DEMO_FINISH_PAIR,
  },
  {
    condition: '@media (max-width: 420px)',
    selector: '.demo-large-actions .leave-session-btn',
    declaration: 'font-size: 13px',
    reason: DEMO_FINISH_PAIR,
  },
  {
    condition:
      '@media (min-width: 720px) and (max-width: 1279px), (min-width: 1280px) and (max-height: 719px)',
    selector: '#media-source-overlay #btn-close-media-popup',
    declaration: 'font-size: 0',
    reason:
      'On two-column screens the media source Close becomes a 40px icon circle ' +
      'in the header; its label is hidden, not restyled.',
  },
];

// App-wide resets that also reach action labels. Each one must agree with the
// label tokens, so it can never pull a label away from them.
const GLOBAL_RESETS: Readonly<Record<string, { declaration: string; reason: string }>> = {
  button: {
    declaration: 'font-family: inherit',
    reason: 'Form controls take the page font instead of the platform control font.',
  },
  "html[dir='rtl'] :where(h1, h2, h3, h4, p, button, label, span, input, textarea)": {
    declaration: 'letter-spacing: normal',
    reason: 'Arabic and Hebrew text never takes tracking.',
  },
  "html[dir='rtl'] :where(input, textarea, select, button)": {
    declaration: 'font-family: inherit',
    reason: 'Right-to-left form controls keep the page script font.',
  },
};

const read = (path: string): string => readFileSync(resolve(path), 'utf8');
// css/app.css imports these four files; together they are the app stylesheet.
const SHEET_PATHS = [
  'css/style.css',
  'css/desktop.css',
  'css/rtl.css',
  'css/playback-actions.css',
] as const;
const sheets = SHEET_PATHS.map((path) => ({ path, root: parseCss(read(path)) }));
const appCss = sheets[0]!.root;
const playCss = sheets[3]!.root;

function appMarkup(): Document {
  return new DOMParser().parseFromString(read('index.html'), 'text/html');
}

/** The nearest conditional at-rule around a node; cascade layers apply everywhere. */
function conditionOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name !== 'layer') return `@${atRule.name} ${atRule.params}`;
  }
  return null;
}

function where(declaration: Declaration, path: string): string {
  return `${path}:${declaration.source?.start?.line ?? '?'}`;
}

/** Remove :not(...) arguments: a negated class does not style that class. */
function withoutNegations(selector: string): string {
  let result = '';
  for (let index = 0; index < selector.length; index += 1) {
    if (!selector.startsWith(':not(', index)) {
      result += selector[index];
      continue;
    }
    let depth = 0;
    for (index += 4; index < selector.length; index += 1) {
      if (selector[index] === '(') depth += 1;
      if (selector[index] === ')') depth -= 1;
      if (depth === 0) break;
    }
  }
  return result;
}

const hasClass = (selector: string, className: string): boolean =>
  new RegExp(`\\.${className}(?![\\w-])`, 'u').test(selector);

const actionAliases = (() => {
  const ids = [
    ...appMarkup().querySelectorAll(ACTION_BUTTON_CLASSES.map((name) => `.${name}`).join(', ')),
  ]
    .map((element) => element.id)
    .filter(Boolean);
  return ids.map((id) => `#${id}`);
})();

/** The action (or own-size) class a selector styles, ignoring negations. */
function styledButton(selector: string): { name: string; ownSize: boolean } | null {
  const positive = withoutNegations(selector);
  for (const name of ACTION_BUTTON_CLASSES) {
    if (hasClass(positive, name)) return { name, ownSize: false };
  }
  for (const alias of actionAliases) {
    if (new RegExp(`${alias}(?![\\w-])`, 'u').test(positive))
      return { name: alias, ownSize: false };
  }
  for (const name of Object.keys(OWN_SIZE_CLASSES)) {
    if (hasClass(positive, name)) return { name, ownSize: true };
  }
  return null;
}

/** A selector that styles a nested exception or something inside one. */
const isNestedException = (selector: string): boolean =>
  Object.keys(NESTED_EXCEPTIONS).some((name) => hasClass(withoutNegations(selector), name));

function isCompactOverride(declaration: Declaration, selector: string): boolean {
  return COMPACT_OVERRIDES.some(
    (allowed) =>
      allowed.condition === conditionOf(declaration) &&
      allowed.selector === selector.replace(/\s+/gu, ' ').trim() &&
      allowed.declaration === `${declaration.prop}: ${declaration.value}`,
  );
}

/** Label typography a declaration may set on an action button or its label. */
function labelViolation(declaration: Declaration, ownSize: boolean): boolean {
  if (declaration.prop === 'font' || declaration.prop === 'font-family') return true;
  if (ownSize && declaration.prop === 'font-size') return false;
  return declaration.value !== LABEL_TOKENS[declaration.prop];
}

function channels(value: string): number[][] {
  const colors: number[][] = [];
  for (const [hex] of value.matchAll(/#[0-9a-f]{3,8}\b/giu)) {
    const digits = hex.slice(1);
    const full =
      digits.length <= 4
        ? [...digits].map((digit) => digit + digit).join('')
        : digits.padEnd(6, '0');
    colors.push([0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)));
  }
  for (const match of value.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/giu)) {
    colors.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return colors;
}

const isRedLiteral = (value: string): boolean =>
  channels(value).some(
    ([red, green, blue]) => red! >= 128 && red! > 2 * green! && red! > 2 * blue!,
  );

function relativeLuminance([red, green, blue]: number[]): number {
  const linear = [red!, green!, blue!]
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, tint: string, surface: string): number {
  const [front] = channels(foreground);
  const [under] = channels(surface);
  const [over] = channels(tint);
  const alpha = Number(/,\s*([\d.]+)\s*\)$/u.exec(tint)?.[1] ?? '1');
  const backdrop = over!.map((channel, index) => channel * alpha + under![index]! * (1 - alpha));
  const [lighter, darker] = [relativeLuminance(front!), relativeLuminance(backdrop)].sort(
    (first, second) => second - first,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Values of `property` in rules that list `selector` itself under `condition`. */
function ruleValues(
  root: Root,
  selector: string,
  property: string,
  condition: string | null = null,
): string[] {
  const values: string[] = [];
  root.walkRules((rule) => {
    const selectors = rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim());
    if (!selectors.includes(selector) || conditionOf(rule) !== condition) return;
    rule.each((node) => {
      if (node.type !== 'decl' || node.prop !== property) return;
      values.push(node.important ? `${node.value} !important` : node.value);
    });
  });
  return values;
}

/** TypeScript sources that may create buttons. */
function templateSources(): Array<{ path: string; source: string }> {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(path.replace(/\\/gu, '/'));
      }
    }
  };
  walk('src');
  return files.map((path) => ({ path, source: read(path) }));
}

/** Static class names of a class attribute or className expression. */
function staticClasses(expression: string, source: string): string[] {
  const trimmed = expression.trim();
  const constant = /^[A-Z_][A-Z0-9_]*$/u.test(trimmed)
    ? new RegExp(`const ${trimmed}\\s*=\\s*'([^']*)'`, 'u').exec(source)?.[1]
    : undefined;
  if (constant !== undefined) return constant.split(/\s+/u).filter(Boolean);
  const withoutExpressions = trimmed.replace(/\$\{[^}]*\}/gu, ' ');
  const literals = [...withoutExpressions.matchAll(/(['"`])([^'"`]*)\1/gu)].map(
    (match) => match[2],
  );
  return (literals.length > 0 ? literals : [withoutExpressions])
    .join(' ')
    .split(/\s+/u)
    .filter((name) => /^[a-z][\w-]*$/u.test(name));
}

interface TemplateButton {
  where: string;
  classes: string[];
}

function templateButtons(): TemplateButton[] {
  const buttons: TemplateButton[] = [];
  for (const { path, source } of templateSources()) {
    const flattened = source.replace(/\$\{[^}]*\}/gu, ' ');
    for (const match of flattened.matchAll(/<button\b[^>]*?\bclass="([^"]*)"/gu)) {
      buttons.push({ where: path, classes: staticClasses(match[1]!, source) });
    }
    for (const match of source.matchAll(
      /(?:const|let)\s+(\w+)\s*=\s*[\w.]+\.createElement\(\s*['"]button['"]\s*\)/gu,
    )) {
      const name = match[1]!;
      const window = source.slice(match.index, match.index + 1500);
      const assignments = [
        ...window.matchAll(new RegExp(`\\b${name}\\.className\\s*=\\s*([^;]+);`, 'gu')),
        ...window.matchAll(new RegExp(`\\b${name}\\.classList\\.add\\(([^)]*)\\)`, 'gu')),
      ];
      if (assignments.length === 0) {
        buttons.push({ where: `${path}:${name}`, classes: [] });
        continue;
      }
      for (const assignment of assignments) {
        buttons.push({ where: `${path}:${name}`, classes: staticClasses(assignment[1]!, source) });
      }
    }
  }
  return buttons;
}

const registered = (name: string): boolean =>
  (ACTION_BUTTON_CLASSES as readonly string[]).includes(name) ||
  name in OWN_SIZE_CLASSES ||
  name in NOT_ACTION_BUTTONS;

/** index.html with the action buttons that TypeScript mounts at runtime. */
function markupWithRuntimeActions(): Document {
  const markup = appMarkup();
  const mount = (selector: string, html: string): void => {
    const container = markup.querySelector(selector);
    expect(container, selector).not.toBeNull();
    container!.insertAdjacentHTML('beforeend', html);
  };
  mount(
    '#qr-container',
    '<button type="button" class="btn-copy-invite-link"><svg viewBox="0 0 24 24"></svg>' +
      '<span class="material-elastic-spinner signaling-recovery-spinner" aria-hidden="true"></span>' +
      '<span data-i18n="connect.copy_invite_link">Copy invite link</span></button>',
  );
  mount(
    '.playlist-title-area',
    '<button type="button" class="playlist-selection-toggle">Select all</button>',
  );
  mount(
    '#setup-actions',
    '<button type="button" class="btn-ob-secondary">Back</button>' +
      '<button type="button" class="btn-ob-primary">Start</button>',
  );
  const vertical = markup.getElementById('setup-actions')!.cloneNode(true) as HTMLElement;
  vertical.removeAttribute('id');
  vertical.classList.add('vertical');
  markup.getElementById('setup-actions')!.after(vertical);
  return markup;
}

describe('action button label contract', () => {
  it('defines the button label tokens and the danger foreground once on the root', () => {
    for (const [token, value] of Object.entries(LABEL_VALUES)) {
      expect(ruleValues(appCss, ':root', token), token).toEqual([value]);
      for (const { path, root } of sheets) {
        const owners: string[] = [];
        root.walkDecls(token, (declaration) => owners.push(where(declaration, path)));
        expect(owners.length, `${token} owners in ${path}`).toBe(path === 'css/style.css' ? 1 : 0);
      }
    }
    expect(ruleValues(appCss, ':root', '--danger-foreground')).toEqual(['#ff3b30']);
  });

  it('lets action button rules set label typography only through the tokens', () => {
    const violations: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!FONT_PROPERTIES.includes(declaration.prop)) return;
        const rule = declaration.parent;
        if (rule?.type !== 'rule') return;
        for (const selector of (rule as unknown as { selectors: string[] }).selectors) {
          if (selector.includes('::') || isNestedException(selector)) continue;
          const button = styledButton(selector);
          if (!button || !labelViolation(declaration, button.ownSize)) continue;
          if (isCompactOverride(declaration, selector)) continue;
          violations.push(
            `${where(declaration, path)} ${selector.replace(/\s+/gu, ' ')} { ${declaration.prop}: ${declaration.value} }`,
          );
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("reads every label token from each action button's own rule", () => {
    for (const name of ACTION_BUTTON_CLASSES) {
      for (const [property, token] of Object.entries(LABEL_TOKENS)) {
        expect(ruleValues(appCss, `.${name}`, property), `.${name} ${property}`).toEqual([token]);
      }
    }
    // Choice cards keep their size and share the rest.
    expect(ruleValues(appCss, '.ch-opt', 'font-size')).toEqual(['14px']);
    for (const property of ['font-weight', 'line-height', 'letter-spacing']) {
      expect(ruleValues(appCss, '.ch-opt', property), `.ch-opt ${property}`).toEqual([
        LABEL_TOKENS[property],
      ]);
    }
  });

  it('resolves only the label tokens on every action button in the app markup', () => {
    // Selectors that never name the button (an ID, a container, a descendant
    // span) are caught here: every font declaration that any app rule applies
    // to an action button or its label text, in any layer or condition, in
    // both directions and both themes, must be a token read.
    const markup = markupWithRuntimeActions();
    const root = markup.documentElement;
    const actions = [
      ...markup.querySelectorAll(ACTION_BUTTON_CLASSES.map((name) => `.${name}`).join(', ')),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(30);
    const labelElements = actions.flatMap((action) => [
      action,
      ...[...action.querySelectorAll('*')].filter(
        (element) =>
          element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
          !element.closest(
            Object.keys(NESTED_EXCEPTIONS)
              .map((name) => `.${name}`)
              .join(', '),
          ),
      ),
    ]);
    const fontRules = sheets.flatMap(({ path, root: sheet }) => {
      const rules: Array<{ path: string; selectors: string[]; declarations: Declaration[] }> = [];
      sheet.walkRules((rule) => {
        const declarations = rule.nodes.filter(
          (node): node is Declaration =>
            node.type === 'decl' && FONT_PROPERTIES.includes(node.prop),
        );
        if (declarations.length > 0) rules.push({ path, selectors: rule.selectors, declarations });
      });
      return rules;
    });

    const violations = new Set<string>();
    const unsupported = new Set<string>();
    for (const direction of ['ltr', 'rtl']) {
      for (const theme of ['dark', 'light']) {
        root.setAttribute('dir', direction);
        root.setAttribute('data-theme', theme);
        for (const rule of fontRules) {
          for (const selector of rule.selectors) {
            if (selector.includes('::')) continue;
            for (const element of labelElements) {
              let matches = false;
              try {
                matches = element.matches(selector);
              } catch {
                unsupported.add(selector);
              }
              if (!matches) continue;
              for (const declaration of rule.declarations) {
                const value = `${declaration.prop}: ${declaration.value}`;
                if (GLOBAL_RESETS[selector.replace(/\s+/gu, ' ').trim()]?.declaration === value) {
                  continue;
                }
                if (!labelViolation(declaration, false)) continue;
                if (isCompactOverride(declaration, selector)) continue;
                violations.add(`${where(declaration, rule.path)} ${selector} { ${value} }`);
              }
            }
          }
        }
      }
    }
    expect([...unsupported].filter((selector) => styledButton(selector))).toEqual([]);
    expect([...violations]).toEqual([]);
  });

  it('classifies every button in the app markup and the TypeScript templates', () => {
    const unclassified: string[] = [];
    for (const button of appMarkup().querySelectorAll('button')) {
      if ([...button.classList].some(registered)) continue;
      if (Object.keys(CONTAINER_BUTTONS).some((container) => button.closest(container))) continue;
      unclassified.push(`index.html ${button.outerHTML.slice(0, 80)}`);
    }
    for (const button of templateButtons()) {
      if (button.classes.length === 0 && button.where in INLINE_STYLED_BUTTONS) continue;
      if (button.classes.some(registered)) continue;
      unclassified.push(`${button.where} class="${button.classes.join(' ')}"`);
    }
    expect(unclassified).toEqual([]);
  });

  it('keeps the classification lists current', () => {
    const markup = appMarkup();
    const templates = templateButtons();
    const used = new Set([
      ...[...markup.querySelectorAll('button, a')].flatMap((element) => [...element.classList]),
      ...templates.flatMap((button) => button.classes),
    ]);
    const stale = [
      ...ACTION_BUTTON_CLASSES,
      ...Object.keys(OWN_SIZE_CLASSES),
      ...Object.keys(NOT_ACTION_BUTTONS),
    ].filter((name) => !used.has(name));
    expect(stale).toEqual([]);
    for (const container of Object.keys(CONTAINER_BUTTONS)) {
      expect(markup.querySelector(`${container} button`), container).not.toBeNull();
    }
    for (const where of Object.keys(INLINE_STYLED_BUTTONS)) {
      const unclassed = templates.filter(
        (button) => button.where === where && button.classes.length === 0,
      );
      expect(unclassed, where).toHaveLength(1);
    }
    for (const name of Object.keys(NESTED_EXCEPTIONS)) {
      expect(markup.querySelector(`.file-select-btn .${name}`), name).not.toBeNull();
    }
    for (const allowed of COMPACT_OVERRIDES) {
      const declarations: string[] = [];
      appCss.walkRules((rule) => {
        if (conditionOf(rule) !== allowed.condition) return;
        if (!rule.selectors.map((entry) => entry.trim()).includes(allowed.selector)) return;
        rule.walkDecls((declaration) =>
          declarations.push(`${declaration.prop}: ${declaration.value}`),
        );
      });
      expect(declarations, allowed.selector).toContain(allowed.declaration);
    }
    const resets = new Map<string, string[]>();
    for (const { root } of sheets) {
      root.walkRules((rule) => {
        for (const selector of rule.selectors) {
          const key = selector.replace(/\s+/gu, ' ').trim();
          if (!(key in GLOBAL_RESETS)) continue;
          rule.walkDecls((declaration) =>
            resets.set(key, [
              ...(resets.get(key) ?? []),
              `${declaration.prop}: ${declaration.value}`,
            ]),
          );
        }
      });
    }
    for (const [selector, reset] of Object.entries(GLOBAL_RESETS)) {
      expect(resets.get(selector), selector).toContain(reset.declaration);
    }
    // The right-to-left reset agrees with the label token it reaches.
    expect(`letter-spacing: ${LABEL_VALUES['--button-label-letter-spacing']}`).toBe(
      GLOBAL_RESETS[
        "html[dir='rtl'] :where(h1, h2, h3, h4, p, button, label, span, input, textarea)"
      ]!.declaration,
    );
  });

  it('gives destructive labels one danger foreground role', () => {
    // The color role pairs with --control-danger, the resting destructive
    // surface. It is a new role over an existing red, not a new color.
    const lightContrast = "html[data-theme='light'][data-contrast='more']";
    const lightPrefersContrast = "html[data-theme='light']:not([data-contrast='normal'])";
    expect(ruleValues(appCss, lightContrast, '--danger-foreground')).toEqual(['#a4001d']);
    expect(
      ruleValues(
        appCss,
        lightPrefersContrast,
        '--danger-foreground',
        '@media (prefers-contrast: more)',
      ),
    ).toEqual(['#a4001d']);
    expect(
      ruleValues(appCss, ':root', '--danger-foreground', '@media (forced-colors: active)'),
    ).toEqual(['ButtonText !important']);
    const owners: string[] = [];
    appCss.walkDecls('--danger-foreground', (declaration) =>
      owners.push(where(declaration, 'css/style.css')),
    );
    expect(owners).toHaveLength(4);

    // The same red stays readable on its tinted surface where contrast is
    // raised, and in the default dark palette.
    expect(contrast('#ff3b30', 'rgba(255, 59, 48, 0.09)', '#1a1a1a')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ff3b30', 'rgba(176, 0, 32, 0.24)', '#0a0a0a')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#a4001d', 'rgba(176, 0, 32, 0.24)', '#ffffff')).toBeGreaterThanOrEqual(4.5);

    // Account deletion is the shared secondary action with a color-only
    // danger modifier.
    const remove = appMarkup().getElementById('btn-account-delete')!;
    expect([...remove.classList]).toEqual(['dialog-secondary', 'dialog-danger']);
    const danger = '.dialog-secondary.dialog-danger';
    expect(ruleValues(appCss, danger, 'color')).toEqual(['var(--danger-foreground)']);
    expect(ruleValues(appCss, danger, 'background')).toEqual(['var(--control-danger)']);
    expect(ruleValues(appCss, danger, 'border-color')).toEqual(['transparent']);
    const modifierProperties = new Set<string>();
    appCss.walkRules((rule) => {
      if (!rule.selectors.some((selector) => hasClass(selector, 'dialog-danger'))) return;
      rule.walkDecls((declaration) => modifierProperties.add(declaration.prop));
    });
    expect([...modifierProperties].sort()).toEqual(['background', 'border-color', 'color']);

    // Leave session and stop sharing read the same role.
    expect(ruleValues(appCss, '.leave-session-btn', 'color')).toEqual(['var(--danger-foreground)']);
    expect(ruleValues(appCss, '.leave-session-btn svg', 'fill')).toEqual([
      'var(--danger-foreground)',
    ]);
    expect(ruleValues(playCss, '.play-actions-row', '--play-action-stop-foreground')).toEqual([
      'var(--danger-foreground)',
    ]);

    // No action button or label paints a red of its own.
    const reds: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!/^(?:color|fill|stroke|--[\w-]*foreground)$/u.test(declaration.prop)) return;
        if (!isRedLiteral(declaration.value)) return;
        const rule = declaration.parent;
        if (rule?.type !== 'rule') return;
        const selectors = (rule as unknown as { selectors: string[] }).selectors;
        if (selectors.some((selector) => styledButton(selector) && !isNestedException(selector))) {
          reds.push(`${where(declaration, path)} ${declaration.prop}: ${declaration.value}`);
        }
      });
    }
    expect(reds).toEqual([]);
  });

  it('retires the one-off account delete button and the dead btn-action rule', () => {
    const retired = /\.(?:account-delete-button|btn-action)(?![\w-])/u;
    for (const { path, root } of sheets) {
      root.walkRules((rule) => {
        expect(retired.test(rule.selector), `${path}: ${rule.selector}`).toBe(false);
      });
    }
    expect(appMarkup().querySelector('.account-delete-button, .btn-action')).toBeNull();
    for (const button of templateButtons()) {
      expect(button.classes, button.where).not.toContain('account-delete-button');
      expect(button.classes, button.where).not.toContain('btn-action');
    }
  });
});
