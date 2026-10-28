/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseCss, type AtRule, type Declaration, type Node } from 'postcss';
import { describe, expect, it } from 'vitest';
import { APP_DICTIONARIES } from '../../i18n/catalogs.ts';

// Owner decision (2026-10-28, final): the app's text takes one of five weight
// roles and nothing else. Text never goes above 700 (max-font-weight.test.ts).
// - title 700: headings and display values (dialog, sheet and section titles,
//   the setup greeting, the playlist title switch, the account title, the
//   player track title, the invite code and room PIN digits, and the code
//   entry digits: the guest's invite code entry, the room PIN entry and the
//   manual sync value). Titles also share one tracking by script
//   (title-tracking-contract.test.ts).
// - selected 700 / unselected 500: in a list or group where one item is
//   selected, current or playing (it also turns the accent color), that item
//   takes the selected weight and every other item the unselected weight
//   (SELECTION_GROUPS).
// - label 600: names on controls and markers: every action button label,
//   badges, small meta labels such as 'invite code' and form field labels,
//   and toast text, which kept its 9.0.19 weight (owner decision 2026-10-29).
// - body 400: sentences and auxiliary text: descriptions, dialog body text,
//   hints, chat messages, the small line under a name, timestamps,
//   counters, input text and placeholders.
// Every rule reads its role's token itself, the same way component rules read
// the button label size tokens; size, color and spacing stay with the
// component.
const ROLE_TOKENS = {
  title: { token: '--font-weight-title', value: '700' },
  selected: { token: '--font-weight-selected', value: '700' },
  unselected: { token: '--font-weight-unselected', value: '500' },
  label: { token: '--font-weight-label', value: '600' },
  body: { token: '--font-weight-body', value: '400' },
} as const;
type WeightRole = keyof typeof ROLE_TOKENS;
const WEIGHT_ROLES = Object.keys(ROLE_TOKENS) as WeightRole[];
const roleRead = (role: WeightRole): string => `var(${ROLE_TOKENS[role].token})`;
const roleOf = (value: string): WeightRole | null =>
  WEIGHT_ROLES.find((role) => value === roleRead(role)) ?? null;
// The two tokens the five replace; nothing in the app reads them any more.
const RETIRED_TOKENS = ['--font-weight-display', '--button-label-weight'];

// The app stylesheet: css/app.css imports the first four, and index.html
// loads the font face sheet beside it.
const SHEET_PATHS = [
  'css/style.css',
  'css/desktop.css',
  'css/rtl.css',
  'css/playback-actions.css',
  'css/pretendard.css',
] as const;
const read = (path: string): string => readFileSync(resolve(path), 'utf8');
const sheets = SHEET_PATHS.map((path) => ({ path, root: parseCss(read(path)) }));
const appCss = sheets[0]!.root;

// Weight declarations that are not a text role, with the reason.
const NON_TEXT_WEIGHTS: Readonly<Record<string, string>> = {
  'css/pretendard.css @font-face { font-weight: 45 920 }':
    "The Pretendard variable face's weight range, not a text weight.",
};
// Text drawn to another party's brand specification, with the reason.
const BRAND_WEIGHTS: Readonly<Record<string, string>> = {
  'css/style.css .account-google-button { font-weight: 500 }':
    "The Google sign-in button follows Google's sign-in branding, which sets its label in " +
    'the Medium (500) weight.',
};
// The font shorthand may only reset a control to its parent's font, so the
// control inherits the role of the text around it.
const FONT_RESET = 'inherit';

interface WeightRule {
  path: string;
  /** The whole selector list, whitespace collapsed. */
  selector: string;
  selectors: string[];
  /** The at-rules around the rule, outermost first. */
  context: string;
  conditional: boolean;
  layer: number;
  line: number;
  declarations: Declaration[];
}

const normalize = (selector: string): string => selector.replace(/\s+/gu, ' ').trim();

const layerOrder = (() => {
  const order: string[] = [];
  appCss.walkAtRules('layer', (atRule) => {
    if (!atRule.nodes && order.length === 0) {
      order.push(...atRule.params.split(',').map((name) => name.trim()));
    }
  });
  return order;
})();

/** Every rule in the app stylesheet that declares a weight, a font or a weight axis. */
const weightRules: WeightRule[] = sheets.flatMap(({ path, root }) => {
  const rules: WeightRule[] = [];
  root.walkRules((rule) => {
    const declarations = rule.nodes.filter(
      (node): node is Declaration =>
        node.type === 'decl' &&
        (node.prop === 'font-weight' ||
          node.prop === 'font' ||
          node.prop === 'font-variation-settings'),
    );
    if (declarations.length === 0) return;
    const atRules: string[] = [];
    let layerName = '';
    let conditional = false;
    for (let parent = rule.parent as Node | undefined; parent; parent = parent.parent as Node) {
      if (parent.type !== 'atrule') continue;
      const atRule = parent as AtRule;
      atRules.unshift(`@${atRule.name} ${atRule.params}`);
      if (atRule.name === 'layer') layerName = atRule.params;
      else conditional = true;
    }
    rules.push({
      path,
      selector: rule.selectors.map(normalize).join(', '),
      selectors: rule.selectors.map(normalize),
      context: atRules.join(' > '),
      conditional,
      layer: layerName === '' ? layerOrder.length : layerOrder.indexOf(layerName),
      line: rule.source?.start?.line ?? 0,
      declarations,
    });
  });
  return rules;
});

const declarationKey = (path: string, selector: string, declaration: Declaration): string =>
  `${path} ${selector} { ${declaration.prop}: ${normalize(declaration.value)} }`;

/** Every font-weight a rule sets, by role (null for anything else). */
const ruleWeights = (rule: WeightRule): Array<WeightRole | null> =>
  rule.declarations
    .filter((declaration) => declaration.prop === 'font-weight')
    .map((declaration) => roleOf(declaration.value));

function findRules(selector: string): WeightRule[] {
  return weightRules.filter((rule) => rule.selector === selector);
}

// A selection group: one item is selected, current or playing and turns the
// accent color; the role decides the weight of both states. Each group names
// the rules that set its unselected and selected weights, and mounts sample
// items as the app renders them.
interface Sample {
  element: Element;
  role: 'selected' | 'unselected' | 'body';
}
interface SelectionGroup {
  name: string;
  unselected: readonly string[];
  selected: readonly string[];
  mount: (markup: Document) => Sample[];
}

function appMarkup(): Document {
  return new DOMParser().parseFromString(read('index.html'), 'text/html');
}

function mountIn(markup: Document, selector: string, html: string): Element {
  const container = markup.querySelector(selector);
  expect(container, selector).not.toBeNull();
  container!.insertAdjacentHTML('beforeend', html);
  return container!;
}

const samples = (
  container: ParentNode,
  entries: ReadonlyArray<[string, Sample['role']]>,
): Sample[] =>
  entries.flatMap(([selector, role]) => {
    const elements = [...container.querySelectorAll(selector)];
    expect(elements.length, selector).toBeGreaterThan(0);
    return elements.map((element) => ({ element, role }));
  });

/** The first item of each group selected, the others not, as the app toggles them. */
function selectFirst(
  items: Element[],
  groupOf: (item: Element) => Element | null,
  select: (item: Element, selected: boolean) => void,
): Array<{ item: Element; selected: boolean }> {
  const seen = new Set<Element | null>();
  return items.map((item) => {
    const group = groupOf(item);
    const selected = !seen.has(group);
    seen.add(group);
    select(item, selected);
    return { item, selected };
  });
}

const SELECTION_GROUPS: readonly SelectionGroup[] = [
  {
    name: 'track rows (name and index)',
    unselected: ['.track-idx', '.track-name'],
    selected: ['.track-item.active .track-idx, .track-item.active .track-name'],
    mount: (markup) => {
      // As src/ui/playlist-view.ts renders the current row and another.
      const list = mountIn(
        markup,
        '#playlist-ui',
        `<li class="playlist-entry" data-sample="current">
          <div class="track-item active">
            <div class="track-leading track-leading-static" aria-hidden="true"><span class="track-idx">1</span></div>
            <button type="button" class="track-name" data-action="play" aria-current="true"><span class="track-type-slot playlist-current-leading"></span><span class="track-name-text" dir="auto"><span class="playlist-title-marquee-content">Current track</span></span></button>
          </div>
        </li>
        <li class="playlist-entry" data-sample="other">
          <div class="track-item">
            <button type="button" class="track-leading playlist-reorder-handle"><span class="track-idx" aria-hidden="true">2</span></button>
            <button type="button" class="track-name" data-action="play"><span class="track-type-slot"></span><span class="track-name-text" dir="auto"><span class="playlist-title-marquee-content">Other track</span></span></button>
          </div>
        </li>
        <li class="playlist-entry" data-sample="upload">
          <div class="track-item pro-upload-row"><span class="track-name pro-upload-track"><span class="track-name-text pro-upload-name">Uploading track</span></span></div>
        </li>`,
      );
      return samples(list, [
        ['[data-sample="current"] .track-idx', 'selected'],
        ['[data-sample="current"] .track-name', 'selected'],
        ['[data-sample="other"] .track-idx', 'unselected'],
        ['[data-sample="other"] .track-name', 'unselected'],
        ['[data-sample="upload"] .track-name', 'unselected'],
      ]);
    },
  },
  {
    name: 'YouTube playlist sub-rows (name and index)',
    unselected: ['.sub-idx', '.sub-track-item[data-sub-index] .sub-name'],
    selected: ['.sub-track-item.active .sub-idx', '.sub-track-item.active .sub-name'],
    mount: (markup) => {
      // As src/ui/playlist-view.ts renders the video rows and the deferred
      // load hint, whose sentence reuses .sub-name.
      const list = mountIn(
        markup,
        '#playlist-ui',
        `<li class="playlist-entry is-playlist">
          <div class="track-item"></div>
          <ul class="sub-playlist">
            <li class="sub-track-item active" data-sub-index="0" role="button" aria-current="true"><span class="sub-idx playlist-current-leading"><span class="sub-idx-number">1</span></span><span class="sub-name" dir="auto"><span class="playlist-title-marquee-content">Current video</span></span></li>
            <li class="sub-track-item" data-sub-index="1" role="button"><span class="sub-idx"><span class="sub-idx-number">2</span></span><span class="sub-name" dir="auto"><span class="playlist-title-marquee-content">Other video</span></span></li>
            <li class="sub-track-item loading"><span class="sub-name">Play to load the full track list</span></li>
            <li class="sub-track-item loading">Loading...</li>
          </ul>
        </li>`,
      );
      return samples(list, [
        ['.sub-track-item.active .sub-idx', 'selected'],
        ['.sub-track-item.active .sub-name', 'selected'],
        ['.sub-track-item[data-sub-index="1"] .sub-idx', 'unselected'],
        ['.sub-track-item[data-sub-index="1"] .sub-name', 'unselected'],
        ['.sub-track-item.loading .sub-name', 'body'],
        ['.sub-track-item.loading', 'body'],
      ]);
    },
  },
  {
    name: 'device rows (name and order number)',
    unselected: ['.d-order', '.device-row .d-name'],
    selected: ['.device-row.is-current-member .d-order, .device-row.is-current-member .d-name'],
    mount: (markup) => {
      // As src/ui/connect.ts renders this device's member row and another.
      const list = mountIn(
        markup,
        '#connect-device-list',
        `<div role="listitem" class="device-entry" data-sample="current">
          <div class="device-row is-current-member" aria-current="true"><span class="d-order">#1</span><span class="d-name"><span class="d-name-label" dir="auto">Current member</span></span></div>
        </div>
        <div role="listitem" class="device-entry" data-sample="other">
          <div class="device-row"><span class="d-order">#2</span><span class="d-name"><span class="d-name-label" dir="auto">Other member</span></span></div>
        </div>`,
      );
      return samples(list, [
        ['[data-sample="current"] .d-order', 'selected'],
        ['[data-sample="current"] .d-name', 'selected'],
        ['[data-sample="other"] .d-order', 'unselected'],
        ['[data-sample="other"] .d-name', 'unselected'],
      ]);
    },
  },
  {
    name: 'device sub-rows (name and index)',
    unselected: ['.device-sub-index', '.device-sub-name'],
    selected: [
      '.device-subrow.is-current-device .device-sub-index, .device-subrow.is-current-device .device-sub-name',
    ],
    mount: (markup) => {
      // As src/ui/connect.ts renders an expanded member's devices.
      const list = mountIn(
        markup,
        '#connect-device-list',
        `<div role="listitem" class="device-entry">
          <div class="device-row"><span class="d-order">#3</span><span class="d-name"><span class="d-name-label">Member</span></span></div>
          <ul class="device-sublist">
            <li class="device-subrow is-current-device" aria-current="true"><span class="device-sub-index" aria-hidden="true">1</span><span class="device-sub-name" dir="auto">This device</span></li>
            <li class="device-subrow"><span class="device-sub-index" aria-hidden="true">2</span><span class="device-sub-name" dir="auto">Other device</span></li>
          </ul>
        </div>`,
      );
      return samples(list, [
        ['.is-current-device .device-sub-index', 'selected'],
        ['.is-current-device .device-sub-name', 'selected'],
        ['.device-subrow:not(.is-current-device) .device-sub-index', 'unselected'],
        ['.device-subrow:not(.is-current-device) .device-sub-name', 'unselected'],
      ]);
    },
  },
  {
    name: 'choice chips',
    unselected: ['.ch-opt'],
    selected: [
      ".ch-opt.active, .ch-opt.selected, #demo-overlay .ch-opt.demo-choice[aria-pressed='true']",
    ],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.ch-opt')],
        (chip) => chip.parentElement,
        (chip, selected) => {
          chip.classList.toggle('active', selected);
          chip.classList.remove('selected');
          chip.setAttribute('aria-pressed', String(selected));
        },
      ).map(({ item, selected }) => ({
        element: item,
        role: selected ? 'selected' : 'unselected',
      })),
  },
  {
    name: 'desktop settings section tabs',
    unselected: ['.subtab-pill'],
    selected: ['.subtab-pill.active'],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.subtab-pill')],
        (tab) => tab.parentElement,
        (tab, selected) => tab.classList.toggle('active', selected),
      ).map(({ item, selected }) => ({
        element: item,
        role: selected ? 'selected' : 'unselected',
      })),
  },
  {
    name: 'bottom navigation labels',
    unselected: ['.nav-item span'],
    selected: ['.nav-item.active span'],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.nav-item')],
        (item) => item.parentElement,
        (item, selected) => item.classList.toggle('active', selected),
      ).flatMap(({ item, selected }) =>
        [...item.querySelectorAll('span')].map((element) => ({
          element,
          role: selected ? ('selected' as const) : ('unselected' as const),
        })),
      ),
  },
  {
    name: 'language list and playlist slot and transfer lists (the name line)',
    unselected: ['.language-option-native'],
    selected: ['.language-option.active .language-option-native'],
    mount: (markup) => {
      // As src/ui/settings.ts renders the language list and
      // src/ui/playlist-slots-dialog.ts the slot rows; the line under the
      // name is body text in both states.
      const option = (selected: boolean, name: string, detail: string): string =>
        `<button type="button" class="language-option${selected ? ' active' : ''}" aria-pressed="${selected}">` +
        `<span class="language-option-label"><span class="language-option-native">${name}</span>` +
        `<span class="language-option-english">${detail}</span></span>` +
        '<span class="language-option-check" aria-hidden="true"></span></button>';
      const languages = mountIn(
        markup,
        '#language-list',
        option(true, '한국어', 'Korean') + option(false, 'Deutsch', 'German'),
      );
      const slots = mountIn(
        markup,
        '#playlist-slots-list',
        option(true, 'Playlist 1', '3 tracks').replace(
          'language-option-native',
          'language-option-native playlist-slot-name',
        ) + option(false, 'Playlist 2', '0 tracks'),
      );
      return [languages, slots].flatMap((list) =>
        samples(list, [
          ['.language-option.active .language-option-native', 'selected'],
          ['.language-option:not(.active) .language-option-native', 'unselected'],
          ['.language-option-english', 'body'],
        ]),
      );
    },
  },
  {
    name: 'dialog choice list (a radio group)',
    unselected: ['.dialog-choice-label'],
    selected: ['.dialog-choice-radio:checked + .dialog-choice-surface .dialog-choice-label'],
    mount: (markup) => {
      // As src/ui/dialog.ts renders a choice list after the dialog message.
      const choice = (checked: boolean, label: string): string =>
        '<label class="dialog-choice-option">' +
        `<input type="radio" class="dialog-choice-radio" name="sample"${checked ? ' checked' : ''}>` +
        '<span class="dialog-choice-surface" aria-hidden="true"><span class="dialog-choice-text">' +
        `<span class="dialog-choice-label">${label}</span>` +
        '<span class="dialog-choice-detail">Only devices that rejoin need the password.</span>' +
        '</span></span></label>';
      const message = markup.getElementById('dialog-message')!;
      message.insertAdjacentHTML(
        'afterend',
        '<div class="dialog-choice-frame"><div class="dialog-choice-list" role="radiogroup">' +
          choice(true, 'Keep everyone') +
          choice(false, 'Everyone rejoins') +
          '</div></div>',
      );
      const frame = message.nextElementSibling!;
      return samples(frame, [
        [':checked + .dialog-choice-surface .dialog-choice-label', 'selected'],
        [':not(:checked) + .dialog-choice-surface .dialog-choice-label', 'unselected'],
        ['.dialog-choice-detail', 'body'],
      ]);
    },
  },
  {
    name: 'chat command palette (a listbox)',
    unselected: ['.chat-cmd-usage'],
    selected: ['.chat-cmd-item.active .chat-cmd-usage'],
    mount: (markup) => {
      // As src/ui/chat.ts renders the suggestions, one option active.
      const option = (active: boolean, usage: string): string =>
        `<div class="chat-cmd-item${active ? ' active' : ''}" role="option" aria-selected="${active}">` +
        `<span class="chat-cmd-usage">${usage}</span> <span class="chat-cmd-desc">Command list</span></div>`;
      const wrapper = mountIn(
        markup,
        '.chat-input-wrapper',
        `<div class="chat-cmd-suggest" role="listbox">${option(true, '/help')}${option(false, '/users')}</div>`,
      );
      return samples(wrapper, [
        ['.chat-cmd-item.active .chat-cmd-usage', 'selected'],
        ['.chat-cmd-item:not(.active) .chat-cmd-usage', 'unselected'],
        ['.chat-cmd-desc', 'body'],
      ]);
    },
  },
  {
    name: 'YouTube search results',
    unselected: ['.yt-search-title'],
    selected: ['.yt-search-result.selected .yt-search-title'],
    mount: (markup) => {
      // As src/youtube/search.ts renders the results, the first selected.
      const result = (selected: boolean, title: string): string =>
        `<button type="button" class="yt-search-result${selected ? ' selected' : ''}" aria-pressed="${selected}">` +
        '<img class="yt-search-thumb" alt=""><span class="yt-search-meta">' +
        `<span class="yt-search-title" dir="auto">${title}</span>` +
        '<span class="yt-search-channel">Channel</span></span></button>';
      const list = mountIn(
        markup,
        '#youtube-search-results',
        result(true, 'Selected video') + result(false, 'Other video'),
      );
      return samples(list, [
        ['.yt-search-result.selected .yt-search-title', 'selected'],
        ['.yt-search-result:not(.selected) .yt-search-title', 'unselected'],
        ['.yt-search-channel', 'body'],
      ]);
    },
  },
  {
    name: 'demo role switch',
    unselected: ['.demo-role-segmented button'],
    selected: [".demo-role-segmented button[aria-pressed='true']"],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.demo-role-segmented button')],
        (button) => button.parentElement,
        (button, selected) => button.setAttribute('aria-pressed', String(selected)),
      ).map(({ item, selected }) => ({
        element: item,
        role: selected ? 'selected' : 'unselected',
      })),
  },
  {
    name: 'demo track list',
    unselected: ['.demo-track-row span', '.demo-track-row strong'],
    selected: ['.demo-track-row.active span, .demo-track-row.active strong'],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.demo-track-row')],
        (row) => row.parentElement,
        (row, selected) => row.classList.toggle('active', selected),
      ).flatMap(({ item, selected }) =>
        [...item.querySelectorAll('span, strong')].map((element) => ({
          element,
          role: selected ? ('selected' as const) : ('unselected' as const),
        })),
      ),
  },
  {
    name: 'demo step indicator',
    unselected: ['.demo-step-nav button', '.demo-step-nav button:not(.demo-step-next)::before'],
    selected: ['.demo-step-nav button.active, .demo-step-nav button.is-collapsing'],
    mount: (markup) =>
      selectFirst(
        [...markup.querySelectorAll('.demo-step-nav button[data-demo-step]')],
        (button) => button.parentElement,
        (button, selected) => {
          button.classList.toggle('active', selected);
          button.setAttribute('aria-pressed', String(selected));
        },
      ).map(({ item, selected }) => ({
        element: item,
        role: selected ? 'selected' : 'unselected',
      })),
  },
];

/** Selectors Level 4 specificity of one complex selector. */
type Specificity = [number, number, number];
const compareSpecificity = (first: Specificity, second: Specificity): number =>
  first[0] - second[0] || first[1] - second[1] || first[2] - second[2];

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

function specificity(selector: string): Specificity {
  const result: Specificity = [0, 0, 0];
  const add = (other: Specificity): void => {
    result[0] += other[0];
    result[1] += other[1];
    result[2] += other[2];
  };
  const identEnd = (from: number): number => {
    let index = from;
    while (index < selector.length && /[\w\\-]/u.test(selector[index]!)) index += 1;
    return index;
  };
  const closing = (from: number, open: string, close: string): number => {
    let depth = 0;
    for (let index = from; index < selector.length; index += 1) {
      if (selector[index] === open) depth += 1;
      else if (selector[index] === close && --depth === 0) return index;
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
      } else if (['is', 'not', 'has'].includes(name)) {
        add(
          splitTopLevel(args)
            .map(specificity)
            .reduce((best, next) => (compareSpecificity(next, best) > 0 ? next : best), [0, 0, 0]),
        );
      } else {
        result[1] += 1;
      }
    } else if (/[a-zA-Z_]/u.test(character)) {
      result[2] += 1;
      index = identEnd(index);
    } else {
      index += 1;
    }
  }
  return result;
}

// Dynamic states such as :hover still style the element, so the matcher
// drops them instead of letting a hover rule hide.
const DYNAMIC_STATES = /:(?:hover|focus-visible|focus-within|focus|active)(?![\w-])/gu;

/** The selectors of a rule that match an element (pseudo-elements excluded), or null if jsdom cannot read one. */
function matchingSelectors(rule: WeightRule, element: Element): string[] | null {
  const matched: string[] = [];
  for (const selector of rule.selectors) {
    if (selector.includes('::')) continue;
    try {
      if (element.matches(selector.replace(DYNAMIC_STATES, ''))) matched.push(selector);
    } catch {
      return null;
    }
  }
  return matched;
}

const unreadable = new Set<string>();

/** The weight rules that style an element itself. */
function ownRules(element: Element): Array<{ rule: WeightRule; specificity: Specificity }> {
  const own: Array<{ rule: WeightRule; specificity: Specificity }> = [];
  for (const rule of weightRules) {
    const matched = matchingSelectors(rule, element);
    if (matched === null) {
      unreadable.add(rule.selector);
      continue;
    }
    if (matched.length === 0) continue;
    own.push({
      rule,
      specificity: matched
        .map(specificity)
        .reduce((best, next) => (compareSpecificity(next, best) > 0 ? next : best)),
    });
  }
  return own;
}

const FORM_CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const isReset = (rule: WeightRule): boolean =>
  rule.declarations.every(
    (declaration) => declaration.prop === 'font' && declaration.value === FONT_RESET,
  );

/**
 * The role an element's weight resolves to, with every condition applied:
 * the winning unconditional rule (layer, specificity, source order), then
 * inheritance, which a form control's own font stops (Chromium's
 * `font: -webkit-small-control` sets 400). Conditional rules must agree with
 * it, or the element resolves to several roles.
 */
function resolvedRoles(element: Element | null): Set<WeightRole | 'off-role'> {
  if (!element) return new Set(['body']);
  const own = ownRules(element);
  const weights = own
    .filter(({ rule }) => ruleWeights(rule).length > 0)
    .sort(
      (first, second) =>
        first.rule.layer - second.rule.layer ||
        compareSpecificity(first.specificity, second.specificity) ||
        SHEET_PATHS.indexOf(first.rule.path as never) -
          SHEET_PATHS.indexOf(second.rule.path as never) ||
        first.rule.line - second.rule.line,
    );
  const weightOf = (rule: WeightRule): WeightRole | 'off-role' =>
    ruleWeights(rule).at(-1) ?? 'off-role';
  const roles = new Set<WeightRole | 'off-role'>();
  const winnerIndex = weights.findLastIndex(({ rule }) => !rule.conditional);
  if (winnerIndex >= 0) {
    roles.add(weightOf(weights[winnerIndex]!.rule));
  } else {
    // Where no rule of its own applies, the element inherits, unless it is a
    // form control without a font reset.
    const reset = own.some(({ rule }) => isReset(rule));
    const inherited =
      !reset && FORM_CONTROLS.has(element.tagName)
        ? new Set<WeightRole | 'off-role'>(['body'])
        : resolvedRoles(element.parentElement);
    for (const role of inherited) roles.add(role);
  }
  // A conditional rule that sorts after the winner takes over where it applies.
  for (const { rule } of weights.slice(winnerIndex + 1)) roles.add(weightOf(rule));
  return roles;
}

// Named text whose role the generic checks cannot see: one element per
// split between two roles in a shared rule or class.
const ROLE_SPOT_CHECKS: ReadonlyArray<{
  selector: string;
  role: WeightRole;
  reason: string;
  /** Markup that TypeScript renders, mounted after the named element. */
  mount?: readonly [string, string];
}> = [
  {
    selector: '#setup-code',
    role: 'title',
    reason: "The host's read-only invite code is a display value.",
  },
  {
    selector: '#setup-join-code',
    role: 'title',
    reason: "The guest's code entry digits are a display value, like the host's invite code.",
  },
  {
    selector: '.setup-greeting-text',
    role: 'title',
    reason: 'The setup greeting inherits the heading through its language button.',
  },
  { selector: '.invite-meta-value', role: 'title', reason: 'The invite code digits.' },
  { selector: '.invite-meta-label', role: 'label', reason: "The small 'invite code' label." },
  { selector: '.setup-code-label', role: 'label', reason: 'The small label above the code.' },
  { selector: '#bootstrap-failure-title', role: 'title', reason: 'The startup failure title.' },
  {
    selector: '.legal-desc strong',
    role: 'title',
    reason: 'The service notes subheadings, inside a help block.',
  },
  {
    selector: '.help-desc:not(.legal-desc) strong',
    role: 'label',
    reason: 'The term heads of the help lists, such as "Host:".',
  },
  { selector: '.role-badge', role: 'label', reason: 'The header role badge.' },
  { selector: '.feature-badge', role: 'label', reason: 'The BETA badge.' },
  {
    selector: '.administrator-permission-inherited',
    role: 'label',
    reason: "The administrator 'included' badge.",
  },
  {
    selector: '#toast-msg',
    role: 'label',
    reason: 'Toast text keeps the 9.0.19 weight (owner decision 2026-10-29).',
  },
  { selector: '.time-info', role: 'body', reason: 'The seek timestamps.' },
  { selector: '.track-artist', role: 'body', reason: 'The line under the player title.' },
  { selector: '.track-title', role: 'title', reason: 'The player track title.' },
  {
    selector: '.chat-input:not(.sync-col-value)',
    role: 'body',
    reason: 'The chat composer text; the manual sync value reuses the class.',
  },
  {
    selector: '.dialog-input-segment',
    role: 'title',
    reason: 'The room PIN entry digits are a display value, like the PIN display.',
    mount: [
      '#dialog-message',
      // As src/ui/dialog.ts renders the split PIN entry.
      '<div class="dialog-input-split"><input type="text" class="dialog-input-segment">' +
        '<span class="dialog-input-separator">-</span>' +
        '<input type="text" class="dialog-input-segment"></div>' +
        '<input type="text" class="dialog-input">',
    ],
  },
  {
    selector: '.dialog-input-separator',
    role: 'title',
    reason: 'The hyphen between the PIN halves matches the digits beside it.',
  },
  { selector: '.dialog-input', role: 'body', reason: 'Dialog input text.' },
  { selector: '.account-dialog-stat-row dd', role: 'body', reason: 'The account counters.' },
  { selector: '.account-dialog-stat-row dt', role: 'label', reason: 'The counter labels.' },
  {
    selector: '.slider-header > span:first-child',
    role: 'label',
    reason: 'A slider name, a form field label.',
  },
  { selector: '.role-hint-label', role: 'body', reason: 'The default value hint in a name.' },
  {
    selector: '.val-disp',
    role: 'title',
    reason: 'A slider value is a display value, in every layout.',
  },
  { selector: '.eq-val', role: 'title', reason: 'An equalizer band value, a display value.' },
  { selector: '.eq-label', role: 'label', reason: 'The band name under each slider.' },
  {
    selector: '#manual-sync-value',
    role: 'title',
    reason: 'The manual sync value is a display value, though it is typed like chat input.',
  },
  { selector: '.sync-col-label', role: 'label', reason: 'The manual sync field label.' },
  {
    selector: '.chat-preview-text',
    role: 'label',
    reason: 'The play tab chat preview keeps the CTA role of the button label table.',
  },
  {
    selector: '.header-loading-text',
    role: 'label',
    reason: 'The header loading status replaces the logo beside the label-weight account pill.',
  },
  { selector: '.youtube-settings-note', role: 'body', reason: 'A note over a disabled panel.' },
  {
    selector: '.system-audio-playlist-note',
    role: 'body',
    reason: 'The note over the playlist while system audio is shared.',
  },
  { selector: '.section-title', role: 'title', reason: 'Section headings, counted ones too.' },
  { selector: '.dialog-title', role: 'title', reason: 'Dialog and sheet titles.' },
  { selector: '.room-password-code', role: 'title', reason: 'The PRO room PIN display.' },
];

// TypeScript and the translations may render bold elements only where an app
// rule gives them a role: each source names the rule.
const BOLD_ELEMENT_SOURCES: Readonly<Record<string, { selector: string; role: WeightRole }>> = {
  'src/ui/chat-render.ts': {
    // The header line of command output (/help, /users, /debug).
    selector: '.chat-group.system .chat-text strong',
    role: 'title',
  },
};
// The translation keys that carry <strong>, rendered by these help blocks.
const BOLD_HOSTS = '.help-desc';

function sourceFiles(directory: string, skip: (path: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name).replace(/\\/gu, '/');
    if (skip(path)) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(path, skip));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

describe('weight role contract', () => {
  it('defines the five weight role tokens once on the root and retires the old ones', () => {
    for (const { token, value } of Object.values(ROLE_TOKENS)) {
      const owners: string[] = [];
      for (const { path, root } of sheets) {
        root.walkDecls(token, (declaration) => {
          const rule = declaration.parent as unknown as { selector?: string };
          owners.push(`${path} ${rule.selector} ${declaration.value}`);
        });
      }
      expect(owners, token).toEqual([`css/style.css :root ${value}`]);
    }
    const retired: string[] = [];
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        for (const token of RETIRED_TOKENS) {
          if (declaration.prop === token || declaration.value.includes(`var(${token}`)) {
            retired.push(`${path}:${declaration.source?.start?.line} ${declaration.toString()}`);
          }
        }
      });
    }
    expect(retired).toEqual([]);
  });

  it('mirrors the five tokens in the design-system token sheet', () => {
    const designTokens = parseCss(read('public/designsystem/colors_and_type.css'));
    for (const { token, value } of Object.values(ROLE_TOKENS)) {
      const values: string[] = [];
      designTokens.walkDecls(token, (declaration) => {
        values.push(declaration.value);
      });
      expect(values, token).toEqual([value]);
    }
  });

  it('gives every text weight in the app stylesheet a role token', () => {
    const violations: string[] = [];
    const exceptions = { ...NON_TEXT_WEIGHTS, ...BRAND_WEIGHTS };
    const used = new Set<string>();
    for (const { path, root } of sheets) {
      root.walkDecls((declaration) => {
        if (!['font-weight', 'font', 'font-variation-settings'].includes(declaration.prop)) return;
        const parent = declaration.parent as unknown as {
          type: string;
          name?: string;
          selectors?: string[];
        };
        const selector =
          parent.type === 'rule'
            ? (parent.selectors ?? []).map(normalize).join(', ')
            : `@${parent.name}`;
        const key = declarationKey(path, selector, declaration);
        if (key in exceptions) {
          used.add(key);
          return;
        }
        if (declaration.prop === 'font-weight' && roleOf(declaration.value)) return;
        if (declaration.prop === 'font' && declaration.value === FONT_RESET) return;
        if (declaration.prop === 'font-variation-settings' && !/wght/u.test(declaration.value)) {
          return;
        }
        violations.push(`${path}:${declaration.source?.start?.line} ${key}`);
      });
    }
    expect(violations).toEqual([]);
    expect(Object.keys(exceptions).filter((key) => !used.has(key))).toEqual([]);
    for (const reason of Object.values(exceptions)) expect(reason.length).toBeGreaterThan(20);
  });

  it("pairs each selection group's selected rule with its unselected rule", () => {
    const readers = new Map<string, WeightRole>();
    for (const group of SELECTION_GROUPS) {
      for (const [role, selectors] of [
        ['unselected', group.unselected],
        ['selected', group.selected],
      ] as const) {
        for (const selector of selectors) {
          const rules = findRules(selector).filter((rule) => ruleWeights(rule).length > 0);
          expect(
            rules.map((rule) => `${rule.path} ${ruleWeights(rule).join(' ')}`),
            `${group.name}: ${selector}`,
          ).toEqual([`${rules[0]?.path ?? '?'} ${role}`]);
          readers.set(selector, role);
        }
      }
    }
    // The two selection tokens belong to the groups alone.
    const strays: string[] = [];
    for (const rule of weightRules) {
      for (const role of ruleWeights(rule)) {
        if (role !== 'selected' && role !== 'unselected') continue;
        if (readers.get(rule.selector) !== role)
          strays.push(`${rule.path}:${rule.line} ${rule.selector}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it('resolves every selection group item to its state, and its sentences to body', () => {
    const failures: string[] = [];
    for (const group of SELECTION_GROUPS) {
      const markup = appMarkup();
      const items = group.mount(markup);
      expect(
        items.some((item) => item.role === 'unselected'),
        group.name,
      ).toBe(true);
      if (group.selected.length > 0) {
        expect(
          items.some((item) => item.role === 'selected'),
          group.name,
        ).toBe(true);
      }
      const sampled = new Set(items.map((item) => item.element));
      for (const { element, role } of items) {
        const label = `${group.name}: ${role} ${element.outerHTML.slice(0, 90)}`;
        const own = ownRules(element).filter(({ rule }) => ruleWeights(rule).length > 0);
        const named = (selectors: readonly string[]) =>
          own.filter(({ rule }) => selectors.includes(rule.selector));
        if (role === 'body') {
          const roles = resolvedRoles(element);
          if (roles.size !== 1 || !roles.has('body')) failures.push(`${label}: ${[...roles]}`);
          continue;
        }
        // Only the group's own rules set the weight of its items, so no
        // later layer or wider selector can flatten the two states.
        const others = own.filter(
          ({ rule }) =>
            !group.unselected.includes(rule.selector) && !group.selected.includes(rule.selector),
        );
        if (others.length > 0) {
          failures.push(
            `${label}: also styled by ${others.map(({ rule }) => rule.selector).join(' | ')}`,
          );
        }
        const base = named(group.unselected);
        const chosen = named(group.selected);
        if (base.length !== 1) failures.push(`${label}: ${base.length} unselected rules`);
        if (role === 'unselected' && chosen.length > 0) {
          failures.push(`${label}: the selected rule matches an unselected item`);
        }
        if (role === 'selected') {
          if (chosen.length !== 1) {
            failures.push(`${label}: ${chosen.length} selected rules`);
          } else if (base.length === 1) {
            const [selected, unselected] = [chosen[0]!, base[0]!];
            const wins =
              selected.rule.context === unselected.rule.context &&
              selected.rule.path === unselected.rule.path &&
              (compareSpecificity(selected.specificity, unselected.specificity) > 0 ||
                (compareSpecificity(selected.specificity, unselected.specificity) === 0 &&
                  selected.rule.line > unselected.rule.line));
            if (!wins)
              failures.push(`${label}: the selected rule does not win over the unselected one`);
          }
        }
        // The text inside an item inherits its state; only a badge (label)
        // or a hint (body) inside it may take its own role.
        for (const child of element.querySelectorAll('*')) {
          if (sampled.has(child) || child.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
          const childOwn = ownRules(child).filter(({ rule }) =>
            ruleWeights(rule).some((weight) => weight !== 'label' && weight !== 'body'),
          );
          if (childOwn.length > 0) {
            failures.push(
              `${label}: inner ${child.tagName.toLowerCase()}.${child.className} takes ` +
                childOwn.map(({ rule }) => rule.selector).join(' | '),
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    const groupClasses =
      /track-|sub-|d-order|d-name|device-sub|ch-opt|subtab-pill|nav-item|language-option|dialog-choice|chat-cmd|yt-search|demo-/u;
    expect([...unreadable].filter((selector) => groupClasses.test(selector))).toEqual([]);
  });

  it('resolves the named role splits', () => {
    const markup = appMarkup();
    for (const { mount } of ROLE_SPOT_CHECKS) {
      if (!mount) continue;
      const anchor = markup.querySelector(mount[0]);
      expect(anchor, mount[0]).not.toBeNull();
      anchor!.insertAdjacentHTML('afterend', mount[1]);
    }
    const failures: string[] = [];
    for (const { selector, role, reason } of ROLE_SPOT_CHECKS) {
      expect(reason.length, selector).toBeGreaterThan(10);
      const elements = [...markup.querySelectorAll(selector)];
      expect(elements.length, selector).toBeGreaterThan(0);
      for (const element of elements) {
        const roles = resolvedRoles(element);
        if (roles.size !== 1 || !roles.has(role)) {
          failures.push(`${selector} ${element.outerHTML.slice(0, 80)}: ${[...roles]}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('gives every bold element in the app markup a role rule', () => {
    // Headings and <strong> are bold by the browser's own style; each one in
    // index.html takes its role from an app rule instead.
    const markup = appMarkup();
    const bold = [...markup.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, th')].filter(
      (element) => !element.closest('.sr-only'),
    );
    expect(bold.length).toBeGreaterThan(10);
    const unstyled = bold
      .filter((element) => {
        const own = ownRules(element).filter(({ rule }) => ruleWeights(rule).length > 0);
        return own.length === 0 || own.some(({ rule }) => ruleWeights(rule).includes(null));
      })
      .map((element) => element.outerHTML.slice(0, 80));
    expect(unstyled).toEqual([]);
  });

  it('renders bold elements from TypeScript and the translations only where a rule gives them a role', () => {
    const files = sourceFiles('src', (path) => /\/__tests__$|^src\/i18n$/u.test(path));
    const boldSources = files.filter((path) =>
      /createElement\(\s*['"](?:strong|b|h[1-6]|th)['"]\s*\)|<(?:strong|b|h[1-6]|th)[\s>]/u.test(
        read(path),
      ),
    );
    expect(boldSources.sort()).toEqual(Object.keys(BOLD_ELEMENT_SOURCES).sort());
    for (const [path, { selector, role }] of Object.entries(BOLD_ELEMENT_SOURCES)) {
      const rules = findRules(selector);
      expect(rules.flatMap(ruleWeights), path).toEqual([role]);
    }

    // Every translation that carries <strong> is a help block's HTML.
    const hosted = new Set(
      [...appMarkup().querySelectorAll(`${BOLD_HOSTS}[data-i18n-html]`)].map((element) =>
        element.getAttribute('data-i18n-html'),
      ),
    );
    expect(hosted.size).toBeGreaterThan(3);
    const strays: string[] = [];
    const locales = Object.entries(APP_DICTIONARIES);
    expect(locales.length).toBeGreaterThanOrEqual(42);
    for (const [locale, catalog] of locales) {
      for (const [key, value] of Object.entries(catalog)) {
        if (/<(?:strong|b|h[1-6]|th)[\s>]/u.test(value) && !hosted.has(key)) {
          strays.push(`${locale} ${key}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('sets no raw weight in TypeScript', () => {
    const files = sourceFiles('src', (path) => /\/__tests__$|^src\/i18n$/u.test(path));
    const tokenRead = new RegExp(
      `^var\\(--font-weight-(?:${WEIGHT_ROLES.join('|')})(?:,\\s*\\d{3})?\\)$`,
      'u',
    );
    const violations: string[] = [];
    for (const path of files) {
      const source = read(path);
      for (const match of source.matchAll(/font-weight\s*:\s*([^;'"`]+)/gu)) {
        if (!tokenRead.test(match[1]!.trim())) violations.push(`${path}: ${match[0]}`);
      }
      for (const match of source.matchAll(/fontWeight\s*[:=]\s*(['"`])(.*?)\1/gu)) {
        if (!tokenRead.test(match[2]!.trim())) violations.push(`${path}: ${match[0]}`);
      }
      for (const match of source.matchAll(/fontWeight\s*[:=]\s*\d/gu)) {
        violations.push(`${path}: ${match[0]}`);
      }
      // The font shorthand and canvas font strings may not lead with a weight.
      for (const match of source.matchAll(
        /\bfont\s*[:=]\s*(['"`])\s*(?:\d{3}|bold|bolder|lighter)\b/gu,
      )) {
        violations.push(`${path}: ${match[0]}`);
      }
      for (const match of source.matchAll(/["'`](?:\d{3}|bold)\s+\$?\{?[\w\s*.]*\}?\d*px\b/gu)) {
        violations.push(`${path}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
