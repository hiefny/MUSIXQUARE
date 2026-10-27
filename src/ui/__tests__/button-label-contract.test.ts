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
// font-variation-settings can set the weight axis of the variable label face
// past font-weight, so action button rules may not set it either.
const FONT_PROPERTIES = [
  'font',
  'font-family',
  'font-variation-settings',
  ...Object.keys(LABEL_TOKENS),
];

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

// Labels that keep their own weight and tracking and share the label size and
// line height, each with the reason. The rule stays in the base layer, so the
// right-to-left reset (components layer) still removes the tracking.
const COMPACT_PLAY_ACTIONS =
  'The play tab keeps Sync and Media compact: each label sits beside its icon in a ' +
  '130px slot at the real 320px width and must stay on one line in every locale. ' +
  'At 700 the Finnish Synkronoi wraps with Linux fonts (PR #510 CI), so both keep ' +
  'the 9.0.18 label weight and tracking.';
const OWN_LABEL_DECLARATIONS: ReadonlyArray<{
  selector: string;
  declaration: string;
  reason: string;
}> = [
  { selector: '#btn-sync span', declaration: 'font-weight: 600', reason: COMPACT_PLAY_ACTIONS },
  {
    selector: '#btn-sync span',
    declaration: 'letter-spacing: -0.3px',
    reason: COMPACT_PLAY_ACTIONS,
  },
  {
    selector: '#btn-media-source span',
    declaration: 'font-weight: 600',
    reason: COMPACT_PLAY_ACTIONS,
  },
  {
    selector: '#btn-media-source span',
    declaration: 'letter-spacing: -0.3px',
    reason: COMPACT_PLAY_ACTIONS,
  },
];

// Every other button class in index.html and the TypeScript templates, with
// the reason it is not an action button. A new button class must join one list.
const NOT_ACTION_BUTTONS: Readonly<Record<string, string>> = {
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
// The same named narrow-slot exception as the compact play actions (U12).
const DEMO_FINISH_PAIR_WEIGHT =
  'The demo finish pair keeps the 9.0.18 label weight 600 in its 13px label on phones ' +
  'up to 420px: at 700 more localized labels spill past their fixed 54px pills at ' +
  '320px and 340px (Malayalam and Tamil Exit Tour) than in 9.0.18. The adaptive-actions ' +
  'probe pins every locale at 320, 340 and 360px to no worse than 9.0.18.';
// The label sweep (PR #510 QA round 8): every label whose typography this
// train changed, in all 42 locales at 320 to 390px and around every width
// boundary, against origin/main 9.0.18 (6a23c46e). These slots wrapped,
// broke a word, stacked a pair or reached past their pill or the viewport
// where 9.0.18 did not, so each keeps its 9.0.18 label typography up to the
// width where the shared label has room again (the swept-slot probe in
// adaptive-actions pins every locale). Line height stays the shared token.
const SWEPT_ACCOUNT_DELETION =
  'Account deletion keeps its 9.0.18 14px label on phones up to 420px and screens up to 350px ' +
  'tall: at 15px the Greek and Malayalam labels wrap at 320 and 340px, and Log out and ' +
  'Delete account stack in English at 360px and in French at 568x320 where 9.0.18 kept them ' +
  'on one row. The dialog stops widening at 400px, so taller screens above 420px keep 15px.';
const SWEPT_INVITE_LINK =
  'The connect tab invite button keeps the 9.0.18 weight 600 in every mode on phones up to ' +
  "420px: at 700 'Room connection ended' wraps in Italian and Romanian at 390px and the " +
  'Tamil copy label at 410px, where 9.0.18 kept one line.';
const SWEPT_LEAVE_SESSION =
  'Leave Session on the connect tab keeps the 9.0.18 weight 600 on phones up to 420px: at ' +
  '700 the Malayalam label wraps at 390px where 9.0.18 kept one line.';
const SWEPT_HELP_ACTIONS =
  'The help tab tour and screensaver pills keep the 9.0.18 weight 600 together on phones up ' +
  'to 420px: at 700 the screensaver label wraps in Malay, Hungarian, Romanian and Tamil ' +
  'between 340 and 375px where 9.0.18 kept one line.';
const SWEPT_MEDIA_SOURCES =
  'The three media source options keep the 9.0.18 label weight and tracking, 600 and ' +
  '-0.3px, in the phone layout up to 719px: at 700 local file and system audio labels wrap ' +
  "or break a word in up to 30 locales between 320 and 488px (German 'Systemaudio' splits " +
  'at 320px). The rule stays in the base layer, so right-to-left labels take no tracking.';
const SWEPT_SELECTION_TOGGLE =
  'The deletion-mode Select all / Deselect all toggle keeps the 9.0.18 weight 600 on phones ' +
  'up to 420px: at 700 the Tamil and Malayalam labels reach past the screen edge at 320 and ' +
  '340px, further than in 9.0.18.';
const SWEPT_SETUP_CHOICE =
  'Create a Room and Join a Room keep the 9.0.18 weight 600 together on phones up to 420px: ' +
  'at 700 the Bulgarian Join a Room wraps at 360px where 9.0.18 kept one line.';
const SWEPT_YOUTUBE_ACTIONS =
  'The YouTube link dialog Cancel and Add pair keeps the 9.0.18 weight 600 in the phone ' +
  'layout up to 719px: at 700 Add wraps in German and Hungarian at 360px and in Bulgarian at ' +
  '421px where 9.0.18 kept one line.';
const COMPACT_OVERRIDES: ReadonlyArray<{
  condition: string;
  selector: string;
  declaration: string;
  reason: string;
}> = [
  {
    condition: '@media (max-width: 420px), (max-height: 350px)',
    selector: '#btn-account-delete',
    declaration: 'font-size: 14px',
    reason: SWEPT_ACCOUNT_DELETION,
  },
  {
    condition: '@media (max-width: 420px)',
    selector: '.btn-copy-invite-link',
    declaration: 'font-weight: 600',
    reason: SWEPT_INVITE_LINK,
  },
  {
    condition: '@media (max-width: 420px)',
    selector: '#btn-leave-session',
    declaration: 'font-weight: 600',
    reason: SWEPT_LEAVE_SESSION,
  },
  ...['#btn-demo-media-mobile', '#btn-screensaver-mobile'].map((selector) => ({
    condition: '@media (max-width: 420px)',
    selector,
    declaration: 'font-weight: 600',
    reason: SWEPT_HELP_ACTIONS,
  })),
  ...[
    '#btn-local-file > span',
    '#btn-youtube-source > span',
    '#btn-system-audio .media-source-label-text',
  ].flatMap((selector) =>
    ['font-weight: 600', 'letter-spacing: -0.3px'].map((declaration) => ({
      condition: '@media (max-width: 719px)',
      selector,
      declaration,
      reason: SWEPT_MEDIA_SOURCES,
    })),
  ),
  {
    condition: '@media (max-width: 420px)',
    selector: '.playlist-selection-toggle',
    declaration: 'font-weight: 600',
    reason: SWEPT_SELECTION_TOGGLE,
  },
  ...['#btn-setup-host', '#btn-setup-guest'].map((selector) => ({
    condition: '@media (max-width: 420px)',
    selector,
    declaration: 'font-weight: 600',
    reason: SWEPT_SETUP_CHOICE,
  })),
  ...['#btn-yt-cancel', '#youtube-play-btn'].map((selector) => ({
    condition: '@media (max-width: 719px)',
    selector,
    declaration: 'font-weight: 600',
    reason: SWEPT_YOUTUBE_ACTIONS,
  })),
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
    condition: '@media (max-width: 420px)',
    selector: '.demo-large-actions .accent-action-btn',
    declaration: 'font-weight: 600',
    reason: DEMO_FINISH_PAIR_WEIGHT,
  },
  {
    condition: '@media (max-width: 420px)',
    selector: '.demo-large-actions .leave-session-btn',
    declaration: 'font-weight: 600',
    reason: DEMO_FINISH_PAIR_WEIGHT,
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

/** A label's own weight or tracking, outside every condition. */
function isOwnLabelDeclaration(declaration: Declaration, selector: string): boolean {
  return OWN_LABEL_DECLARATIONS.some(
    (allowed) =>
      conditionOf(declaration) === null &&
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
  const matchedInOrder = (element: Element, properties: readonly string[]) => {
    let byKey = matched.get(element);
    if (!byKey) matched.set(element, (byKey = new Map()));
    const key = properties.join(' ');
    let list = byKey.get(key);
    if (!list) {
      list = properties
        .flatMap((property) => declarations.get(property) ?? [])
        .filter((candidate) => {
          try {
            return element.matches(candidate.selector);
          } catch {
            throw new Error(`jsdom cannot match ${candidate.where}`);
          }
        })
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

  const custom = (element: Element, name: string, environment: MediaEnvironment): string | null => {
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
 * Every derived viewport, alone and with each media preference, reduced to
 * one environment per distinct set of matching conditions: the cascade reads
 * nothing else from the environment, so the others resolve identically.
 */
function resolverEnvironments(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
): MediaEnvironment[] {
  const conditions: AtRule[] = [];
  for (const { root } of stylesheets) {
    root.walkAtRules((atRule) => {
      // Container queries do not depend on the viewport; a label declaration
      // under one fails the resolver instead (conditionsApply).
      if (atRule.name === 'media' || atRule.name === 'supports') conditions.push(atRule);
    });
  }
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
    context: { label: string; direction: string; environment: MediaEnvironment },
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
            });
          }
        }
        undo();
      }
    }
  }
  return resolutions;
}

/** Label typography a declaration may set on an action button or its label. */
function labelViolation(declaration: Declaration, ownSize: boolean): boolean {
  if (declaration.prop === 'font' || declaration.prop === 'font-family') return true;
  if (ownSize && declaration.prop === 'font-size') return false;
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

// The named narrow-slot exceptions (U12 and the label sweep), each pinned by
// the value that wins the cascade on the real markup in every page state that
// app rules key on, both directions and themes and every derived viewport.
interface ResolveContext {
  direction: string;
  environment: MediaEnvironment;
}
interface NarrowSlot {
  name: string;
  prepare: (markup: Document) => void;
  states: readonly PageState[];
  targets: (markup: Document) => Element[];
  expected: (context: ResolveContext) => Record<ResolvedProperty, string>;
}
const typography = (
  size: string,
  weight: string,
  lineHeight: string,
  letterSpacing: string,
): Record<ResolvedProperty, string> => ({
  'font-size': size,
  'font-weight': weight,
  'line-height': lineHeight,
  'letter-spacing': letterSpacing,
  'font-variation-settings': 'normal',
});
const SHARED_LABEL = typography('15px', '700', '1.25', 'normal');
const SEMIBOLD_LABEL = typography('15px', '600', '1.25', 'normal');
const upTo =
  (maxWidth: number, narrow: Record<ResolvedProperty, string>) =>
  ({ environment }: ResolveContext): Record<ResolvedProperty, string> =>
    environment.width <= maxWidth ? narrow : SHARED_LABEL;

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

// The label sweep's narrow slots (PR #510 QA round 8; SWEPT_* reasons above).
const SWEPT_NARROW_SLOTS: readonly NarrowSlot[] = [
  {
    name: 'account deletion',
    prepare: (markup) => {
      markup.getElementById('account-dialog-overlay')!.classList.add('show');
      markup.getElementById('account-dialog-actions')!.removeAttribute('hidden');
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'busy', apply: setAttribute('#account-dialog', 'aria-busy', 'true') },
    ],
    targets: (markup) => [markup.getElementById('btn-account-delete')!],
    expected: ({ environment }) =>
      environment.width <= 420 || environment.height <= 350
        ? typography('14px', '700', '1.25', 'normal')
        : SHARED_LABEL,
  },
  {
    name: 'invite link',
    prepare: (markup) => {
      showTab('tab-connect')(markup);
      // As src/ui/connect.ts mounts it.
      mount(
        markup,
        '#qr-container',
        '<button type="button" class="btn-copy-invite-link" data-mode="copy">' +
          '<svg viewBox="0 0 24 24"></svg>' +
          '<span class="material-elastic-spinner signaling-recovery-spinner"></span>' +
          '<span data-i18n="connect.copy_invite_link">Copy invite link</span></button>',
      );
    },
    states: [
      ...SHARED_PAGE_STATES,
      ...['recover', 'recovering', 'expired'].map((mode) => ({
        name: `${mode} mode`,
        apply: setAttribute('#qr-container .btn-copy-invite-link', 'data-mode', mode),
      })),
    ],
    targets: (markup) => [
      ...markup.querySelectorAll(
        '#qr-container .btn-copy-invite-link, #qr-container .btn-copy-invite-link > span[data-i18n]',
      ),
    ],
    expected: upTo(420, SEMIBOLD_LABEL),
  },
  {
    name: 'leave session',
    prepare: showTab('tab-connect'),
    states: SHARED_PAGE_STATES,
    targets: (markup) => [
      ...markup.querySelectorAll('#btn-leave-session, #btn-leave-session > span'),
    ],
    expected: upTo(420, SEMIBOLD_LABEL),
  },
  {
    name: 'help actions',
    prepare: showTab('tab-guide'),
    states: SHARED_PAGE_STATES,
    targets: (markup) => [
      ...markup.querySelectorAll(
        '#btn-demo-media-mobile, #btn-demo-media-mobile > span, ' +
          '#btn-screensaver-mobile, #btn-screensaver-mobile > span',
      ),
    ],
    expected: upTo(420, SEMIBOLD_LABEL),
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
    targets: (markup) => [
      ...markup.querySelectorAll(
        '#btn-local-file > span, #btn-youtube-source > span, ' +
          '#btn-system-audio .media-source-label-text',
      ),
    ],
    expected: ({ direction, environment }) =>
      environment.width <= 719
        ? typography('15px', '600', '1.25', direction === 'rtl' ? 'normal' : '-0.3px')
        : SHARED_LABEL,
  },
  {
    name: 'selection toggle',
    prepare: (markup) => {
      showTab('tab-playlist')(markup);
      // As src/ui/playlist-removal.ts lays out the deletion mode.
      markup.querySelector('#tab-playlist > .tab-header')!.classList.add('is-removal-selecting');
      mount(
        markup,
        '#tab-playlist .playlist-title-area',
        '<button type="button" class="playlist-selection-toggle" ' +
          'data-selection-action="select-all">Select all (999)</button>',
      );
    },
    states: SHARED_PAGE_STATES,
    targets: (markup) => [...markup.querySelectorAll('.playlist-selection-toggle')],
    expected: upTo(420, SEMIBOLD_LABEL),
  },
  {
    name: 'setup choice',
    prepare: (markup) => {
      markup.getElementById('setup-overlay')!.classList.add('active');
      // As src/ui/setup.ts renders the room choice.
      markup.getElementById('setup-actions')!.classList.add('vertical');
      mount(
        markup,
        '#setup-actions',
        '<button id="btn-setup-host" type="button" class="btn-ob-primary">Create a Room</button>' +
          '<button id="btn-setup-guest" type="button" class="btn-ob-secondary">Join a Room</button>',
      );
    },
    states: SHARED_PAGE_STATES,
    targets: (markup) => [...markup.querySelectorAll('#btn-setup-host, #btn-setup-guest')],
    expected: upTo(420, SEMIBOLD_LABEL),
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
    targets: (markup) => [...markup.querySelectorAll('#btn-yt-cancel, #youtube-play-btn')],
    expected: upTo(719, SEMIBOLD_LABEL),
  },
];

// A rule each swept slot's guard must catch: a token read in a later layer,
// between two samples or on short screens only.
const NARROW_SLOT_MUTATIONS: Record<string, { slots: string[]; css: string }> = {
  'account deletion back to 15px in a later layer': {
    slots: ['account deletion'],
    css: `
    @layer responsive {
      .account-dialog-actions .dialog-secondary {
        font-size: var(--button-label-size);
      }
    }`,
  },
  'account deletion back to 15px on short screens only': {
    slots: ['account deletion'],
    css: `
    @layer states {
      @media (min-width: 421px) and (max-height: 350px) {
        .account-dialog-actions .dialog-danger {
          font-size: var(--button-label-size);
        }
      }
    }`,
  },
  'invite link back to 700 on 375px phones': {
    slots: ['invite link'],
    css: `
    @layer states {
      @media (min-width: 361px) and (max-width: 389px) {
        .qr-container .btn-copy-invite-link {
          font-weight: var(--button-label-weight);
        }
      }
    }`,
  },
  'leave session back to 700 in landscape': {
    slots: ['leave session'],
    css: `
    @layer components {
      @media (orientation: landscape) {
        .section-group > .leave-session-btn {
          font-weight: var(--button-label-weight);
        }
      }
    }`,
  },
  'help actions back to 700 in a later layer': {
    slots: ['help actions'],
    css: `
    @layer components {
      .help-actions .accent-action-btn {
        font-weight: var(--button-label-weight);
      }
    }`,
  },
  'media sources lose their tracking in a later layer': {
    slots: ['media sources'],
    css: `
    @layer components {
      .setup-slot-list .file-select-btn span {
        letter-spacing: var(--button-label-letter-spacing);
      }
    }`,
  },
  'media sources back to 700 between 421 and 719px': {
    slots: ['media sources'],
    css: `
    @layer responsive {
      @media (min-width: 421px) and (max-width: 719px) {
        #media-source-overlay .file-select-btn > span {
          font-weight: var(--button-label-weight);
        }
      }
    }`,
  },
  'selection toggle back to 700 through the weight axis': {
    slots: ['selection toggle'],
    css: `
    @layer states {
      .tab-header.is-removal-selecting .playlist-selection-toggle {
        font-variation-settings: 'wght' 700;
      }
    }`,
  },
  'setup choice back to 700 in a later layer': {
    slots: ['setup choice'],
    css: `
    @layer responsive {
      .onboarding-overlay .ob-actions.vertical > button {
        font-weight: var(--button-label-weight);
      }
    }`,
  },
  'YouTube link actions back to 700 at 421px': {
    slots: ['YouTube link actions'],
    css: `
    @layer states {
      @media (min-width: 421px) and (max-width: 421px) {
        .setup-card-mt-8-row > button {
          font-weight: var(--button-label-weight);
        }
      }
    }`,
  },
};

const NARROW_SLOTS: readonly NarrowSlot[] = [
  {
    // The play tab's Sync, Media and Stop Sharing labels.
    name: 'compact play actions',
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
    targets: (markup) => [
      ...markup.querySelectorAll(
        '#btn-sync .play-action-label, #btn-media-source .play-action-label',
      ),
    ],
    expected: ({ direction }) =>
      typography('15px', '600', '1.25', direction === 'rtl' ? 'normal' : '-0.3px'),
  },
  {
    // The demo finish pair, Track info and Exit Tour, and their labels.
    name: 'demo finish pair',
    prepare: (markup) => {
      // As src/demo/mode.ts applies the demo.
      markup.body.classList.add('mode-demo', 'demo-mobile');
      markup.getElementById('demo-overlay')!.classList.add('active');
      for (const panel of markup.querySelectorAll('.demo-step-panel')) {
        panel.classList.toggle('active', panel.getAttribute('data-demo-panel') === '4');
      }
    },
    states: [
      ...SHARED_PAGE_STATES,
      { name: 'demo chrome hiding', apply: toggleClass('body', 'demo-chrome-hiding') },
    ],
    targets: (markup) => [
      ...markup.querySelectorAll(
        '[data-demo-info], [data-demo-info] > span, [data-demo-exit], [data-demo-exit] > span',
      ),
    ],
    expected: ({ environment }) =>
      environment.width <= 420 ? typography('13px', '600', '1.25', 'normal') : SHARED_LABEL,
  },
  ...SWEPT_NARROW_SLOTS,
];

class FirstFailure extends Error {}

/**
 * Every resolution of the named narrow slots that differs from its
 * expectation, or only the first one (a mutation check needs no more).
 */
function narrowSlotFailures(
  stylesheets: ReadonlyArray<{ path: string; root: Root }>,
  options: { firstOnly?: boolean; slots?: readonly string[] } = {},
): {
  failures: string[];
  resolutions: Record<string, number>;
} {
  const failures: string[] = [];
  const resolutions: Record<string, number> = {};
  try {
    for (const slot of NARROW_SLOTS) {
      if (options.slots && !options.slots.includes(slot.name)) continue;
      resolutions[slot.name] = resolveAcross(
        stylesheets,
        slot.prepare,
        slot.states,
        slot.targets,
        (resolved, context) => {
          const want = slot.expected(context);
          if (JSON.stringify(resolved) === JSON.stringify(want)) return;
          failures.push(`${slot.name} ${context.label}: ${JSON.stringify(resolved)}`);
          if (options.firstOnly) throw new FirstFailure();
        },
      );
    }
  } catch (error) {
    if (!(error instanceof FirstFailure)) throw error;
  }
  return { failures, resolutions };
}

describe('action button label contract', () => {
  it('defines the button label tokens and the danger foreground once on the root', () => {
    for (const [token, value] of Object.entries(LABEL_VALUES)) {
      expect(ruleValues(appCss, ':root', token), token).toEqual([value]);
      for (const { path, root } of sheets) {
        const owners: string[] = [];
        root.walkDecls(token, (declaration) => {
          owners.push(where(declaration, path));
        });
        expect(owners.length, `${token} owners in ${path}`).toBe(path === 'css/style.css' ? 1 : 0);
      }
    }
    expect(ruleValues(appCss, ':root', '--danger-foreground')).toEqual(['#ff3b30']);
    // Owner decision (2026-10-27, evening): the default light theme keeps the
    // red of 9.0.18 instead of a darker one; only high contrast darkens it.
    expect(ruleValues(appCss, "html[data-theme='light']", '--danger-foreground')).toEqual([]);
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
          if (isOwnLabelDeclaration(declaration, selector)) continue;
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

  it('keeps the compact play action labels at their 9.0.18 weight and tracking', () => {
    // PR #510 CI (Linux fonts): at 700 the Finnish Synkronoi wrapped to two
    // lines in its 130px slot at the real 320px width. Sync and Media (and
    // Stop Sharing, inside the media button) keep 600 and -0.3px as in 9.0.18
    // and read the shared size and line height, the same 15px / 1.25 as 9.0.18.
    for (const selector of ['#btn-sync span', '#btn-media-source span']) {
      expect(ruleValues(appCss, selector, 'font-weight'), selector).toEqual(['600']);
      expect(ruleValues(appCss, selector, 'letter-spacing'), selector).toEqual(['-0.3px']);
      expect(ruleValues(appCss, selector, 'font-size'), selector).toEqual([]);
      expect(ruleValues(appCss, selector, 'line-height'), selector).toEqual([]);
    }
    expect(ruleValues(appCss, '.file-select-btn', 'font-size')).toEqual([
      LABEL_TOKENS['font-size'],
    ]);
    expect(ruleValues(appCss, '.file-select-btn', 'line-height')).toEqual([
      LABEL_TOKENS['line-height'],
    ]);
    expect(LABEL_VALUES['--button-label-size']).toBe('15px');
    expect(LABEL_VALUES['--button-label-line-height']).toBe('1.25');
    // No other rule sets their label typography.
    const owners: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!FONT_PROPERTIES.includes(declaration.prop)) return;
        const rule = declaration.parent as unknown as { type: string; selectors?: string[] };
        if (rule.type !== 'rule') return;
        for (const selector of rule.selectors ?? []) {
          if (!/#btn-(?:sync|media-source)(?![\w-])|play-action-label/u.test(selector)) continue;
          owners.push(`${path} ${selector.replace(/\s+/gu, ' ').trim()} ${declaration.prop}`);
        }
      });
    }
    expect(owners.sort()).toEqual([
      'css/style.css #btn-media-source span font-weight',
      'css/style.css #btn-media-source span letter-spacing',
      'css/style.css #btn-sync span font-weight',
      'css/style.css #btn-sync span letter-spacing',
    ]);
    // As in 9.0.18, the tracking sits in the base layer and the right-to-left
    // reset in the components layer, so Arabic and Hebrew labels take none.
    appCss.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.trim() === '#btn-sync span')) return;
      expect(layerOf(rule)).toBe('base');
    });
    const rtlReset =
      "html[dir='rtl'] :where(h1, h2, h3, h4, p, button, label, span, input, textarea)";
    const rtlLayers: Array<string | null> = [];
    for (const { root } of sheets) {
      root.walkRules((rule) => {
        if (rule.selectors.some((selector) => selector.replace(/\s+/gu, ' ').trim() === rtlReset)) {
          rtlLayers.push(layerOf(rule));
        }
      });
    }
    expect(rtlLayers).toEqual(['components']);
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

  it('resolves the named narrow-slot exceptions through the whole cascade', () => {
    // Every direction, theme and page state below, in each derived viewport and
    // media preference: the value that wins the cascade, not only the rule that
    // sets it, keeps the 9.0.18 typography on the narrow slots.
    const { failures, resolutions } = narrowSlotFailures(sheets);
    for (const slot of NARROW_SLOTS) {
      const markup = appMarkup();
      slot.prepare(markup);
      expect(resolutions[slot.name], slot.name).toBe(
        2 * 2 * slot.states.length * RESOLVER_ENVIRONMENTS.length * slot.targets(markup).length,
      );
    }
    expect(failures.slice(0, 20), `${failures.length} resolutions differ`).toEqual([]);
  });

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
    // Every distinct set of matching conditions keeps one environment, and
    // every media preference is still sampled.
    for (const flag of MEDIA_PREFERENCES) {
      expect(
        RESOLVER_ENVIRONMENTS.some((environment) => environment[flag]),
        flag,
      ).toBe(true);
    }
    expect(RESOLVER_ENVIRONMENTS.length).toBeGreaterThan(40);
  });

  it('catches a later-layer, between-sample or variation rule that turns a narrow slot back', () => {
    // The PR #510 review mutations. Rule-level checks accept the token reads
    // (they are not violations); only the resolved cascade shows the label
    // back at 700. The fixed 22-viewport list missed the ranges between its
    // samples and the landscape-only phone range; the derived viewports and
    // font-variation-settings catch them.
    const mutations: Record<string, { slots: string[]; css: string }> = {
      'later-layer token reads': {
        slots: ['compact play actions', 'demo finish pair'],
        css: `
          @layer components {
            .file-select-btn span {
              font-weight: var(--button-label-weight);
              letter-spacing: var(--button-label-letter-spacing);
            }
          }
          @layer responsive {
            .accent-action-btn,
            .leave-session-btn {
              font-weight: var(--button-label-weight);
            }
          }`,
      },
      'play actions between two samples (375px phones)': {
        slots: ['compact play actions'],
        css: `
          @layer states {
            @media (min-width: 361px) and (max-width: 389px) {
              .play-actions-row span {
                font-weight: var(--button-label-weight);
              }
            }
          }`,
      },
      'demo pair between two samples': {
        slots: ['demo finish pair'],
        css: `
          @layer states {
            @media (min-width: 361px) and (max-width: 389px) {
              .demo-large-actions span {
                font-weight: var(--button-label-weight);
              }
            }
          }`,
      },
      'demo pair on landscape phones only': {
        slots: ['demo finish pair'],
        css: `
          @layer states {
            @media (max-width: 420px) and (orientation: landscape) {
              .demo-large-actions span {
                font-weight: var(--button-label-weight);
              }
            }
          }`,
      },
      'weight axis through font-variation-settings': {
        slots: ['compact play actions'],
        css: `
          @layer components {
            .play-actions-row span {
              font-variation-settings: 'wght' 700;
            }
          }`,
      },
      ...NARROW_SLOT_MUTATIONS,
    };
    // Each mutation turns every slot it names back somewhere.
    for (const [name, { slots, css }] of Object.entries(mutations)) {
      const mutated = [...sheets, { path: 'mutation.css', root: parseCss(css) }];
      for (const slot of slots) {
        expect(
          NARROW_SLOTS.map((entry) => entry.name),
          name,
        ).toContain(slot);
        expect(
          narrowSlotFailures(mutated, { firstOnly: true, slots: [slot] }).failures,
          `${name}: ${slot}`,
        ).toHaveLength(1);
      }
    }
    // Every swept slot has a mutation.
    for (const slot of SWEPT_NARROW_SLOTS) {
      expect(
        Object.values(NARROW_SLOT_MUTATIONS).some((mutation) => mutation.slots.includes(slot.name)),
        slot.name,
      ).toBe(true);
    }
    // A label-typography violation at rule level too.
    expect(
      labelViolation(
        (parseCss('.file-select-btn { font-variation-settings: "wght" 700 }').first as Rule)
          .first as Declaration,
        false,
      ),
    ).toBe(true);
    expect(FONT_PROPERTIES).toContain('font-variation-settings');
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
                if (isOwnLabelDeclaration(declaration, selector)) continue;
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
        rule.walkDecls((declaration) => {
          declarations.push(`${declaration.prop}: ${declaration.value}`);
        });
      });
      expect(declarations, allowed.selector).toContain(allowed.declaration);
    }
    for (const allowed of OWN_LABEL_DECLARATIONS) {
      const [property, value] = allowed.declaration.split(': ');
      expect(ruleValues(appCss, allowed.selector, property!), allowed.selector).toEqual([value]);
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
    expect([...remove.classList]).toEqual(['dialog-secondary', 'dialog-danger']);
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
    // device badge is gone; settings.test.ts keeps it out.)
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
    for (const icon of [
      ':where(html[data-hover-pointer]) .clearable-editor-button:hover',
      ':where(html[data-hover-pointer]) .btn-playlist-remove:not(:disabled):hover',
      ':where(html[data-hover-pointer]) .administrator-action-button.revoke:hover',
      '.administrator-action-button.revoke:focus-visible',
      ':where(html[data-hover-pointer]) .device-subrow:hover .btn-kick-physical-device:hover',
      '.btn-kick-physical-device:focus-visible',
      ':where(html[data-hover-pointer]) .device-row:hover .btn-kick-device:hover',
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
});
