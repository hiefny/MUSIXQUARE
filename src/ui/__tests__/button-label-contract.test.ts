/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parse as parseCss,
  type AtRule,
  type Declaration,
  type Node,
  type Root,
  type Rule,
} from 'postcss';
import { describe, expect, it } from 'vitest';

// Owner decisions (2026-10-27, final 2026-10-28): every button label takes
// one of three size roles, and labels in one role differ only by color: CTA
// (every action button) 15px / 1.25, chip (choice chips) 14px and tab
// (section tabs and segments) 13px, all with normal tracking. Action buttons
// take the label weight 600 in every size slot; the owner withdrew the
// earlier 700, which clumped in dark mode, Korean most of all. Under the
// final weight policy (weight-role-contract.test.ts) choice chips, section
// tabs and the demo tour's step indicator and role switch are selection
// groups: 700 on the selected item and 500 on the others. Each component
// rule reads its role's tokens itself, the same way component rules read
// --radius-pill; a global override would lose to cascade layers and ID
// selectors.
const LABEL_TOKENS: Readonly<Record<string, string>> = {
  'font-size': 'var(--button-label-size)',
  'font-weight': 'var(--font-weight-label)',
  'line-height': 'var(--button-label-line-height)',
  'letter-spacing': 'var(--button-label-letter-spacing)',
};
type Role = 'cta' | 'chip' | 'tab';
// The size token each role reads; the other label tokens are shared.
const ROLE_SIZE_TOKENS: Readonly<Record<Role, string>> = {
  cta: 'var(--button-label-size)',
  chip: 'var(--button-label-chip-size)',
  tab: 'var(--button-label-tab-size)',
};
// The weight tokens' values are pinned by weight-role-contract.test.ts.
const LABEL_VALUES: Readonly<Record<string, string>> = {
  '--button-label-size': '15px',
  '--button-label-line-height': '1.25',
  '--button-label-letter-spacing': 'normal',
  '--button-label-chip-size': '14px',
  '--button-label-tab-size': '13px',
};
// font-variation-settings can set the weight axis of the variable label face
// past font-weight, so button rules may not set it either.
const FONT_PROPERTIES = [
  'font',
  'font-family',
  'font-variation-settings',
  ...Object.keys(LABEL_TOKENS),
];

// The CTA role: a verb label on a pill, plus the selection bar's text action.
// Their rules may declare label typography only through the tokens above, and
// may not paint a hard-coded red (destructive labels read --danger-foreground).
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

// A selection group's weight tokens: the selected item and every other item
// (weight roles, 2026-10-28).
const SELECTION_WEIGHTS = {
  selected: 'var(--font-weight-selected)',
  unselected: 'var(--font-weight-unselected)',
} as const;
// Buttons in another role, by class, with the reason. They read their role's
// size token and share the tracking; both are selection groups, and
// `selected` names the state the app toggles on the chosen one.
const ROLE_CLASSES: Readonly<
  Record<string, { role: Exclude<Role, 'cta'>; selected: string; reason: string }>
> = {
  'ch-opt': {
    role: 'chip',
    selected:
      ".ch-opt.active, .ch-opt.selected, #demo-overlay .ch-opt.demo-choice[aria-pressed='true']",
    reason: 'Choice chips sit two to four per row down to 360px.',
  },
  'subtab-pill': {
    role: 'tab',
    selected: '.subtab-pill.active',
    reason: 'The desktop settings section tabs, a row of four under the panel title.',
  },
};
// Unclassed action buttons in the CTA role, named by the container that styles
// them. Their rule resets the native button font and then reads every CTA
// token: size, weight, line height and tracking.
const CTA_CONTAINERS: Readonly<Record<string, string>> = {
  '.bootstrap-failure':
    'The startup failure Retry is an action button outside the app shell, so it takes ' +
    'the CTA role like every action button.',
};
// Unclassed demo tour controls, named by the container that styles them. They
// keep their own responsive sizes and share the tracking; both are selection
// groups, and `selected` names the state the app toggles on the chosen one.
const SHARED_WEIGHT_CONTAINERS: Readonly<Record<string, { selected: string; reason: string }>> = {
  '.demo-step-nav': {
    selected: '.demo-step-nav button.active, .demo-step-nav button.is-collapsing',
    reason:
      'The demo step indicator keeps its 13px steps (larger on the desktop tour); the ' +
      'current step is the selected one, and keeps its weight while its label folds away.',
  },
  '.demo-role-segmented': {
    selected: ".demo-role-segmented button[aria-pressed='true']",
    reason:
      'The demo role switch keeps its 13px segments (12px on phones, larger on the ' +
      'desktop tour); the chosen role is the selected one.',
  },
};
const CONTAINER_BUTTONS = [
  ...Object.keys(CTA_CONTAINERS),
  ...Object.keys(SHARED_WEIGHT_CONTAINERS),
];
// Text in the CTA role inside a button that is not an action, with its own
// line height and the reason.
const CTA_TEXT: Readonly<Record<string, { lineHeight: string; reason: string }>> = {
  '.chat-preview-text': {
    lineHeight: '1.3',
    reason:
      'The play tab chat preview shows the latest message in the CTA role. One line ' +
      'that an overflow cuts off keeps the 9.0.18 1.3 line box for tall scripts.',
  },
};

// Every other button class in index.html and the TypeScript templates, with
// the reason it carries no button label role. A new button class must join
// one list.
const NOT_ROLE_BUTTONS: Readonly<Record<string, string>> = {
  'btn-ob-icon': 'Icon-only setup button.',
  'nav-item': 'Bottom navigation: a small label under an icon.',
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
  'playlist-switch-button':
    "Playlist title switch: its visible label is the active slot's name in the tab title " +
    'face, content rather than an action label, beside a chevron.',
  'btn-kick-device': 'Icon-only device row action.',
  'btn-kick-physical-device': 'Icon-only device row action.',
  'chat-youtube-btn': 'YouTube card inside a chat bubble.',
  'chat-preview-btn': 'Chat preview bar; its message text takes the CTA role (CTA_TEXT).',
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
  'dialog-link-action':
    "Small text link under a dialog's button pair, like the language dialog's translate " +
    'link (owner decision 2026-10-28).',
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

// The narrow slots (owner decision 2026-10-28). Every action label was
// measured against 9.0.18 (origin/main 6a23c46e) in all 42 locales at 320,
// 340, 360, 375 and 390px and beyond (the UI bundle report, QA round 10).
// Where the CTA role wraps, splits a word, stacks a pair or reaches past its
// pill or the screen further than 9.0.18, the slot takes a smaller role size
// under a named condition instead of an ad hoc value. Line height, weight and
// tracking stay the shared tokens.
//
// The compact members: their markup carries .btn-label-compact, which takes
// the chip role's 14px under the one shared narrow condition.
const COMPACT_CLASS = 'btn-label-compact';
const COMPACT_CONDITION = '@media (max-width: 719px)';
const COMPACT_MEMBERS: Readonly<Record<string, string>> = {
  '#btn-local-file':
    'The media source options: at 15px with normal tracking the local file and system ' +
    'audio labels wrap or split a word in more locales than 9.0.18 (600, -0.3px) in the ' +
    'phone layout.',
  '#btn-youtube-source': 'The media source options stay alike (#btn-local-file).',
  '#btn-system-audio': 'The media source options stay alike (#btn-local-file).',
  '#btn-account-logout':
    'Sign out and Delete account keep one size (owner decision 2026-10-28). At 15px the ' +
    'pair stacks or wraps in more locales than 9.0.18 (Sign out 15px / 700, Delete ' +
    'account 14px / 700).',
  '#btn-account-delete': 'Sign out and Delete account keep one size (#btn-account-logout).',
};
// The demo tour's two-per-row actions take the tab role's 13px on phones up
// to 420px.
const DEMO_FINISH_PAIR =
  'The demo finish pair sits two per row in 54px pills on phones up to 420px. At the chip ' +
  "role's 14px the Tamil Exit Tour reaches past its pill at 320 and 340px where 9.0.18 " +
  "(13px / 600) kept it inside, so the pair takes the tab role's 13px there.";
const DEMO_EFFECT_CHOICES =
  'The demo effect choice cards sit two per row on phones up to 420px. At the chip ' +
  "role's 14px the Russian Bass Boost and Surround and the Malay Bass Boost wrap at " +
  "320px where 9.0.18 (13.5px / 700) kept one line, so the cards take the tab role's " +
  '13px there, beside the finish pair.';
// Declarations that may give an action label a size other than its role's,
// each under its condition and with the reason.
const NARROW_OVERRIDES: ReadonlyArray<{
  condition: string;
  selector: string;
  declaration: string;
  reason: string;
}> = [
  ...['.demo-large-actions .accent-action-btn', '.demo-large-actions .leave-session-btn'].map(
    (selector) => ({
      condition: '@media (max-width: 420px)',
      selector,
      declaration: `font-size: ${ROLE_SIZE_TOKENS.tab}`,
      reason: DEMO_FINISH_PAIR,
    }),
  ),
  {
    condition: '@media (max-width: 420px)',
    selector: '.demo-effects-content .demo-large-actions .ch-opt.demo-choice',
    declaration: `font-size: ${ROLE_SIZE_TOKENS.tab}`,
    reason: DEMO_EFFECT_CHOICES,
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
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const actionAliases = (() => {
  const ids = [
    ...appMarkup().querySelectorAll(ACTION_BUTTON_CLASSES.map((name) => `.${name}`).join(', ')),
  ]
    .map((element) => element.id)
    .filter(Boolean);
  return ids.map((id) => `#${id}`);
})();

interface StyledLabel {
  name: string;
  /** The role whose size token the rule must read; null keeps its own size. */
  role: Role | null;
  /** A selection group reads the selected and unselected weights. */
  selection?: boolean;
}

/** The role member a selector styles, ignoring negations. */
function styledButton(selector: string): StyledLabel | null {
  const positive = withoutNegations(selector);
  for (const name of ACTION_BUTTON_CLASSES) {
    if (hasClass(positive, name)) return { name, role: 'cta' };
  }
  for (const alias of actionAliases) {
    if (new RegExp(`${alias}(?![\\w-])`, 'u').test(positive)) return { name: alias, role: 'cta' };
  }
  for (const [name, { role }] of Object.entries(ROLE_CLASSES)) {
    if (hasClass(positive, name)) return { name, role, selection: true };
  }
  for (const name of Object.keys(CTA_TEXT)) {
    if (hasClass(positive, name.slice(1))) return { name, role: 'cta' };
  }
  for (const container of CONTAINER_BUTTONS) {
    if (new RegExp(`${escapeRegExp(container)}(?![\\w-])[^,]*\\bbutton\\b`, 'u').test(positive)) {
      if (container in CTA_CONTAINERS) return { name: container, role: 'cta' };
      return { name: container, role: null, selection: true };
    }
  }
  return null;
}

/** A selector that styles a nested exception or something inside one. */
const isNestedException = (selector: string): boolean =>
  Object.keys(NESTED_EXCEPTIONS).some((name) => hasClass(withoutNegations(selector), name));

function isNarrowOverride(declaration: Declaration, selector: string): boolean {
  return NARROW_OVERRIDES.some(
    (allowed) =>
      allowed.condition === conditionOf(declaration) &&
      allowed.selector === selector.replace(/\s+/gu, ' ').trim() &&
      allowed.declaration === `${declaration.prop}: ${declaration.value}`,
  );
}

/** The cascade layer around a node, or null outside every layer. */
function layerOf(node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
      return (parent as AtRule).params;
    }
  }
  return null;
}

// The cascade resolver. The named narrow-slot exceptions are pinned by the
// value that wins the cascade on the real markup, not by the rule that sets
// it, so a broader rule in a later layer (a token read included) cannot turn
// them back unnoticed (PR #510 review). It applies importance, cascade
// layers, specificity and source order, then inheritance and var()
// substitution, in each viewport and page state below. Inline label
// typography in the markup is rejected rather than resolved.
interface MediaEnvironment {
  width: number;
  height: number;
  reducedMotion: boolean;
  forcedColors: boolean;
  contrastMore: boolean;
  standalone: boolean;
  /** iOS Safari, the only engine that supports -webkit-touch-callout. */
  touchCallout: boolean;
}

const RESOLVED_PROPERTIES = [
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'font-variation-settings',
] as const;
type ResolvedProperty = (typeof RESOLVED_PROPERTIES)[number];
const INITIAL_VALUES: Readonly<Record<ResolvedProperty, string>> = {
  'font-size': '16px',
  'font-weight': '400',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'font-variation-settings': 'normal',
};
// Chromium's form control defaults (`font: -webkit-small-control`), below every
// author rule.
const FORM_CONTROL_DEFAULTS: Readonly<Record<ResolvedProperty, string>> = {
  'font-size': '13.333px',
  'font-weight': '400',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'font-variation-settings': 'normal',
};

/** Split a selector or query list at its top-level commas. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === '(' || character === '[') depth += 1;
    if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

type Specificity = [number, number, number];
const compareSpecificity = (first: Specificity, second: Specificity): number =>
  first[0] - second[0] || first[1] - second[1] || first[2] - second[2];
const maxSpecificity = (list: string): Specificity =>
  splitTopLevel(list)
    .map(specificity)
    .reduce((best, next) => (compareSpecificity(next, best) > 0 ? next : best), [0, 0, 0]);

/** Selectors Level 4 specificity of one complex selector. */
function specificity(selector: string): Specificity {
  const result: Specificity = [0, 0, 0];
  const add = (other: Specificity): void => {
    result[0] += other[0];
    result[1] += other[1];
    result[2] += other[2];
  };
  const identEnd = (from: number): number => {
    let index = from;
    while (
      index < selector.length &&
      (/[\w\\-]/u.test(selector[index]!) || selector.charCodeAt(index) >= 0x80)
    ) {
      index += selector[index] === '\\' ? 2 : 1;
    }
    return index;
  };
  const closing = (from: number, open: string, close: string): number => {
    let depth = 0;
    let quote = '';
    for (let index = from; index < selector.length; index += 1) {
      const character = selector[index]!;
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === open) depth += 1;
      else if (character === close && --depth === 0) return index;
    }
    throw new Error(`unbalanced selector: ${selector}`);
  };
  let index = 0;
  while (index < selector.length) {
    const character = selector[index]!;
    if (character === '#' || character === '.') {
      result[character === '#' ? 0 : 1] += 1;
      index = identEnd(index + 1);
    } else if (character === '[') {
      result[1] += 1;
      index = closing(index, '[', ']') + 1;
    } else if (character === ':') {
      const element = selector[index + 1] === ':';
      const nameStart = index + (element ? 2 : 1);
      const nameEnd = identEnd(nameStart);
      const name = selector.slice(nameStart, nameEnd).toLowerCase();
      let args = '';
      index = nameEnd;
      if (selector[index] === '(') {
        const end = closing(index, '(', ')');
        args = selector.slice(index + 1, end);
        index = end + 1;
      }
      if (element || ['before', 'after', 'first-line', 'first-letter'].includes(name)) {
        result[2] += 1;
      } else if (name === 'where') {
        // Zero specificity.
      } else if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) {
        add(maxSpecificity(args));
      } else if (/^nth-(?:last-)?child$/u.test(name) && /\sof\s/u.test(args)) {
        result[1] += 1;
        add(maxSpecificity(args.slice(args.search(/\sof\s/u) + 4)));
      } else {
        result[1] += 1;
      }
    } else if (/[a-zA-Z_\\-]/u.test(character)) {
      result[2] += 1;
      index = identEnd(index);
    } else {
      // Universal selector, combinators and whitespace.
      index += 1;
    }
  }
  return result;
}

function mediaFeature(feature: string, environment: MediaEnvironment): boolean {
  const match = /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/u.exec(feature);
  if (!match) throw new Error(`the resolver cannot evaluate the media feature ${feature}`);
  const [, name, value] = match as unknown as [string, string, string];
  const pixels = (): number => {
    const length = /^(\d+(?:\.\d+)?)px$/u.exec(value);
    if (!length) throw new Error(`the resolver cannot evaluate the length in ${feature}`);
    return Number(length[1]);
  };
  const keyword = (on: string, off: string, state: boolean): boolean => {
    if (value === on) return state;
    if (value === off) return !state;
    throw new Error(`the resolver cannot evaluate ${feature}`);
  };
  switch (name) {
    case 'min-width':
      return environment.width >= pixels();
    case 'max-width':
      return environment.width <= pixels();
    case 'min-height':
      return environment.height >= pixels();
    case 'max-height':
      return environment.height <= pixels();
    case 'orientation':
      return keyword('portrait', 'landscape', environment.height >= environment.width);
    case 'prefers-reduced-motion':
      return keyword('reduce', 'no-preference', environment.reducedMotion);
    case 'forced-colors':
      return keyword('active', 'none', environment.forcedColors);
    case 'prefers-contrast':
      return keyword('more', 'no-preference', environment.contrastMore);
    case 'display-mode':
      return keyword('standalone', 'browser', environment.standalone);
    default:
      throw new Error(`the resolver cannot evaluate the media feature ${feature}`);
  }
}

/** Whether a media query list matches the environment. */
function mediaMatches(queries: string, environment: MediaEnvironment): boolean {
  return splitTopLevel(queries).some((query) => {
    const negated = /^not\s+/u.test(query);
    const terms = query
      .replace(/^(?:not|only)\s+/u, '')
      .split(/\s+and\s+/u)
      .map((term) => term.trim());
    const matches = terms.every((term) =>
      term === 'all' || term === 'screen' ? true : mediaFeature(term, environment),
    );
    return negated ? !matches : matches;
  });
}

const conditionResults = new WeakMap<MediaEnvironment, Map<AtRule, boolean>>();

/** Whether every conditional group rule around a node applies. */
function conditionsApply(node: Node, environment: MediaEnvironment): boolean {
  let known = conditionResults.get(environment);
  if (!known) conditionResults.set(environment, (known = new Map()));
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as AtRule;
    if (atRule.name === 'layer') continue;
    let applies = known.get(atRule);
    if (applies === undefined) {
      applies = conditionApplies(atRule, environment);
      known.set(atRule, applies);
    }
    if (!applies) return false;
  }
  return true;
}

interface CascadeCandidate {
  property: string;
  value: string;
  important: boolean;
  layer: number;
  specificity: Specificity;
  order: number;
  node: Node;
  where: string;
}

/**
 * Every declaration of a resolved property, the font shorthand or a custom
 * property, by property, once per selector of its rule.
 */
function cascadeDeclarations(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
): Map<string, Array<CascadeCandidate & { selector: string }>> {
  const orderStatement: string[] = [];
  stylesheets[0]!.root.walkAtRules('layer', (atRule) => {
    if (!atRule.nodes && orderStatement.length === 0) {
      orderStatement.push(...atRule.params.split(',').map((name) => name.trim()));
    }
  });
  expect(orderStatement.length).toBeGreaterThan(0);
  const byProperty = new Map<string, Array<CascadeCandidate & { selector: string }>>();
  stylesheets.forEach(({ path, root }, sheetIndex) => {
    root.walkDecls((declaration) => {
      if (
        declaration.prop !== 'font' &&
        !declaration.prop.startsWith('--') &&
        !(RESOLVED_PROPERTIES as readonly string[]).includes(declaration.prop)
      ) {
        return;
      }
      const rule = declaration.parent;
      if (rule?.type !== 'rule') return;
      const layers: string[] = [];
      for (let parent = rule.parent as Node | undefined; parent; parent = parent.parent as Node) {
        if (parent.type === 'atrule' && (parent as AtRule).name === 'layer') {
          layers.unshift((parent as AtRule).params);
        } else if (parent.type === 'rule') {
          throw new Error(`the resolver does not read nested rules: ${where(declaration, path)}`);
        }
      }
      const layerName = layers.join('.');
      const layer = layerName === '' ? orderStatement.length : orderStatement.indexOf(layerName);
      if (layer < 0) throw new Error(`${path}: layer ${layerName} is not in the order statement`);
      for (const selector of (rule as unknown as { selectors: string[] }).selectors) {
        if (selector.includes('::')) continue;
        const list = byProperty.get(declaration.prop) ?? [];
        list.push({
          selector,
          property: declaration.prop,
          value: declaration.value,
          important: Boolean(declaration.important),
          layer,
          specificity: specificity(selector),
          order: sheetIndex * 10_000_000 + (declaration.source?.start?.offset ?? 0),
          node: declaration,
          where: `${where(declaration, path)} ${selector.replace(/\s+/gu, ' ')}`,
        });
        byProperty.set(declaration.prop, list);
      }
    });
  });
  return byProperty;
}

/** Positive when the first declaration wins the cascade over the second. */
function cascadeOrder(first: CascadeCandidate, second: CascadeCandidate): number {
  if (first.important !== second.important) return first.important ? 1 : -1;
  if (first.layer !== second.layer) {
    // Later layers win normal declarations; earlier layers win important ones.
    return first.important ? second.layer - first.layer : first.layer - second.layer;
  }
  return compareSpecificity(first.specificity, second.specificity) || first.order - second.order;
}

/** The type, IDs and classes that the rightmost compound of a selector requires. */
interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
}
const compounds = new Map<string, Compound | null>();
function rightmostCompound(selector: string): Compound | null {
  if (compounds.has(selector)) return compounds.get(selector)!;
  let depth = 0;
  let start = 0;
  for (let index = selector.length - 1; index >= 0; index -= 1) {
    const character = selector[index]!;
    if (character === ')' || character === ']') depth += 1;
    else if (character === '(' || character === '[') depth -= 1;
    else if (depth === 0 && /[\s>+~]/u.test(character)) {
      start = index + 1;
      break;
    }
  }
  const compound = selector.slice(start);
  let result: Compound | null = null;
  // Escaped names are left to the full match.
  if (!compound.includes('\\')) {
    let bare = '';
    depth = 0;
    for (const character of compound) {
      if (character === '(' || character === '[') depth += 1;
      if (depth === 0) bare += character;
      if (character === ')' || character === ']') depth -= 1;
    }
    result = {
      tag: /^[a-z][\w-]*/iu.exec(bare)?.[0]?.toLowerCase() ?? null,
      ids: [...bare.matchAll(/#([\w-]+)/gu)].map((match) => match[1]!),
      classes: [...bare.matchAll(/\.([\w-]+)/gu)].map((match) => match[1]!),
    };
  }
  compounds.set(selector, result);
  return result;
}

/** Whether an element cannot match a selector, judged by its rightmost compound alone. */
function cannotMatch(element: Element, selector: string): boolean {
  const compound = rightmostCompound(selector);
  if (!compound) return false;
  if (compound.tag && element.localName !== compound.tag) return true;
  if (compound.ids.some((id) => element.id !== id)) return true;
  return compound.classes.some((name) => !element.classList.contains(name));
}

/**
 * Resolves label typography on one document state. Selector matching depends
 * only on the document, so it is cached; media conditions are applied per
 * environment.
 */
function cascadeResolver(
  declarations: ReadonlyMap<string, ReadonlyArray<CascadeCandidate & { selector: string }>>,
) {
  // The declarations that match each element, strongest first.
  const matched = new Map<Element, Map<string, CascadeCandidate[]>>();
  // Whether each element matches each selector, shared by every property.
  const selectorMatches = new Map<Element, Map<string, boolean>>();
  const matches = (element: Element, candidate: CascadeCandidate & { selector: string }) => {
    let bySelector = selectorMatches.get(element);
    if (!bySelector) selectorMatches.set(element, (bySelector = new Map()));
    let result = bySelector.get(candidate.selector);
    if (result === undefined) {
      try {
        result = !cannotMatch(element, candidate.selector) && element.matches(candidate.selector);
      } catch {
        throw new Error(`jsdom cannot match ${candidate.where}`);
      }
      bySelector.set(candidate.selector, result);
    }
    return result;
  };
  const matchedInOrder = (element: Element, properties: readonly string[]) => {
    let byKey = matched.get(element);
    if (!byKey) matched.set(element, (byKey = new Map()));
    const key = properties.join(' ');
    let list = byKey.get(key);
    if (!list) {
      list = properties
        .flatMap((property) => declarations.get(property) ?? [])
        .filter((candidate) => matches(element, candidate))
        .sort((first, second) => cascadeOrder(second, first));
      byKey.set(key, list);
    }
    return list;
  };

  const winner = (
    element: Element,
    properties: readonly string[],
    environment: MediaEnvironment,
  ): CascadeCandidate | null =>
    matchedInOrder(element, properties).find((candidate) =>
      conditionsApply(candidate.node, environment),
    ) ?? null;

  const substitute = (element: Element, value: string, environment: MediaEnvironment): string =>
    value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/gu, (_, name: string, fallback) => {
      const resolved = custom(element, name, environment);
      if (resolved !== null) return resolved;
      if (fallback === undefined) throw new Error(`${name} is not defined`);
      return substitute(element, String(fallback).trim(), environment);
    });

  // Values already resolved on this document state, by element, environment
  // and property: labels share their ancestors' inherited values.
  const memo = new Map<Element, Map<MediaEnvironment, Map<string, string | null>>>();
  const remembered = (
    element: Element,
    environment: MediaEnvironment,
    key: string,
    compute: () => string | null,
  ): string | null => {
    let byEnvironment = memo.get(element);
    if (!byEnvironment) memo.set(element, (byEnvironment = new Map()));
    let byKey = byEnvironment.get(environment);
    if (!byKey) byEnvironment.set(environment, (byKey = new Map()));
    if (byKey.has(key)) return byKey.get(key)!;
    const value = compute();
    byKey.set(key, value);
    return value;
  };

  const custom = (element: Element, name: string, environment: MediaEnvironment): string | null =>
    remembered(element, environment, name, () => customValue(element, name, environment));

  const customValue = (
    element: Element,
    name: string,
    environment: MediaEnvironment,
  ): string | null => {
    const found = winner(element, [name], environment);
    if (!found || found.value === 'inherit' || found.value === 'unset') {
      return element.parentElement ? custom(element.parentElement, name, environment) : null;
    }
    return substitute(element, found.value, environment);
  };

  const resolve = (
    element: Element,
    property: ResolvedProperty,
    environment: MediaEnvironment,
  ): string =>
    remembered(element, environment, property, () => resolveValue(element, property, environment))!;

  const resolveValue = (
    element: Element,
    property: ResolvedProperty,
    environment: MediaEnvironment,
  ): string => {
    // The font shorthand sets or resets every resolved property but tracking.
    const shorthand = property === 'letter-spacing' ? [] : ['font'];
    const found = winner(element, [property, ...shorthand], environment);
    // The resolver reads stylesheets only; markup must not style labels inline.
    if (/font|letter-spacing|line-height|--/u.test(element.getAttribute('style') ?? '')) {
      throw new Error(`inline label typography: ${element.outerHTML.slice(0, 80)}`);
    }
    const inherited = (): string =>
      element.parentElement
        ? resolve(element.parentElement, property, environment)
        : INITIAL_VALUES[property];
    if (!found) {
      return element.matches('button, input, select, textarea')
        ? FORM_CONTROL_DEFAULTS[property]
        : inherited();
    }
    if (found.value === 'inherit' || found.value === 'unset') return inherited();
    if (found.property === 'font') return `font: ${found.value} (${found.where})`;
    if (found.value === 'initial') return INITIAL_VALUES[property];
    const value = substitute(element, found.value, environment);
    if (property === 'font-weight') {
      return value === 'normal' ? '400' : value === 'bold' ? '700' : value;
    }
    return value;
  };

  return (element: Element, environment: MediaEnvironment): Record<ResolvedProperty, string> =>
    Object.fromEntries(
      RESOLVED_PROPERTIES.map((property) => [property, resolve(element, property, environment)]),
    ) as Record<ResolvedProperty, string>;
}

// The resolver's viewports come from the stylesheets themselves (PR #510
// review): every width and height that a media query names, with the pixel on
// either side, against every sampled height and width, so a new range cannot
// fall between two samples. Each sampled width is also taken square (portrait)
// and one pixel shorter (landscape), and each height likewise, so orientation
// conditions see both sides of every boundary. Common phone and screen sizes
// are added as anchors. A length the resolver cannot read fails the test.
const ANCHOR_WIDTHS = [320, 340, 360, 375, 390];
const ANCHOR_HEIGHTS = [568, 640, 667, 800, 844, 1080, 1440, 2160];
const MEDIA_PREFERENCES = [
  'reducedMotion',
  'forcedColors',
  'contrastMore',
  'standalone',
  'touchCallout',
] as const;

/** The widths and heights at which some media query in the sheets switches. */
function mediaBoundaries(stylesheets: ReadonlyArray<{ path: string; root: Root }>): {
  width: number[];
  height: number[];
} {
  const found = { width: new Set<number>(), height: new Set<number>() };
  for (const { path, root } of stylesheets) {
    root.walkAtRules('media', (atRule) => {
      if (/[<>=]/u.test(atRule.params)) {
        throw new Error(`${path}: cannot sample the range syntax in @media ${atRule.params}`);
      }
      for (const match of atRule.params.matchAll(
        /\(\s*(?:min-|max-)?(width|height)\s*:\s*([^)]*?)\s*\)/gu,
      )) {
        const length = /^(\d+(?:\.\d+)?)px$/u.exec(match[2]!);
        if (!length) throw new Error(`${path}: cannot sample @media ${atRule.params}`);
        found[match[1] as 'width' | 'height'].add(Number(length[1]));
      }
    });
  }
  const sorted = (values: Set<number>) => [...values].sort((first, second) => first - second);
  return { width: sorted(found.width), height: sorted(found.height) };
}

/** Each boundary and the pixel on either side, plus the anchors. */
function aroundBoundaries(boundaries: readonly number[], anchors: readonly number[]): number[] {
  return [...new Set([...boundaries.flatMap((value) => [value - 1, value, value + 1]), ...anchors])]
    .filter((value) => value > 0)
    .sort((first, second) => first - second);
}

function resolverViewports(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
): Array<[number, number]> {
  const boundaries = mediaBoundaries(stylesheets);
  const widths = aroundBoundaries(boundaries.width, ANCHOR_WIDTHS);
  const heights = aroundBoundaries(boundaries.height, ANCHOR_HEIGHTS);
  const viewports = new Map<string, [number, number]>();
  const add = (width: number, height: number): void => {
    if (width > 0 && height > 0) viewports.set(`${width}x${height}`, [width, height]);
  };
  for (const width of widths) {
    for (const height of heights) add(width, height);
    add(width, width);
    add(width, width - 1);
  }
  for (const height of heights) {
    add(height, height);
    add(height + 1, height);
  }
  return [...viewports.values()];
}

/** Whether a conditional group rule (not a layer) applies in the environment. */
function conditionApplies(atRule: AtRule, environment: MediaEnvironment): boolean {
  if (atRule.name === 'media') return mediaMatches(atRule.params, environment);
  if (atRule.name === 'supports' && atRule.params === '(-webkit-touch-callout: none)') {
    return environment.touchCallout;
  }
  throw new Error(`the resolver cannot evaluate @${atRule.name} ${atRule.params}`);
}

/**
 * The conditional group rules that can change label typography: those around
 * a declaration of a resolved property or the font shorthand, or of a custom
 * property that such a declaration reads, directly or through other custom
 * properties.
 */
function labelConditions(stylesheets: ReadonlyArray<{ path: string; root: Root }>): AtRule[] {
  const typography: Declaration[] = [];
  const customs = new Map<string, Declaration[]>();
  for (const { root } of stylesheets) {
    root.walkDecls((declaration) => {
      if (declaration.prop.startsWith('--')) {
        customs.set(declaration.prop, [...(customs.get(declaration.prop) ?? []), declaration]);
      } else if (
        declaration.prop === 'font' ||
        (RESOLVED_PROPERTIES as readonly string[]).includes(declaration.prop)
      ) {
        typography.push(declaration);
      }
    });
  }
  const read = new Set<string>();
  const queue = [...typography];
  while (queue.length > 0) {
    const declaration = queue.pop()!;
    for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/gu)) {
      const name = match[1]!;
      if (read.has(name)) continue;
      read.add(name);
      queue.push(...(customs.get(name) ?? []));
    }
  }
  const relevant = new Set<AtRule>();
  for (const declaration of [
    ...typography,
    ...[...read].flatMap((name) => customs.get(name) ?? []),
  ]) {
    for (
      let parent = declaration.parent as Node | undefined;
      parent;
      parent = parent.parent as Node
    ) {
      if (parent.type !== 'atrule') continue;
      const atRule = parent as AtRule;
      // Container queries do not depend on the viewport; a label declaration
      // under one fails the resolver instead (conditionsApply).
      if (atRule.name === 'media' || atRule.name === 'supports') relevant.add(atRule);
    }
  }
  return [...relevant];
}

/**
 * Every derived viewport, alone and with each media preference, reduced to
 * one environment per distinct set of matching conditions that can change
 * label typography: the cascade reads nothing else from the environment, so
 * the others resolve identically.
 */
function resolverEnvironments(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
): MediaEnvironment[] {
  const conditions = labelConditions(stylesheets);
  const environments = resolverViewports(stylesheets).flatMap(([width, height]) => {
    const base: MediaEnvironment = {
      width,
      height,
      reducedMotion: false,
      forcedColors: false,
      contrastMore: false,
      standalone: false,
      touchCallout: false,
    };
    return [base, ...MEDIA_PREFERENCES.map((flag) => ({ ...base, [flag]: true }))];
  });
  const distinct = new Map<string, MediaEnvironment>();
  for (const environment of environments) {
    const key = conditions
      .map((atRule) => (conditionApplies(atRule, environment) ? '1' : '0'))
      .join('');
    if (!distinct.has(key)) distinct.set(key, environment);
  }
  return [...distinct.values()];
}

const RESOLVER_ENVIRONMENTS: MediaEnvironment[] = resolverEnvironments(sheets);

// Page states that app rules key on, applied one at a time over each
// direction and theme. Each state toggles one attribute or class on the parsed
// markup and returns its undo, so the large index.html is parsed once per run.
type PageState = { name: string; apply: (markup: Document) => () => void };
const toggleClass =
  (selector: string, className: string): PageState['apply'] =>
  (markup) => {
    const element = markup.querySelector(selector)!;
    expect(element.classList.contains(className), `${selector}.${className}`).toBe(false);
    element.classList.add(className);
    return () => element.classList.remove(className);
  };
const setAttribute =
  (selector: string, name: string, value = ''): PageState['apply'] =>
  (markup) => {
    const elements = [...markup.querySelectorAll(selector)];
    expect(elements.length, selector).toBeGreaterThan(0);
    const previous = elements.map((element) => element.getAttribute(name));
    for (const element of elements) {
      expect(element.getAttribute(name), `${selector}[${name}]`).not.toBe(value);
      element.setAttribute(name, value);
    }
    return () => {
      elements.forEach((element, index) => {
        const before = previous[index];
        if (before === null || before === undefined) element.removeAttribute(name);
        else element.setAttribute(name, before);
      });
    };
  };
const SHARED_PAGE_STATES: readonly PageState[] = [
  { name: 'at rest', apply: () => () => undefined },
  { name: 'hover pointer', apply: setAttribute('html', 'data-hover-pointer') },
  { name: 'more contrast', apply: setAttribute('html', 'data-contrast', 'more') },
  { name: 'PRO room', apply: setAttribute('html', 'data-pro-room', 'true') },
  { name: 'iOS standalone', apply: toggleClass('html', 'ios-standalone') },
  { name: 'standalone', apply: toggleClass('html', 'standalone') },
  { name: 'keyboard open', apply: toggleClass('html', 'keyboard-open') },
  { name: 'overlay open', apply: toggleClass('body', 'overlay-open') },
  { name: 'fake fullscreen', apply: toggleClass('body', 'has-fake-fullscreen') },
];

// One cascade and one environment list per stylesheet set: every slot and
// mutation check over the same sheets reuses them.
const declarationCache = new WeakMap<object, ReturnType<typeof cascadeDeclarations>>();
const environmentCache = new WeakMap<object, MediaEnvironment[]>([[sheets, RESOLVER_ENVIRONMENTS]]);

/** Resolve every element under each direction, theme, page state and viewport. */
function resolveAcross(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
  prepare: (markup: Document) => void,
  states: readonly PageState[],
  targets: (markup: Document) => Element[],
  visit: (
    resolved: Record<ResolvedProperty, string>,
    context: {
      label: string;
      direction: string;
      environment: MediaEnvironment;
      element: Element;
    },
  ) => void,
): number {
  let declarations = declarationCache.get(stylesheets);
  if (!declarations)
    declarationCache.set(stylesheets, (declarations = cascadeDeclarations(stylesheets)));
  let environments = environmentCache.get(stylesheets);
  if (!environments)
    environmentCache.set(stylesheets, (environments = resolverEnvironments(stylesheets)));
  const markup = appMarkup();
  markup.documentElement.classList.remove('setup-boot-block');
  markup.body.classList.add('fouc-loaded');
  prepare(markup);
  const elements = targets(markup);
  expect(elements.length).toBeGreaterThan(0);
  let resolutions = 0;
  for (const direction of ['ltr', 'rtl']) {
    for (const theme of ['dark', 'light']) {
      markup.documentElement.setAttribute('dir', direction);
      markup.documentElement.setAttribute('data-theme', theme);
      for (const state of states) {
        const undo = state.apply(markup);
        const resolve = cascadeResolver(declarations);
        for (const environment of environments) {
          for (const element of elements) {
            resolutions += 1;
            visit(resolve(element, environment), {
              label:
                `${direction} ${theme} ${state.name} ${environment.width}x${environment.height}` +
                `${environment.reducedMotion ? ' reduced-motion' : ''}` +
                `${environment.forcedColors ? ' forced-colors' : ''}` +
                `${environment.contrastMore ? ' prefers-contrast' : ''}` +
                `${environment.standalone ? ' display-standalone' : ''}` +
                `${environment.touchCallout ? ' ios' : ''} ` +
                `${element.closest('button')?.id || element.closest('button')?.className} ` +
                `${element.tagName.toLowerCase()} ${element.textContent?.trim()}`,
              direction,
              environment,
              element,
            });
          }
        }
        undo();
      }
    }
  }
  return resolutions;
}

/** Label typography a declaration may not set on a role member or its label. */
function labelViolation(declaration: Declaration, styled: StyledLabel): boolean {
  if (declaration.prop === 'font-family') return true;
  // The buttons named by their container (the startup failure Retry and the
  // demo tour controls) reset the native button font ahead of their own
  // longhands in the same rule; the cascade resolver checks that the
  // longhands win.
  if (declaration.prop === 'font') {
    return !(CONTAINER_BUTTONS.includes(styled.name) && declaration.value === 'inherit');
  }
  if (declaration.prop === 'font-size') {
    return styled.role !== null && declaration.value !== ROLE_SIZE_TOKENS[styled.role];
  }
  if (declaration.prop === 'line-height') {
    const text = CTA_TEXT[styled.name];
    if (text) return declaration.value !== text.lineHeight;
    // The tab role and the demo tour controls keep their own line box.
    if (styled.role === null || styled.role === 'tab') return false;
  }
  if (declaration.prop === 'font-weight' && styled.selection) {
    return !(Object.values(SELECTION_WEIGHTS) as string[]).includes(declaration.value);
  }
  return declaration.value !== LABEL_TOKENS[declaration.prop];
}

// The CSS named colors (CSS Color 4), so a red cannot hide behind its name.
const NAMED_COLORS: ReadonlyMap<string, string> = new Map(
  [
    ...`
  aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff
  beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2
  brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50
  cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b
  darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b
  darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000
  darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f
  darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff
  dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0
  forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520
  gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4
  indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5
  lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff
  lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1
  lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899
  lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32
  linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd
  mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee
  mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970
  mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6
  olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa
  palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9
  peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399
  red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460
  seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd
  slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c
  teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3
  white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32
  `.matchAll(/([a-z]+) ([0-9a-f]{6})/gu),
  ].map((match) => [match[1]!, `#${match[2]!}`]),
);

/** The arguments of a color function, without its alpha. */
function colorArguments(body: string): string[] {
  return body
    .replace(/\/.*$/u, '')
    .split(/[\s,]+/u)
    .filter(Boolean);
}

/** A number, or a percentage of `full`; `none` is zero. */
function amount(token: string | undefined, full: number): number {
  if (!token || token === 'none') return 0;
  return token.endsWith('%') ? (Number.parseFloat(token) / 100) * full : Number.parseFloat(token);
}

/** An angle in degrees. */
function hue(token: string | undefined): number {
  if (!token || token === 'none') return 0;
  const value = Number.parseFloat(token);
  const degrees = token.endsWith('turn')
    ? value * 360
    : token.endsWith('grad')
      ? value * 0.9
      : token.endsWith('rad')
        ? (value * 180) / Math.PI
        : value;
  return ((degrees % 360) + 360) % 360;
}

function hslChannels(h: number, s: number, l: number): number[] {
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  });
}

function hwbChannels(h: number, w: number, b: number): number[] {
  if (w + b >= 1) return [0, 0, 0].map(() => (w / (w + b)) * 255);
  return hslChannels(h, 1, 0.5).map((channel) => (channel / 255) * (1 - w - b) * 255 + w * 255);
}

const multiply = (matrix: number[][], vector: number[]): number[] =>
  matrix.map((row) => row.reduce((sum, factor, index) => sum + factor * vector[index]!, 0));

const XYZ_D65_TO_LINEAR_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const XYZ_D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const LINEAR_P3_TO_XYZ_D65 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

/** Gamma-encode linear sRGB and clip it to the gamut, in 0-255. */
function encodeSrgb(linear: number[]): number[] {
  return linear.map((channel) => {
    const clipped = Math.min(1, Math.max(0, channel));
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return encoded * 255;
  });
}

const decodeSrgb = (channel: number): number =>
  Math.abs(channel) <= 0.04045
    ? channel / 12.92
    : Math.sign(channel) * ((Math.abs(channel) + 0.055) / 1.055) ** 2.4;

function labChannels(l: number, a: number, b: number): number[] {
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const xyzD50 = [
    (fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa) * 0.9642956764295677,
    l > kappa * epsilon ? fy ** 3 : l / kappa,
    (fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa) * 0.8251046025104602,
  ];
  return encodeSrgb(multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_D65, xyzD50)));
}

function oklabChannels(l: number, a: number, b: number): number[] {
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((channel) => channel ** 3);
  return encodeSrgb(
    multiply(
      [
        [4.0767416621, -3.3077115913, 0.2309699292],
        [-1.2684380046, 2.6097574011, -0.3413193965],
        [-0.0041960863, -0.7034186147, 1.707614701],
      ],
      lms,
    ),
  );
}

/** Channels of a color() value, or null for a space this guard cannot read. */
function colorSpaceChannels(space: string, values: number[]): number[] | null {
  switch (space) {
    case 'srgb':
      return values.map((channel) => channel * 255);
    case 'srgb-linear':
      return encodeSrgb(values);
    case 'display-p3':
      return encodeSrgb(
        multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(LINEAR_P3_TO_XYZ_D65, values.map(decodeSrgb))),
      );
    case 'xyz':
    case 'xyz-d65':
      return encodeSrgb(multiply(XYZ_D65_TO_LINEAR_SRGB, values));
    case 'xyz-d50':
      return encodeSrgb(multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_D65, values)));
    default:
      return null;
  }
}

/**
 * Every color a declaration value names, as sRGB channels: hex, named colors
 * and the rgb, hsl, hwb, lab, lch, oklab, oklch and color() functions. A
 * value a guard cannot read is reported by unreadableColors() instead.
 */
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
  for (const [word] of value.matchAll(/(?<![\w#.-])[a-z]+(?![\w-])/giu)) {
    const named = NAMED_COLORS.get(word.toLowerCase());
    if (named) colors.push(...channels(named));
  }
  for (const match of value.matchAll(
    /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(?!from\b)([^()]*)\)/giu,
  )) {
    const name = match[1]!.toLowerCase();
    const args = colorArguments(match[2]!);
    if (name === 'rgb' || name === 'rgba') {
      colors.push(args.slice(0, 3).map((token) => amount(token, 255)));
    } else if (name === 'hsl' || name === 'hsla') {
      colors.push(
        hslChannels(hue(args[0]), amount(args[1], 100) / 100, amount(args[2], 100) / 100),
      );
    } else if (name === 'hwb') {
      colors.push(
        hwbChannels(hue(args[0]), amount(args[1], 100) / 100, amount(args[2], 100) / 100),
      );
    } else if (name === 'lab') {
      colors.push(labChannels(amount(args[0], 100), amount(args[1], 125), amount(args[2], 125)));
    } else if (name === 'lch') {
      const [chroma, angle] = [amount(args[1], 150), (hue(args[2]) * Math.PI) / 180];
      colors.push(
        labChannels(amount(args[0], 100), chroma * Math.cos(angle), chroma * Math.sin(angle)),
      );
    } else if (name === 'oklab') {
      colors.push(oklabChannels(amount(args[0], 1), amount(args[1], 0.4), amount(args[2], 0.4)));
    } else if (name === 'oklch') {
      const [chroma, angle] = [amount(args[1], 0.4), (hue(args[2]) * Math.PI) / 180];
      colors.push(
        oklabChannels(amount(args[0], 1), chroma * Math.cos(angle), chroma * Math.sin(angle)),
      );
    } else {
      const [space = '', ...values] = args;
      const read = colorSpaceChannels(
        space.toLowerCase(),
        values.slice(0, 3).map((token) => amount(token, 1)),
      );
      if (read) colors.push(read);
    }
  }
  return colors;
}

/** Color syntax the guards cannot turn into channels: relative colors and other color() spaces. */
function unreadableColors(value: string): string[] {
  return [
    ...value.matchAll(
      /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*from\b|\bcolor\(\s*(?!(?:srgb|srgb-linear|display-p3|xyz|xyz-d65|xyz-d50)\b)[\w-]+/giu,
    ),
  ].map((match) => match[0]);
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
  name in ROLE_CLASSES ||
  name in NOT_ROLE_BUTTONS;

/** Mount the action buttons that TypeScript renders at runtime, as it renders them. */
function mountRuntimeActions(markup: Document): void {
  const mountIn = (selector: string, html: string): void => {
    const container = markup.querySelector(selector);
    expect(container, selector).not.toBeNull();
    container!.insertAdjacentHTML('beforeend', html);
  };
  mountIn(
    '#qr-container',
    '<button type="button" class="btn-copy-invite-link"><svg viewBox="0 0 24 24"></svg>' +
      '<span class="material-elastic-spinner signaling-recovery-spinner" aria-hidden="true"></span>' +
      '<span data-i18n="connect.copy_invite_link">Copy invite link</span></button>',
  );
  mountIn(
    '.playlist-title-area',
    '<button type="button" class="playlist-selection-toggle">Select all</button>',
  );
  mountIn(
    '#setup-actions',
    '<button type="button" class="btn-ob-secondary">Back</button>' +
      '<button type="button" class="btn-ob-primary">Start</button>',
  );
  const vertical = markup.getElementById('setup-actions')!.cloneNode(true) as HTMLElement;
  vertical.removeAttribute('id');
  vertical.classList.add('vertical');
  markup.getElementById('setup-actions')!.after(vertical);
}

/** index.html with the action buttons that TypeScript mounts at runtime. */
function markupWithRuntimeActions(): Document {
  const markup = appMarkup();
  mountRuntimeActions(markup);
  return markup;
}

// Every action label resolves to a named role: the value that wins the cascade
// on the real markup, in every page state that app rules key on, both
// directions and themes and every derived viewport. A '*' leaves a property to
// the member (the tab role and the demo tour controls keep their line box).
interface ResolveContext {
  direction: string;
  environment: MediaEnvironment;
}
type Expected = Record<ResolvedProperty, string>;
interface RoleSlot {
  name: string;
  prepare: (markup: Document) => void;
  states: readonly PageState[];
  targets: (markup: Document) => Element[];
}
const typography = (
  size: string,
  weight: string,
  lineHeight: string,
  letterSpacing: string,
): Expected => ({
  'font-size': size,
  'font-weight': weight,
  'line-height': lineHeight,
  'letter-spacing': letterSpacing,
  'font-variation-settings': 'normal',
});
// The roles as they resolve. The compact members take the chip role's size in
// the CTA's line box, and the demo finish pair the tab role's size. The 600
// here is the action weight; expectedWeight() gives a selection group's
// items 700 or 500 instead.
const ROLE_LABELS = {
  cta: typography('15px', '600', '1.25', 'normal'),
  chip: typography('14px', '600', '1.25', 'normal'),
  tab: typography('13px', '600', '*', 'normal'),
} as const;
const COMPACT_LABEL = ROLE_LABELS.chip;
const DEMO_PAIR_NARROW_LABEL = typography('13px', '600', '1.25', 'normal');
const SHARED_WEIGHT_LABEL = typography('*', '600', '*', 'normal');
const HIDDEN_LABEL = typography('0', '600', '1.25', 'normal');
// A label the layout hides takes no role.
const UNSHOWN: Expected = {
  'font-size': '*',
  'font-weight': '*',
  'line-height': '*',
  'letter-spacing': '*',
  'font-variation-settings': '*',
};
// The desktop settings tabs show only in the desktop layout; elsewhere their
// row is hidden (css/style.css) and its buttons carry no label style.
const TAB_CONDITION = (() => {
  const conditions = new Set<string | null>();
  for (const { root } of sheets) {
    root.walkRules('.subtab-pill', (rule) => {
      if (rule.some((node) => node.type === 'decl' && node.prop === 'font-size')) {
        conditions.add(conditionOf(rule));
      }
    });
  }
  const [condition, ...others] = [...conditions];
  if (!condition || others.length > 0) {
    throw new Error(`the tab role needs one condition: ${[...conditions].join(' / ')}`);
  }
  return condition;
})();

const COMPACT_MEMBER_SELECTOR = Object.keys(COMPACT_MEMBERS).join(', ');
const atMedia = (condition: string): string => condition.replace(/^@media\s+/u, '');
const compactApplies = (environment: MediaEnvironment): boolean =>
  mediaMatches(atMedia(COMPACT_CONDITION), environment);
const HIDDEN_CLOSE = NARROW_OVERRIDES.find((entry) => entry.declaration === 'font-size: 0')!;
const SHARED_WEIGHT_SELECTOR = Object.keys(SHARED_WEIGHT_CONTAINERS)
  .map((container) => `${container} button`)
  .join(', ');

/**
 * The weight a label must resolve to: a selection group's chosen item 700
 * and its other items 500 (weight roles, 2026-10-28), every action 600.
 */
function expectedWeight(element: Element): string {
  for (const [name, { selected }] of Object.entries(ROLE_CLASSES)) {
    const member = element.closest(`.${name}`);
    if (member) return member.matches(selected) ? '700' : '500';
  }
  for (const [container, { selected }] of Object.entries(SHARED_WEIGHT_CONTAINERS)) {
    const member = element.closest(`${container} button`);
    if (member) return member.matches(selected) ? '700' : '500';
  }
  return '600';
}

/** The role typography an action label must resolve to, by its membership. */
function expectedRole(element: Element, context: ResolveContext): Expected {
  const expected = expectedSizeRole(element, context);
  return expected === UNSHOWN ? expected : { ...expected, 'font-weight': expectedWeight(element) };
}

function expectedSizeRole(element: Element, { environment }: ResolveContext): Expected {
  if (
    element.closest(HIDDEN_CLOSE.selector) &&
    mediaMatches(atMedia(HIDDEN_CLOSE.condition), environment)
  ) {
    return HIDDEN_LABEL;
  }
  if (element.closest(SHARED_WEIGHT_SELECTOR)) return SHARED_WEIGHT_LABEL;
  // The demo tour's two-per-row actions and choice cards (NARROW_OVERRIDES).
  if (element.closest('.demo-large-actions') && environment.width <= 420) {
    return DEMO_PAIR_NARROW_LABEL;
  }
  if (element.closest('.subtab-pill') && !mediaMatches(atMedia(TAB_CONDITION), environment)) {
    return UNSHOWN;
  }
  for (const [name, { role }] of Object.entries(ROLE_CLASSES)) {
    if (element.closest(`.${name}`)) return ROLE_LABELS[role];
  }
  for (const [selector, { lineHeight }] of Object.entries(CTA_TEXT)) {
    if (element.closest(selector)) return { ...ROLE_LABELS.cta, 'line-height': lineHeight };
  }
  if (element.closest(COMPACT_MEMBER_SELECTOR) && compactApplies(environment)) {
    return COMPACT_LABEL;
  }
  return ROLE_LABELS.cta;
}

const matchesExpected = (resolved: Expected, expected: Expected): boolean =>
  RESOLVED_PROPERTIES.every(
    (property) => expected[property] === '*' || resolved[property] === expected[property],
  );

/** Every role member (inside `within`) and the HTML elements of its label. */
function roleLabels(markup: Document, within = ''): Element[] {
  const members = [
    ...ACTION_BUTTON_CLASSES.map((name) => `.${name}`),
    ...Object.keys(ROLE_CLASSES).map((name) => `.${name}`),
    ...Object.keys(CTA_TEXT),
    ...CONTAINER_BUTTONS.map((container) => `${container} button`),
  ]
    .map((selector) => `${within} ${selector}`.trim())
    .join(', ');
  const nested = Object.keys(NESTED_EXCEPTIONS)
    .map((name) => `.${name}`)
    .join(', ');
  // The member and every element inside it that holds label text itself.
  const holdsText = (element: Element): boolean =>
    [...element.childNodes].some(
      (node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    );
  return [...new Set(markup.querySelectorAll(members))].flatMap((member) => [
    member,
    ...[...member.querySelectorAll('*')].filter(
      (element) =>
        element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
        !element.closest(nested) &&
        holdsText(element),
    ),
  ]);
}

/** Mount a control that TypeScript renders at runtime, as it renders it. */
const mount = (markup: Document, selector: string, html: string): void => {
  const container = markup.querySelector(selector);
  expect(container, selector).not.toBeNull();
  container!.insertAdjacentHTML('beforeend', html);
};
const showTab = (id: string) => (markup: Document) => {
  markup.getElementById(id)!.classList.add('active');
};
const removeAttribute =
  (selector: string, name: string): PageState['apply'] =>
  (markup) => {
    const element = markup.querySelector(selector)!;
    const before = element.getAttribute(name);
    expect(before, `${selector}[${name}]`).not.toBeNull();
    element.removeAttribute(name);
    return () => element.setAttribute(name, before!);
  };

const ROLE_SLOTS: readonly RoleSlot[] = [
  {
    // Every role member in index.html and the runtime-mounted actions, with
    // every overlay open.
    name: 'every role member',
    prepare: (markup) => {
      mountRuntimeActions(markup);
      for (const overlay of markup.querySelectorAll('[id$="-overlay"]')) {
        overlay.classList.add('show', 'active');
      }
    },
    states: SHARED_PAGE_STATES,
    targets: (markup) => roleLabels(markup),
  },
  {
    // The play tab's Sync, Media and Stop Sharing labels.
    name: 'play actions',
    prepare: () => undefined,
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'sharing', apply: setAttribute('.play-action-buttons', 'data-sharing', 'true') },
      { name: 'hover locked', apply: setAttribute('.play-action-buttons', 'data-hover-locked') },
      { name: 'busy', apply: setAttribute('#btn-sync, #btn-media-source', 'aria-busy', 'true') },
      {
        name: 'disabled',
        apply: setAttribute('#btn-sync, #btn-media-source', 'aria-disabled', 'true'),
      },
      { name: 'YouTube', apply: toggleClass('body', 'mode-youtube') },
      { name: 'system audio', apply: toggleClass('body', 'mode-system-audio') },
      { name: 'spectrum', apply: toggleClass('body', 'viz-spectrum') },
    ],
    targets: (markup) => roleLabels(markup, '.play-action-buttons'),
  },
  {
    // The demo tour: the finish pair, the effect choices, the step indicator
    // and the role switch.
    name: 'demo',
    prepare: (markup) => {
      // As src/demo/mode.ts applies the demo.
      markup.body.classList.add('mode-demo', 'demo-mobile');
      markup.getElementById('demo-overlay')!.classList.add('active');
      for (const panel of markup.querySelectorAll('.demo-step-panel')) {
        panel.classList.add('active');
      }
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'demo chrome hiding', apply: toggleClass('body', 'demo-chrome-hiding') },
      {
        name: 'demo step active',
        apply: (markup) => {
          const steps = [...markup.querySelectorAll('.demo-step-nav button')].filter(
            (step) => !step.classList.contains('active'),
          );
          for (const step of steps) step.classList.add('active');
          return () => {
            for (const step of steps) step.classList.remove('active');
          };
        },
      },
      // As src/demo/mode.ts presses the current role and effect choices.
      {
        name: 'demo role chosen',
        apply: setAttribute(
          ".demo-role-segmented button[data-demo-role='0']",
          'aria-pressed',
          'true',
        ),
      },
      {
        name: 'demo effect chosen',
        apply: setAttribute('#demo-overlay .ch-opt.demo-choice', 'aria-pressed', 'true'),
      },
    ],
    targets: (markup) => roleLabels(markup, '#demo-overlay'),
  },
  {
    name: 'account pair',
    prepare: (markup) => {
      markup.getElementById('account-dialog-overlay')!.classList.add('show');
      markup.getElementById('account-dialog-actions')!.removeAttribute('hidden');
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'busy', apply: setAttribute('#account-dialog', 'aria-busy', 'true') },
    ],
    targets: (markup) => roleLabels(markup, '#account-dialog-actions'),
  },
  {
    name: 'invite link',
    prepare: (markup) => {
      showTab('tab-connect')(markup);
      mountRuntimeActions(markup);
    },
    states: [
      ...SHARED_PAGE_STATES,
      ...['recover', 'recovering', 'expired'].map((mode) => ({
        name: `${mode} mode`,
        apply: setAttribute('#qr-container .btn-copy-invite-link', 'data-mode', mode),
      })),
    ],
    targets: (markup) => roleLabels(markup, '#qr-container'),
  },
  {
    name: 'media sources',
    prepare: (markup) => {
      markup.getElementById('media-source-overlay')!.classList.add('active');
    },
    states: [
      ...SHARED_PAGE_STATES,
      // Phones cannot capture system audio.
      { name: 'system audio unsupported', apply: toggleClass('#btn-system-audio', 'unsupported') },
    ],
    targets: (markup) => roleLabels(markup, '#media-source-overlay'),
  },
  {
    name: 'selection toggle',
    prepare: (markup) => {
      showTab('tab-playlist')(markup);
      // As src/ui/playlist-removal.ts lays out the deletion mode.
      markup.querySelector('#tab-playlist > .tab-header')!.classList.add('is-removal-selecting');
      mountRuntimeActions(markup);
    },
    states: SHARED_PAGE_STATES,
    targets: (markup) => roleLabels(markup, '#tab-playlist .playlist-title-area'),
  },
  {
    name: 'setup actions',
    prepare: (markup) => {
      markup.getElementById('setup-overlay')!.classList.add('active');
      // As src/ui/setup.ts renders the room choice, and src/ui/setup-shared.ts
      // one action beside Back.
      mount(
        markup,
        '#setup-actions',
        '<button id="btn-setup-host" type="button" class="btn-ob-primary">Create a Room</button>' +
          '<button id="btn-setup-guest" type="button" class="btn-ob-secondary">Join a Room</button>',
      );
      const beside = markup.getElementById('setup-actions')!.cloneNode(false) as HTMLElement;
      beside.removeAttribute('id');
      beside.classList.add('horizontal-with-back');
      beside.innerHTML =
        '<button id="btn-setup-back" type="button" class="btn-ob-icon" aria-label="Go back">' +
        '<svg viewBox="0 0 24 24"></svg></button>' +
        '<button id="btn-setup-confirm" type="button" class="btn-ob-primary">Retry</button>';
      markup.getElementById('setup-actions')!.after(beside);
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'room choice', apply: toggleClass('#setup-actions', 'vertical') },
      // The host's Please wait while its room code loads: secondary and disabled.
      {
        name: 'waiting (secondary)',
        apply: (markup) => {
          const button = markup.getElementById('btn-setup-confirm')!;
          button.className = 'btn-ob-secondary';
          button.setAttribute('disabled', '');
          return () => {
            button.className = 'btn-ob-primary';
            button.removeAttribute('disabled');
          };
        },
      },
      // Joining..., with Back disabled too.
      { name: 'joining', apply: setAttribute('.horizontal-with-back > button', 'disabled') },
      // The iOS YouTube gate's Please wait on the filled pill.
      { name: 'gate busy', apply: setAttribute('#btn-setup-confirm', 'aria-busy', 'true') },
    ],
    targets: (markup) => roleLabels(markup, '#setup-overlay .ob-actions'),
  },
  {
    name: 'YouTube link actions',
    prepare: (markup) => {
      markup.getElementById('youtube-url-overlay')!.classList.add('active');
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'link entered', apply: removeAttribute('#youtube-play-btn', 'disabled') },
    ],
    targets: (markup) => roleLabels(markup, '#youtube-url-overlay'),
  },
];

class FirstFailure extends Error {}

/**
 * Every resolution of the role slots that is not its role, or only the first
 * one (a mutation check needs no more).
 */
function roleFailures(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
  options: { firstOnly?: boolean; slots?: readonly string[] } = {},
): {
  failures: string[];
  resolutions: Record<string, number>;
  resolved: Set<string>;
} {
  const failures: string[] = [];
  const resolutions: Record<string, number> = {};
  const resolved = new Set<string>();
  try {
    for (const slot of ROLE_SLOTS) {
      if (options.slots && !options.slots.includes(slot.name)) continue;
      resolutions[slot.name] = resolveAcross(
        stylesheets,
        slot.prepare,
        slot.states,
        slot.targets,
        (value, context) => {
          const expected = expectedRole(context.element, context);
          if (expected !== UNSHOWN) resolved.add(JSON.stringify(value));
          if (matchesExpected(value, expected)) return;
          failures.push(`${slot.name} ${context.label}: ${JSON.stringify(value)}`);
          if (options.firstOnly) throw new FirstFailure();
        },
      );
    }
  } catch (error) {
    if (!(error instanceof FirstFailure)) throw error;
  }
  return { failures, resolutions, resolved };
}

describe('action button label contract', () => {
  it('defines the button label role tokens and the danger foreground once on the root', () => {
    for (const [token, value] of Object.entries(LABEL_VALUES)) {
      expect(ruleValues(appCss, ':root', token), token).toEqual([value]);
    }
    // Every other declaration of a label token is the compact role's swap.
    const owners: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls(/^--button-label-/u, (declaration) => {
        const rule = declaration.parent as Rule;
        if (rule.selector === ':root') return;
        owners.push(
          `${path} ${conditionOf(declaration)} ${rule.selector} ` +
            `{ ${declaration.prop}: ${declaration.value} }`,
        );
      });
    }
    expect(owners).toEqual([
      `css/style.css ${COMPACT_CONDITION} .${COMPACT_CLASS} ` +
        `{ --button-label-size: ${ROLE_SIZE_TOKENS.chip} }`,
    ]);
    expect(ruleValues(appCss, ':root', '--danger-foreground')).toEqual(['#ff3b30']);
    // Owner decision (2026-10-27, evening): the default light theme keeps the
    // red of 9.0.18 instead of a darker one; only high contrast darkens it.
    expect(ruleValues(appCss, "html[data-theme='light']", '--danger-foreground')).toEqual([]);
  });

  it('lets role member rules set label typography only through the role tokens', () => {
    const violations: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!FONT_PROPERTIES.includes(declaration.prop)) return;
        const rule = declaration.parent;
        if (rule?.type !== 'rule') return;
        for (const selector of (rule as unknown as { selectors: string[] }).selectors) {
          if (selector.includes('::') || isNestedException(selector)) continue;
          const styled = styledButton(selector);
          if (!styled || !labelViolation(declaration, styled)) continue;
          if (isNarrowOverride(declaration, selector)) continue;
          violations.push(
            `${where(declaration, path)} ${selector.replace(/\s+/gu, ' ')} { ${declaration.prop}: ${declaration.value} }`,
          );
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("reads each role's label tokens from every member's own rule", () => {
    for (const name of ACTION_BUTTON_CLASSES) {
      for (const [property, token] of Object.entries(LABEL_TOKENS)) {
        expect(ruleValues(appCss, `.${name}`, property), `.${name} ${property}`).toEqual([token]);
      }
    }
    // A selection group's chosen state reads the selected weight, in every
    // sheet and condition that styles it.
    const selectedWeights = (list: string): string[] =>
      splitTopLevel(list).flatMap((selector) =>
        sheets.flatMap(({ root }) => {
          const values: string[] = [];
          root.walkRules((rule) => {
            if (
              !rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim()).includes(selector)
            ) {
              return;
            }
            rule.each((node) => {
              if (node.type === 'decl' && node.prop === 'font-weight') values.push(node.value);
            });
          });
          return values;
        }),
      );
    for (const { selected } of [
      ...Object.values(ROLE_CLASSES),
      ...Object.values(SHARED_WEIGHT_CONTAINERS),
    ]) {
      expect(selectedWeights(selected), selected).toEqual(
        splitTopLevel(selected).map(() => SELECTION_WEIGHTS.selected),
      );
    }
    // Choice chips read the chip size and the unselected weight, and share
    // the rest.
    expect(ruleValues(appCss, '.ch-opt', 'font-size')).toEqual([ROLE_SIZE_TOKENS.chip]);
    expect(ruleValues(appCss, '.ch-opt', 'font-weight')).toEqual([SELECTION_WEIGHTS.unselected]);
    for (const property of ['line-height', 'letter-spacing']) {
      expect(ruleValues(appCss, '.ch-opt', property), `.ch-opt ${property}`).toEqual([
        LABEL_TOKENS[property],
      ]);
    }
    // The desktop settings tabs read the tab size and the unselected weight.
    const tabRules: string[] = [];
    for (const { root } of sheets) {
      root.walkRules('.subtab-pill', (rule) => {
        rule.walkDecls((declaration) => {
          if (FONT_PROPERTIES.includes(declaration.prop)) {
            tabRules.push(`${declaration.prop}: ${declaration.value}`);
          }
        });
      });
    }
    expect(tabRules).toEqual([
      `font-size: ${ROLE_SIZE_TOKENS.tab}`,
      `font-weight: ${SELECTION_WEIGHTS.unselected}`,
    ]);
    // The chat preview text reads the CTA tokens and keeps its line box.
    for (const [selector, { lineHeight }] of Object.entries(CTA_TEXT)) {
      expect(ruleValues(appCss, selector, 'font-size'), selector).toEqual([ROLE_SIZE_TOKENS.cta]);
      expect(ruleValues(appCss, selector, 'font-weight'), selector).toEqual([
        LABEL_TOKENS['font-weight'],
      ]);
      expect(ruleValues(appCss, selector, 'letter-spacing'), selector).toEqual([
        LABEL_TOKENS['letter-spacing'],
      ]);
      expect(ruleValues(appCss, selector, 'line-height'), selector).toEqual([lineHeight]);
    }
    // The startup failure Retry reads every CTA token after its font reset.
    for (const container of Object.keys(CTA_CONTAINERS)) {
      const selector = `${container} button`;
      for (const [property, token] of Object.entries(LABEL_TOKENS)) {
        expect(ruleValues(appCss, selector, property), `${selector} ${property}`).toEqual([token]);
      }
      const font: string[] = [];
      appCss.walkRules((rule) => {
        if (!rule.selectors.map((entry) => entry.trim()).includes(selector)) return;
        rule.walkDecls((declaration) => {
          if (FONT_PROPERTIES.includes(declaration.prop)) font.push(declaration.prop);
        });
      });
      // After any font shorthand, so the shorthand does not reset them.
      const shorthand = font.lastIndexOf('font');
      for (const property of Object.keys(LABEL_TOKENS)) {
        expect(font.indexOf(property), `${selector} ${property}`).toBeGreaterThan(shorthand);
      }
    }
    // The demo tour controls read the unselected weight and share the
    // tracking.
    for (const container of Object.keys(SHARED_WEIGHT_CONTAINERS)) {
      const selector = `${container} button`;
      expect(ruleValues(appCss, selector, 'font-weight'), selector).toEqual([
        SELECTION_WEIGHTS.unselected,
      ]);
      expect(ruleValues(appCss, selector, 'letter-spacing'), selector).toEqual([
        LABEL_TOKENS['letter-spacing'],
      ]);
    }
  });

  it('gives the compact role to its named members only, under one shared condition', () => {
    // One rule swaps the size token on the members' buttons, in the base
    // layer beside the tokens, and nothing else styles the class.
    const compactRules: string[] = [];
    for (const { path, root } of sheets) {
      root.walkRules((rule) => {
        if (!rule.selectors.some((selector) => hasClass(selector, COMPACT_CLASS))) return;
        compactRules.push(
          `${path} ${layerOf(rule)} ${conditionOf(rule)} ${rule.selector} ` +
            rule.nodes.map((node) => node.toString()).join('; '),
        );
      });
    }
    expect(compactRules).toEqual([
      `css/style.css base ${COMPACT_CONDITION} .${COMPACT_CLASS} ` +
        `--button-label-size: ${ROLE_SIZE_TOKENS.chip}`,
    ]);
    // The class sits on the named members and nowhere else: index.html and
    // the TypeScript templates.
    const markup = appMarkup();
    expect(
      [...markup.querySelectorAll(`.${COMPACT_CLASS}`)].map((element) => `#${element.id}`).sort(),
    ).toEqual(Object.keys(COMPACT_MEMBERS).sort());
    expect(templateButtons().filter((button) => button.classes.includes(COMPACT_CLASS))).toEqual(
      [],
    );
    for (const [member, reason] of Object.entries(COMPACT_MEMBERS)) {
      const element = markup.querySelector(member);
      expect(element, member).not.toBeNull();
      expect(
        element!.matches(ACTION_BUTTON_CLASSES.map((name) => `.${name}`).join(', ')),
        `${member} is an action button`,
      ).toBe(true);
      expect(reason.length, member).toBeGreaterThan(20);
    }
    // Every narrow override names its reason too.
    for (const override of NARROW_OVERRIDES) {
      expect(override.reason.length, override.selector).toBeGreaterThan(20);
    }
  });

  it('gives the play actions and media sources no label typography of their own', () => {
    // The 9.0.18 600 / -0.3px of Sync, Media, Stop Sharing and the media
    // source options is gone (owner decision 2026-10-28): the labels inherit
    // the CTA role from .file-select-btn, and the media sources take the
    // compact role through their markup class.
    const owners: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!FONT_PROPERTIES.includes(declaration.prop)) return;
        const rule = declaration.parent as unknown as { type: string; selectors?: string[] };
        if (rule.type !== 'rule') return;
        for (const selector of rule.selectors ?? []) {
          if (isNestedException(selector)) continue;
          if (
            !/#btn-(?:sync|media-source|local-file|youtube-source|system-audio)(?![\w-])|play-action-label|media-source-label-text/u.test(
              selector,
            )
          ) {
            continue;
          }
          if (isNarrowOverride(declaration as Declaration, selector)) continue;
          owners.push(`${path} ${selector.replace(/\s+/gu, ' ').trim()} ${declaration.prop}`);
        }
      });
    }
    expect(owners).toEqual([]);
    for (const property of Object.keys(LABEL_TOKENS)) {
      expect(ruleValues(appCss, '.file-select-btn span', property), property).toEqual([]);
    }
  });

  it('turns font hinting off for the media source options and nothing else', () => {
    // Linux Chromium at device scale 1 hints Pretendard: FreeType snaps each
    // advance to a whole pixel, so the compact 14px lowercase took the 15px
    // advance and the BETA badge grew 2.5px, and the media source labels
    // wrapped more than 9.0.18 in the PR #510 CI (Critical browser gate,
    // adaptive-actions at 340, 360, 375 and 421px). text-rendering:
    // geometricPrecision turns hinting off there. The whole option takes it,
    // so the BETA badge inside is unhinted too. The play tab Sync and Media
    // are .file-select-btn as well and keep the default rendering.
    const OPTION_SELECTOR = '#media-source-overlay .file-select-btn';
    const markup = appMarkup();
    const options = [...markup.querySelectorAll(OPTION_SELECTOR)];
    expect(options.map((element) => `#${element.id}`)).toEqual([
      '#btn-local-file',
      '#btn-youtube-source',
      '#btn-system-audio',
    ]);
    expect(markup.querySelector(`${OPTION_SELECTOR} .media-source-beta-badge`)).not.toBeNull();
    const playTab = ['btn-sync', 'btn-media-source'].map((id) => markup.getElementById(id)!);
    for (const button of playTab) {
      expect(button.classList.contains('file-select-btn'), button.id).toBe(true);
      expect(button.matches(OPTION_SELECTOR), button.id).toBe(false);
    }
    // Every text-rendering declaration that can reach these buttons or what is
    // inside them, by name or by matching the markup. Page and user states
    // are set aside (attribute conditions such as the theme or the hover
    // gate, language and direction, hover, press and focus), so a rule that
    // applies only in one of them counts too.
    const named =
      /file-select-btn|#btn-(?:sync|media-source|local-file|youtube-source|system-audio)(?![\w-])|media-source|play-action|feature-badge/u;
    const reaches = (selector: string): boolean => {
      if (named.test(selector)) return true;
      const plain = selector
        .replace(/\[[^\]]*\]/gu, '')
        .replace(/:(?:lang|dir)\([^)]*\)/gu, '')
        .replace(/:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])/gu, '');
      try {
        return [...options, ...playTab].some(
          (button) => button.matches(plain) || button.querySelector(plain) !== null,
        );
      } catch {
        return true;
      }
    };
    const found: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls('text-rendering', (declaration) => {
        const rule = declaration.parent as unknown as Rule;
        if (rule.type !== 'rule') return;
        for (const selector of rule.selectors) {
          if (!reaches(selector)) continue;
          found.push(
            `${path} ${layerOf(rule)} ${conditionOf(rule)} ` +
              `${selector.replace(/\s+/gu, ' ').trim()} ${declaration.toString()}`,
          );
        }
      });
    }
    expect(found).toEqual([
      `css/style.css base null ${OPTION_SELECTOR} text-rendering: geometricPrecision`,
    ]);
  });

  it('computes cascade order, specificity and media conditions like the browser', () => {
    expect(specificity('#btn-sync span')).toEqual([1, 0, 1]);
    expect(specificity(':where(html[data-hover-pointer]) .accent-action-btn:hover')).toEqual([
      0, 2, 0,
    ]);
    expect(
      specificity(
        "html[dir='rtl'] :where(h1, h2, h3, h4, p, button, label, span, input, textarea)",
      ),
    ).toEqual([0, 1, 1]);
    expect(specificity('.play-actions-row :is(.play-action-label, #btn-sync) > *')).toEqual([
      1, 1, 0,
    ]);
    expect(specificity('li:not(.a):nth-child(2 of .b, #c)')).toEqual([1, 2, 1]);
    expect(specificity('body.mode-demo .demo-finish-content .demo-large-actions *')).toEqual([
      0, 3, 1,
    ]);
    const phone: MediaEnvironment = {
      width: 320,
      height: 400,
      reducedMotion: false,
      forcedColors: false,
      contrastMore: false,
      standalone: false,
      touchCallout: false,
    };
    expect(mediaMatches('(max-width: 420px)', phone)).toBe(true);
    expect(mediaMatches('(max-width: 319px)', phone)).toBe(false);
    expect(mediaMatches('not all and (min-height: 420px)', phone)).toBe(true);
    expect(mediaMatches('(min-width: 720px), (max-height: 719px)', phone)).toBe(true);
    expect(mediaMatches('(max-width: 719px) and (orientation: portrait)', phone)).toBe(true);
    expect(mediaMatches('(forced-colors: active)', { ...phone, forcedColors: true })).toBe(true);
    expect(() => mediaMatches('(hover: hover)', phone)).toThrow(/cannot evaluate/u);

    // A later layer beats any specificity in an earlier one; important
    // declarations reverse the layer order.
    const candidate = (layer: number, ids: number, important = false, order = 0) =>
      ({ layer, important, order, specificity: [ids, 0, 0] }) as unknown as CascadeCandidate;
    expect(cascadeOrder(candidate(4, 0), candidate(1, 3))).toBeGreaterThan(0);
    expect(cascadeOrder(candidate(1, 0, true), candidate(4, 3, true))).toBeGreaterThan(0);
    expect(cascadeOrder(candidate(1, 0, true), candidate(4, 3))).toBeGreaterThan(0);
    expect(cascadeOrder(candidate(2, 1, false, 5), candidate(2, 1, false, 9))).toBeLessThan(0);
  });

  it('resolves every action label to a named role through the whole cascade', () => {
    // Every direction, theme and page state, in each derived viewport and
    // media preference: the value that wins the cascade on every role member
    // and its label is its role (the compact members and the demo finish
    // pair take their smaller role size only under their condition).
    const { failures, resolutions, resolved } = roleFailures(sheets);
    for (const slot of ROLE_SLOTS) {
      const markup = appMarkup();
      slot.prepare(markup);
      expect(resolutions[slot.name], slot.name).toBe(
        2 * 2 * slot.states.length * RESOLVER_ENVIRONMENTS.length * slot.targets(markup).length,
      );
    }
    expect(failures.slice(0, 20), `${failures.length} resolutions differ`).toEqual([]);
    // Only the role typographies occur: CTA, chip (also the compact members),
    // the demo pair's tab size, the tab role, the chat preview's line box, the
    // demo tour controls' own sizes and the hidden two-column Close.
    const values = (property: ResolvedProperty): string[] =>
      [...new Set([...resolved].map((entry) => (JSON.parse(entry) as Expected)[property]))].sort();
    // Actions resolve to the label weight; the selection groups' chosen and
    // other items to the selected and unselected weights.
    expect(values('font-weight')).toEqual(['500', '600', '700']);
    expect(values('letter-spacing')).toEqual(['normal']);
    expect(values('font-variation-settings')).toEqual(['normal']);
    // The two demo tour controls keep their own sizes (clamped on the
    // desktop tour, 12px segments on phones).
    expect(values('font-size')).toEqual([
      '0',
      '12px',
      '13px',
      '14px',
      '15px',
      'clamp(12.5px, 1vw, 14.5px)',
      'clamp(13px, 1vw, 15px)',
    ]);
  }, 240_000);

  it('samples both sides of every media boundary in both orientations', () => {
    // A range between two samples cannot hide: each width and height that a
    // media query in the four sheets names has a sampled viewport on each
    // side of it, portrait and landscape, before reduction to distinct
    // condition sets.
    const boundaries = mediaBoundaries(sheets);
    expect(boundaries.width).toEqual(expect.arrayContaining([420, 719, 720, 1279, 1280]));
    expect(boundaries.height).toEqual(expect.arrayContaining([300, 480, 719, 720]));
    const viewports = resolverViewports(sheets);
    const sampled = (axis: 0 | 1, value: number, orientation: 'portrait' | 'landscape'): boolean =>
      viewports.some(
        (viewport) =>
          viewport[axis] === value && viewport[1] >= viewport[0] === (orientation === 'portrait'),
      );
    const gaps: string[] = [];
    for (const [axis, values] of [
      [0, boundaries.width],
      [1, boundaries.height],
    ] as const) {
      for (const value of values) {
        for (const side of [value - 1, value, value + 1]) {
          for (const orientation of ['portrait', 'landscape'] as const) {
            if (!sampled(axis, side, orientation)) {
              gaps.push(`${axis === 0 ? 'width' : 'height'} ${side} ${orientation}`);
            }
          }
        }
      }
    }
    expect(gaps).toEqual([]);
    // Every distinct set of the conditions that can change label typography
    // keeps one environment, and every media preference such a condition
    // reads is still sampled.
    const conditions = labelConditions(sheets);
    const condition = (environment: MediaEnvironment): string =>
      conditions.map((atRule) => (conditionApplies(atRule, environment) ? '1' : '0')).join('');
    expect(new Set(RESOLVER_ENVIRONMENTS.map(condition)).size).toBe(RESOLVER_ENVIRONMENTS.length);
    const features: Record<(typeof MEDIA_PREFERENCES)[number], string> = {
      reducedMotion: 'prefers-reduced-motion',
      forcedColors: 'forced-colors',
      contrastMore: 'prefers-contrast',
      standalone: 'display-mode',
      touchCallout: '-webkit-touch-callout',
    };
    for (const flag of MEDIA_PREFERENCES) {
      if (!conditions.some((atRule) => atRule.params.includes(features[flag]))) continue;
      expect(
        RESOLVER_ENVIRONMENTS.some((environment) => environment[flag]),
        flag,
      ).toBe(true);
    }
    expect(conditions.length).toBeGreaterThan(5);
    // At least the phone, the phone layout, the two-column and the desktop
    // label bands.
    expect(RESOLVER_ENVIRONMENTS.length).toBeGreaterThanOrEqual(4);
  });

  it('catches a later-layer, between-sample or variation rule that turns a role away', () => {
    // Rule-level checks accept token reads (they are not violations); only
    // the resolved cascade shows a label off its role. The derived viewports
    // catch ranges between two samples and orientation-only ranges.
    const mutations: Record<string, { slots: string[]; css: string }> = {
      'the 700 weight back in a later layer': {
        slots: ['every role member', 'play actions'],
        css: `
          @layer components {
            .file-select-btn span {
              font-weight: 700;
            }
          }`,
      },
      'the play actions tracking back on 375px phones': {
        slots: ['play actions'],
        css: `
          @layer states {
            @media (min-width: 361px) and (max-width: 389px) {
              .play-actions-row span {
                letter-spacing: -0.3px;
              }
            }
          }`,
      },
      'the media sources tracking back in a later layer': {
        slots: ['media sources'],
        css: `
          @layer components {
            .setup-slot-list .file-select-btn span {
              letter-spacing: -0.3px;
            }
          }`,
      },
      'the compact role past its condition': {
        slots: ['media sources', 'account pair'],
        css: `
          @layer base {
            @media (min-width: 720px) and (max-width: 1279px) {
              .${COMPACT_CLASS} {
                --button-label-size: ${ROLE_SIZE_TOKENS.chip};
              }
            }
          }`,
      },
      'a compact member back at the CTA size on landscape phones': {
        slots: ['account pair'],
        css: `
          @layer responsive {
            @media (orientation: landscape) {
              #btn-account-delete {
                --button-label-size: 15px;
              }
            }
          }`,
      },
      'the demo pair back at the CTA size between two samples': {
        slots: ['demo'],
        css: `
          @layer states {
            @media (min-width: 361px) and (max-width: 389px) {
              .demo-large-actions span {
                font-size: var(--button-label-size);
              }
            }
          }`,
      },
      'a chip at the CTA size on landscape phones': {
        slots: ['every role member'],
        css: `
          @layer states {
            @media (max-width: 719px) and (orientation: landscape) {
              .ch-opt span {
                font-size: var(--button-label-size);
              }
            }
          }`,
      },
      'the setup action beside Back at 700 in a later layer': {
        slots: ['setup actions'],
        css: `
          @layer responsive {
            .onboarding-overlay .ob-actions.horizontal-with-back > button {
              font-weight: 700;
            }
          }`,
      },
      'the invite link at 700 while recovering': {
        slots: ['invite link'],
        css: `
          @layer states {
            .btn-copy-invite-link[data-mode='recovering'] span {
              font-weight: 700;
            }
          }`,
      },
      'the selection toggle at 700 through the weight axis': {
        slots: ['selection toggle'],
        css: `
          @layer states {
            .tab-header.is-removal-selecting .playlist-selection-toggle {
              font-variation-settings: 'wght' 700;
            }
          }`,
      },
      'the YouTube link actions at 700 at 421px': {
        slots: ['YouTube link actions'],
        css: `
          @layer states {
            @media (min-width: 421px) and (max-width: 421px) {
              .setup-card-mt-8-row > button {
                font-weight: 700;
              }
            }
          }`,
      },
      // Before the weight roles the tabs shared the label weight; now one
      // weight on both states would flatten the selection group.
      'the desktop settings tabs back at one weight in a later layer': {
        slots: ['every role member'],
        css: `
          @layer states {
            .subtab-pill {
              font-weight: 600;
            }
          }`,
      },
      'a selected chip at the unselected weight': {
        slots: ['every role member'],
        css: `
          @layer states {
            .ch-opt.active {
              font-weight: var(--font-weight-unselected);
            }
          }`,
      },
      'every demo role at the selected weight': {
        slots: ['demo'],
        css: `
          @layer components {
            .demo-role-segmented button span {
              font-weight: var(--font-weight-selected);
            }
          }`,
      },
      'the chat preview text at 700': {
        slots: ['every role member'],
        css: `
          @layer components {
            .chat-preview-btn span {
              font-weight: 700;
            }
          }`,
      },
    };
    // Each mutation turns every slot it names away from its role somewhere.
    for (const [name, { slots, css }] of Object.entries(mutations)) {
      const mutated = [...sheets, { path: 'mutation.css', root: parseCss(css) }];
      for (const slot of slots) {
        expect(
          ROLE_SLOTS.map((entry) => entry.name),
          name,
        ).toContain(slot);
        expect(
          roleFailures(mutated, { firstOnly: true, slots: [slot] }).failures,
          `${name}: ${slot}`,
        ).toHaveLength(1);
      }
    }
    // A label-typography violation at rule level too.
    expect(
      labelViolation(
        (parseCss('.file-select-btn { font-variation-settings: "wght" 700 }').first as Rule)
          .first as Declaration,
        { name: 'file-select-btn', role: 'cta' },
      ),
    ).toBe(true);
    expect(FONT_PROPERTIES).toContain('font-variation-settings');
  }, 120_000);

  it('resolves only the role tokens on every action button in the app markup', () => {
    // Selectors that never name the button (an ID, a container, a descendant
    // span) are caught here: every font declaration that any app rule applies
    // to an action button or its label text, in any layer or condition, in
    // both directions and both themes, must be a role token read.
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
                if (!labelViolation(declaration, { name: selector, role: 'cta' })) continue;
                if (isNarrowOverride(declaration, selector)) continue;
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
      if (CONTAINER_BUTTONS.some((container) => button.closest(container))) continue;
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
      ...Object.keys(ROLE_CLASSES),
      ...Object.keys(NOT_ROLE_BUTTONS),
    ].filter((name) => !used.has(name));
    expect(stale).toEqual([]);
    for (const container of CONTAINER_BUTTONS) {
      expect(markup.querySelector(`${container} button`), container).not.toBeNull();
    }
    for (const selector of Object.keys(CTA_TEXT)) {
      expect(markup.querySelector(`button ${selector}`), selector).not.toBeNull();
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
    for (const allowed of NARROW_OVERRIDES) {
      const declarations: string[] = [];
      appCss.walkRules((rule) => {
        if (conditionOf(rule) !== allowed.condition) return;
        if (!rule.selectors.map((entry) => entry.trim()).includes(allowed.selector)) return;
        rule.walkDecls((declaration) => {
          declarations.push(`${declaration.prop}: ${declaration.value}`);
        });
      });
      expect(declarations, allowed.selector).toContain(allowed.declaration);
    }
    const resets = new Map<string, string[]>();
    for (const { root } of sheets) {
      root.walkRules((rule) => {
        for (const selector of rule.selectors) {
          const key = selector.replace(/\s+/gu, ' ').trim();
          if (!(key in GLOBAL_RESETS)) continue;
          rule.walkDecls((declaration) => {
            resets.set(key, [
              ...(resets.get(key) ?? []),
              `${declaration.prop}: ${declaration.value}`,
            ]);
          });
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

  it('gives a leave confirmation the account deletion danger look on its primary action', () => {
    // Owner decision (2026-10-29, items 9 and 12): the primary action of a
    // leave confirmation (showDialog's tone 'danger') takes account
    // deletion's colors, the danger label on the dialog danger tint, darker on
    // hover and on press. Only the colors change: size, label role and the
    // press scale stay the primary action's, in its layer, without !important.
    expect(appMarkup().getElementById('btn-dialog-ok')?.className).toBe('dialog-primary');
    const danger = '.dialog-primary.dialog-danger';
    const hover = `:where(html[data-hover-pointer]) ${danger}:hover`;
    const press = `${danger}:active`;
    expect(ruleValues(appCss, danger, 'color')).toEqual(['var(--danger-foreground)']);
    expect(ruleValues(appCss, danger, 'background')).toEqual(['var(--control-danger-dialog)']);
    expect(ruleValues(appCss, hover, 'background')).toEqual(['var(--control-danger-dialog-hover)']);
    expect(ruleValues(appCss, press, 'background')).toEqual(['var(--control-danger-dialog-press)']);
    const placed: string[] = [];
    const lines: Record<string, number> = {};
    for (const { path, root } of sheets) {
      root.walkRules((rule) => {
        const selectors = rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim());
        const named = ['.dialog-primary', danger, hover, press].filter((selector) =>
          selectors.includes(selector),
        );
        if (named.length === 0 || conditionOf(rule) !== null) return;
        for (const selector of named) {
          placed.push(`${selector} ${path} ${layerOf(rule)}`);
          lines[selector] = rule.source?.start?.line ?? 0;
        }
        rule.walkDecls((declaration) => {
          expect(
            declaration.important === true,
            `${selectors.join(', ')} ${declaration.prop}`,
          ).toBe(false);
        });
      });
    }
    expect(placed.sort()).toEqual(
      ['.dialog-primary', danger, hover, press]
        .map((selector) => `${selector} css/style.css base`)
        .sort(),
    );
    // The press rule has the hover rule's specificity and comes after it, so a
    // hovered press shows the press tint, as account deletion's does.
    expect(lines[press]).toBeGreaterThan(lines[hover]!);
    expect(lines[hover]).toBeGreaterThan(lines['.dialog-primary']!);
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
    appCss.walkDecls('--danger-foreground', (declaration) => {
      owners.push(where(declaration, 'css/style.css'));
    });
    expect(owners).toHaveLength(4);

    // Owner decision (2026-10-27, evening): the default dark and light palettes
    // keep the reds and destructive tints of 9.0.18 rather than chase contrast;
    // the high-contrast option is there for that. So the default palettes are
    // pinned to those values, and only the high-contrast palettes promise
    // 4.5:1 for every destructive label (forced colors hands label and surface
    // to the system palette).
    const TINTS = [
      '--control-danger',
      '--control-danger-hover',
      '--control-danger-pill',
      '--control-danger-pill-hover',
      '--control-danger-pill-press',
      '--control-danger-dialog',
      '--control-danger-dialog-hover',
      '--control-danger-dialog-press',
    ] as const;
    const cascade: Record<string, string[]> = {
      dark: [':root'],
      light: [':root', "html[data-theme='light']"],
      'dark more': [':root', "html[data-contrast='more']"],
      'light more': [
        ':root',
        "html[data-theme='light']",
        "html[data-contrast='more']",
        "html[data-theme='light'][data-contrast='more']",
      ],
    };
    // The value a palette computes for a token on the root, following a
    // var() reference through the same cascade.
    const resolved = (selectors: string[], token: string): string => {
      for (const selector of [...selectors].reverse()) {
        const [value] = ruleValues(appCss, selector, token);
        if (value === undefined) continue;
        const reference = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
        return reference ? resolved(selectors, reference) : value;
      }
      throw new Error(`${token} is not defined for ${selectors.join(' / ')}`);
    };
    // Owner decision (2026-10-27, late evening): account deletion rests, hovers
    // and presses on the tints of 9.0.18 in both default palettes, the same
    // rgba(239, 68, 68, …) values its one-off button had.
    const accountDeletion = {
      '--control-danger-dialog': 'rgba(239, 68, 68, 0.1)',
      '--control-danger-dialog-hover': 'rgba(239, 68, 68, 0.16)',
      '--control-danger-dialog-press': 'rgba(239, 68, 68, 0.2)',
    };
    const decided: Record<'dark' | 'light', Record<string, string>> = {
      dark: {
        '--danger-foreground': '#ff3b30',
        '--control-danger': 'rgba(255, 59, 48, 0.09)',
        '--control-danger-hover': 'rgba(255, 59, 48, 0.13)',
        '--control-danger-pill': 'rgba(255, 59, 48, 0.08)',
        '--control-danger-pill-hover': 'rgba(255, 59, 48, 0.12)',
        '--control-danger-pill-press': 'rgba(255, 59, 48, 0.18)',
        ...accountDeletion,
      },
      light: {
        '--danger-foreground': '#ff3b30',
        '--control-danger': 'rgba(255, 59, 48, 0.075)',
        '--control-danger-hover': 'rgba(255, 59, 48, 0.11)',
        '--control-danger-pill': 'rgba(255, 59, 48, 0.08)',
        '--control-danger-pill-hover': 'rgba(255, 59, 48, 0.12)',
        '--control-danger-pill-press': 'rgba(255, 59, 48, 0.18)',
        ...accountDeletion,
      },
    };
    for (const [palette, tokens] of Object.entries(decided)) {
      for (const [token, value] of Object.entries(tokens)) {
        expect(resolved(cascade[palette]!, token), `${palette} ${token}`).toBe(value);
      }
    }

    // In high contrast every destructive label keeps 4.5:1 on each surface it
    // sits on: the bare canvas (connect tab, play tab, setup) and panel
    // (dialogs, account, the demo finish row), and every destructive tint
    // over either one, at rest, on hover and on press.
    const highContrast = [
      { name: 'dark more', canvas: '#000000', panel: '#0a0a0a' },
      { name: 'light more', canvas: '#f2f2f2', panel: '#ffffff' },
    ];
    const measured: string[] = [];
    for (const palette of highContrast) {
      const selectors = cascade[palette.name]!;
      const label = resolved(selectors, '--danger-foreground');
      for (const tint of [
        'rgba(0, 0, 0, 0)',
        ...TINTS.map((token) => resolved(selectors, token)),
      ]) {
        for (const surface of [palette.canvas, palette.panel]) {
          const ratio = contrast(label, tint, surface);
          measured.push(`${palette.name} ${tint} on ${surface}: ${ratio.toFixed(2)}`);
          expect(
            ratio,
            `${palette.name} ${label} on ${tint} over ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(measured).toHaveLength(36);
    // High contrast keeps account deletion on the palette's resting tint at
    // rest, on hover and on press, as tuned before the 9.0.18 tints came back.
    for (const palette of highContrast) {
      const selectors = cascade[palette.name]!;
      for (const token of TINTS.slice(5)) {
        expect(resolved(selectors, token), `${palette.name} ${token}`).toBe(
          resolved(selectors, '--control-danger'),
        );
      }
    }
    // The OS preference layer repeats the manual high-contrast tints.
    for (const tint of ['--control-danger', '--control-danger-hover']) {
      expect(
        ruleValues(appCss, lightPrefersContrast, tint, '@media (prefers-contrast: more)'),
        tint,
      ).toEqual(ruleValues(appCss, lightContrast, tint));
    }
    for (const tint of TINTS.slice(2)) {
      expect(
        ruleValues(
          appCss,
          "html:not([data-contrast='normal'])",
          tint,
          '@media (prefers-contrast: more)',
        ),
        tint,
      ).toEqual(ruleValues(appCss, "html[data-contrast='more']", tint));
    }

    // Account deletion is the shared secondary action with a color-only
    // danger modifier: the label reads the role and the shared label tokens,
    // and the surface darkens on hover and press as in 9.0.18.
    const remove = appMarkup().getElementById('btn-account-delete')!;
    // Its label role class aside (COMPACT_MEMBERS).
    expect([...remove.classList].filter((name) => name !== COMPACT_CLASS)).toEqual([
      'dialog-secondary',
      'dialog-danger',
    ]);
    const danger = '.dialog-secondary.dialog-danger';
    const dangerHover = `:where(html[data-hover-pointer]) ${danger}:hover`;
    const dangerPress = `${danger}:active`;
    expect(ruleValues(appCss, danger, 'color')).toEqual(['var(--danger-foreground)']);
    expect(ruleValues(appCss, danger, 'background')).toEqual(['var(--control-danger-dialog)']);
    expect(ruleValues(appCss, danger, 'border-color')).toEqual(['transparent']);
    expect(ruleValues(appCss, dangerHover, 'background')).toEqual([
      'var(--control-danger-dialog-hover)',
    ]);
    expect(ruleValues(appCss, dangerPress, 'background')).toEqual([
      'var(--control-danger-dialog-press)',
    ]);
    // The surface eases between them as the 9.0.18 button did.
    expect(
      ruleValues(appCss, danger, 'transition').map((value) => value.replace(/\s+/gu, ' ')),
    ).toEqual(['background-color 0.18s ease, transform 0.2s, box-shadow 0.2s']);
    const modifierProperties = new Set<string>();
    appCss.walkRules((rule) => {
      if (!rule.selectors.some((selector) => hasClass(selector, 'dialog-danger'))) return;
      rule.walkDecls((declaration) => {
        modifierProperties.add(declaration.prop);
      });
    });
    expect([...modifierProperties].sort()).toEqual([
      'background',
      'border-color',
      'color',
      'transition',
    ]);

    // Leave session and stop sharing read the same role.
    expect(ruleValues(appCss, '.leave-session-btn', 'color')).toEqual(['var(--danger-foreground)']);
    expect(ruleValues(appCss, '.leave-session-btn svg', 'fill')).toEqual([
      'var(--danger-foreground)',
    ]);
    expect(ruleValues(playCss, '.play-actions-row', '--play-action-stop-foreground')).toEqual([
      'var(--danger-foreground)',
    ]);

    // Their surfaces look as in 9.0.18. Leave session and stop sharing read the
    // pill tints at rest and on hover; leave session presses deeper, while a
    // press on stop sharing shows its hover tint.
    expect(ruleValues(appCss, '.leave-session-btn', 'background')).toEqual([
      'var(--control-danger-pill)',
    ]);
    expect(
      ruleValues(appCss, ':where(html[data-hover-pointer]) .leave-session-btn:hover', 'background'),
    ).toEqual(['var(--control-danger-pill-hover)']);
    expect(ruleValues(appCss, '.leave-session-btn:active', 'background')).toEqual([
      'var(--control-danger-pill-press)',
    ]);
    expect(ruleValues(playCss, '.play-actions-row', '--play-action-stop-surface')).toEqual([
      'var(--control-danger-pill)',
    ]);
    expect(ruleValues(playCss, '.play-actions-row', '--play-action-stop-hover')).toEqual([
      'var(--control-danger-pill-hover)',
    ]);
    const stopSurfaceOwners: string[] = [];
    playCss.walkDecls(/^--play-action-stop-(?:surface|hover)$/u, (declaration) => {
      if (conditionOf(declaration) !== '@media (forced-colors: active)') {
        stopSurfaceOwners.push(where(declaration, 'css/playback-actions.css'));
      }
    });
    expect(stopSurfaceOwners).toHaveLength(2);

    // The demo exit keeps its 9.0.18 tints: --control-danger at rest and
    // --control-danger-hover on hover. Its resting rule comes after the
    // leave-session press rule with the same specificity, so a touch press
    // keeps the resting tint, as in 9.0.18.
    const demoExit = '.demo-large-actions .leave-session-btn';
    expect(ruleValues(appCss, demoExit, 'background')).toEqual(['var(--control-danger)']);
    expect(
      ruleValues(appCss, `:where(html[data-hover-pointer]) ${demoExit}:hover`, 'background'),
    ).toEqual(['var(--control-danger-hover)']);
    const lineOf = (selector: string): number => {
      let line = 0;
      appCss.walkRules((rule) => {
        if (conditionOf(rule) !== null) return;
        if (!rule.selectors.map((entry) => entry.replace(/\s+/gu, ' ').trim()).includes(selector))
          return;
        if (rule.nodes.some((node) => node.type === 'decl' && node.prop === 'background')) {
          line = rule.source?.start?.line ?? 0;
        }
      });
      return line;
    };
    expect(lineOf(demoExit)).toBeGreaterThan(lineOf('.leave-session-btn:active'));
    // Account deletion's press rule has the hover rule's specificity and comes
    // after it, so a hovered press shows the press tint, as in 9.0.18.
    expect(lineOf(dangerHover)).toBeGreaterThan(0);
    expect(lineOf(dangerPress)).toBeGreaterThan(lineOf(dangerHover));
    const demoSurfaces: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls(/^background/u, (declaration) => {
        const rule = declaration.parent as unknown as { selectors?: string[] };
        if (
          rule.selectors?.some((selector) =>
            /\.demo-large-actions\b.*\.leave-session-btn/u.test(selector),
          )
        ) {
          demoSurfaces.push(where(declaration, path));
        }
      });
    }
    expect(demoSurfaces).toHaveLength(2);

    // No action button or label paints a red of its own, in its label, icon,
    // surface, border or shadow.
    const reds: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (
          !/^(?:color|fill|stroke|background(?:-color|-image)?|border(?:-[\w-]+)?|outline(?:-color)?|box-shadow|--[\w-]*foreground)$/u.test(
            declaration.prop,
          )
        )
          return;
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

  it('paints every red text and icon with the danger foreground', () => {
    // Owner question (2026-10-27): "aren't there other reds too?" Every red
    // that marks danger, an error or a destructive action as text or as an
    // icon reads --danger-foreground; red surfaces read the --control-danger
    // tints, or --danger-filled under white icons (white text on it needs its
    // own check: the chat badge is 3.76:1). Only the YouTube mark keeps
    // its brand red, because it names the source, not a danger.
    const BRAND_REDS: ReadonlyArray<{ selector: RegExp; declaration: string; reason: string }> = [
      {
        selector: /\.btn-icon-bg\.youtube/u,
        declaration: 'color: #ff0033',
        reason: 'YouTube mark on the media source option.',
      },
      {
        selector: /\.btn-icon-bg\.youtube svg$/u,
        declaration: 'fill: #ff0033',
        reason: 'YouTube mark on the media source option in light theme.',
      },
      {
        selector: /^\.chat-youtube-btn:active$/u,
        declaration: 'background: #d90000',
        reason: 'Pressed YouTube card in chat, the brand red one step darker.',
      },
    ];
    const PALETTE =
      /^--(?:danger-filled|danger-foreground|youtube-filled|control-danger(?:-hover|-(?:pill|dialog)(?:-hover|-press)?)?)$/u;
    const TEXT_OR_ICON =
      /^(?:color|fill|stroke|border(?:-[\w-]+)?-color|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|outline(?:-color)?|text-decoration(?:-color)?|caret-color|--[\w-]*foreground)$/u;
    const SURFACE = /^(?:background(?:-color|-image)?|box-shadow|--[\w-]*(?:surface|hover))$/u;
    const violations: string[] = [];
    let brandSeen = 0;
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        const rule = declaration.parent;
        if (rule?.type !== 'rule' || PALETTE.test(declaration.prop)) return;
        const selectors = (rule as unknown as { selectors: string[] }).selectors.map((selector) =>
          selector.replace(/\s+/gu, ' ').trim(),
        );
        const value = `${declaration.prop}: ${declaration.value}`;
        const at = `${where(declaration, path)} ${selectors.join(', ')} { ${value} }`;
        if (isRedLiteral(declaration.value)) {
          const brand = BRAND_REDS.some(
            (allowed) =>
              allowed.declaration === value &&
              selectors.every((selector) => allowed.selector.test(selector)),
          );
          if (brand) brandSeen += 1;
          else violations.push(`hard-coded red: ${at}`);
          return;
        }
        if (
          TEXT_OR_ICON.test(declaration.prop) &&
          /var\(--(?:danger-filled|control-danger)/u.test(declaration.value)
        ) {
          violations.push(`surface red on text or icon: ${at}`);
        }
        if (
          SURFACE.test(declaration.prop) &&
          /var\(--danger-foreground\)/u.test(declaration.value)
        ) {
          violations.push(`label red on a surface: ${at}`);
        }
      });
    }
    expect(violations).toEqual([]);
    expect(brandSeen).toBe(4);

    // A red cannot hide in a color syntax the guards do not read.
    const unreadable: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        for (const found of unreadableColors(declaration.value)) {
          unreadable.push(`${where(declaration, path)} ${declaration.prop}: ${found}`);
        }
      });
    }
    expect(unreadable).toEqual([]);

    // The reds that were hard-coded read the role now: error and validation
    // text and the destructive row icons. (The unreachable disconnected
    // device badge went with the hidden settings device list; settings.test.ts
    // 'hidden settings device list removal' keeps them out.)
    const roleReaders: Array<[string, string]> = [
      ['.dialog-hint.error', 'color'],
      ['.dialog-input.invalid', 'border-bottom-color'],
      ['.dialog-input-split.invalid .dialog-input-segment', 'border-bottom-color'],
      ['.setup-inline-error', 'color'],
    ];
    for (const [selector, property] of roleReaders) {
      expect(ruleValues(appCss, selector, property), selector).toEqual([
        'var(--danger-foreground)',
      ]);
    }
    // The revoke icon and both device kick icons turn red for keyboard focus
    // as well as for a hover pointer.
    for (const icon of [
      ':where(html[data-hover-pointer]) .clearable-editor-button:hover',
      ':where(html[data-hover-pointer]) .btn-playlist-remove:not(:disabled):hover',
      ':where(html[data-hover-pointer]) .administrator-action-button.revoke:hover',
      '.administrator-action-button.revoke:focus-visible',
      ':where(html[data-hover-pointer]) .device-subrow:hover .btn-kick-physical-device:hover',
      '.btn-kick-physical-device:focus-visible',
      ':where(html[data-hover-pointer]) .device-row:hover .btn-kick-device:hover',
      '.btn-kick-device:focus-visible',
    ]) {
      expect(ruleValues(appCss, icon, 'color'), icon).toEqual(['var(--danger-foreground)']);
    }

    // Scripts paint no red of their own either: the YouTube link errors read
    // the role (there is no --danger token), and only the YouTube source icon
    // in playlist rows keeps the brand red.
    const scriptReds: string[] = [];
    for (const { path, source } of templateSources()) {
      for (const match of source.matchAll(
        /var\(--danger[,)]|#(?:ff3b30|ef4444|ff4d4f|d70015|a4001d|d90000)\b|rgba?\(\s*255\s*,\s*(?:59|77)\s*,/giu,
      )) {
        scriptReds.push(`${path}: ${match[0]}`);
      }
      for (const match of source.matchAll(/#ff0033\b/giu)) {
        if (path !== 'src/ui/playlist-view.ts') scriptReds.push(`${path}: ${match[0]}`);
      }
    }
    expect(scriptReds).toEqual([]);
    const search = read('src/youtube/search.ts');
    expect(search.match(/'var\(--danger-foreground\)'/gu) ?? []).toHaveLength(3);
  });

  it('reads a red in every CSS color syntax', () => {
    // A review mutation once added `.chat-error-text { color: crimson; }` and
    // both red guards stayed green: they read only hex and rgb().
    for (const red of [
      '#e53935',
      'rgb(229 57 53)',
      'rgb(90% 22% 21%)',
      'rgba(229.5, 57, 53, 0.9)',
      'crimson',
      'Tomato',
      '0 0 0 1px firebrick',
      'hsl(0 80% 50%)',
      'hsla(355, 90%, 45%, 0.8)',
      'hsl(0.99turn 70% 50%)',
      'hwb(0 10% 10%)',
      'lab(50 70 50)',
      'lch(50 80 30)',
      'oklab(0.6 0.2 0.1)',
      'oklch(0.6 0.22 25)',
      'oklch(60% 55% 25deg / 0.5)',
      'color(srgb 0.9 0.1 0.1)',
      'color(display-p3 1 0 0)',
      'color-mix(in srgb, crimson 60%, transparent)',
    ]) {
      expect(isRedLiteral(red), red).toBe(true);
    }
    for (const other of [
      'white',
      'transparent',
      'currentColor',
      'var(--danger-foreground)',
      'var(--youtube-red-filled)',
      "url('#tomato-gradient')",
      '.tomato',
      '#121212',
      'rgb(0 122 255)',
      'hsl(210 80% 50%)',
      'hwb(120 10% 10%)',
      'lab(50 -40 30)',
      'oklch(0.6 0.1 250)',
      'color(srgb 0.1 0.4 0.9)',
    ]) {
      expect(isRedLiteral(other), other).toBe(false);
    }
    expect(unreadableColors('color(rec2020 1 0 0)')).toEqual(['color(rec2020']);
    expect(unreadableColors('rgb(from var(--primary) r g b)')).toEqual(['rgb(from']);
    expect(unreadableColors('color(display-p3 1 0 0) hsl(0 80% 50%)')).toEqual([]);
  });

  it('retires the one-off account delete button and the dead btn-action rule', () => {
    const retired = /\.(?:account-delete-button|btn-action|btn-ob-text-link)(?![\w-])/u;
    for (const { path, root } of sheets) {
      root.walkRules((rule) => {
        expect(retired.test(rule.selector), `${path}: ${rule.selector}`).toBe(false);
      });
    }
    expect(appMarkup().querySelector('.account-delete-button, .btn-action')).toBeNull();
    for (const button of templateButtons()) {
      expect(button.classes, button.where).not.toContain('account-delete-button');
      expect(button.classes, button.where).not.toContain('btn-action');
      expect(button.classes, button.where).not.toContain('btn-ob-text-link');
    }
    // The setup screens never used the text-link button kind.
    expect(read('src/ui/setup-shared.ts')).not.toMatch(/text-link/u);
  });

  it('gives the device removal icons no opacity to restore', () => {
    // The member and physical-device removal icons show on every input and
    // no rule dims them, so a rule that names them sets or animates no
    // opacity; hover and focus only color them.
    const removal = /\.btn-kick-(?:physical-)?device(?![\w-])/u;
    const violations: string[] = [];
    for (const { path, root } of sheets) {
      root.walkRules((rule) => {
        if (!removal.test(rule.selector)) return;
        rule.each((node) => {
          if (node.type !== 'decl') return;
          const animated =
            /^transition(?:-property)?$/u.test(node.prop) && /\bopacity\b/u.test(node.value);
          if (node.prop === 'opacity' || animated) {
            violations.push(
              `${where(node, path)} ${rule.selector} { ${node.prop}: ${node.value} }`,
            );
          }
        });
      });
    }
    expect(violations).toEqual([]);
  });
});
