/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss, type Declaration } from 'postcss';
import { describe, expect, it } from 'vitest';

// The /events page keeps its own stylesheet. Owner rule (2026-10-29): text
// that appears because something happened and goes away on its own, or when
// that moment ends, reads at 600 like the app's label weight, and so do red
// error lines. Titles and buttons keep their weights, and text that is there
// whenever a step opens stays at the body weight.
const stylesheet = parseCss(readFileSync(resolve('public/events/event.css'), 'utf8'));
const page = (): Document =>
  new DOMParser().parseFromString(
    readFileSync(resolve('public/events/index.html'), 'utf8'),
    'text/html',
  );

interface WeightRule {
  selectors: string[];
  weight: string;
  order: number;
}

const weightRules: WeightRule[] = [];
stylesheet.walkRules((rule) => {
  const weights = rule.nodes.filter(
    (node): node is Declaration => node.type === 'decl' && node.prop === 'font-weight',
  );
  if (weights.length === 0) return;
  weightRules.push({
    selectors: rule.selectors.map((selector) => selector.replace(/\s+/gu, ' ').trim()),
    weight: weights.at(-1)!.value,
    order: weightRules.length,
  });
});

/** Specificity of a simple selector (ids, then classes, attributes and pseudo-classes, then types). */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/gu)?.length ?? 0;
  const types =
    selector.replace(/\[[^\]]*\]|::?[\w-]+|[#.][\w-]+/gu, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/giu)
      ?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

/** The weight an element renders at: the winning rule of its own, or its parent's. */
function weightOf(element: Element | null): string {
  if (!element) return '400';
  const own = weightRules
    .flatMap((rule) =>
      rule.selectors
        .filter((selector) => !selector.includes('::') && element.matches(selector))
        .map((selector) => ({ rule, specificity: specificity(selector) })),
    )
    .sort(
      (first, second) =>
        first.specificity - second.specificity || first.rule.order - second.rule.order,
    );
  return own.at(-1)?.rule.weight ?? weightOf(element.parentElement);
}

function weightIn(markup: Document, selector: string, classes: readonly string[] = []): string {
  const element = markup.querySelector(selector);
  expect(element, selector).not.toBeNull();
  element!.classList.add(...classes);
  return weightOf(element);
}

describe('/events page weights', () => {
  it('resolves the weights with simple selectors only', () => {
    // The resolver above reads no :is(), :not() or :where() arguments.
    const complex = weightRules.flatMap((rule) =>
      rule.selectors.filter((selector) => selector.includes('(')),
    );
    expect(complex).toEqual([]);
  });

  // The toast and the lines that come and go: the error lines and the line
  // under the title while the page checks the event.
  it.each<[string, readonly string[]]>([
    ['#toast', []],
    ['#login-message', []],
    ['#redeem-message', []],
    ['#nickname-message', ['is-error']],
    ["[data-step='loading'] .stage-copy > p", []],
  ])('reads %s at 600 %j', (selector, classes) => {
    expect(weightIn(page(), selector, classes)).toBe('600');
  });

  it.each<[string, string]>([
    ['#loading-title', '700'],
    ['#login-title', '700'],
    ['#nickname-title', '700'],
    ['#redeem-submit', '700'],
    ['#account-action-label', '500'],
    ['#login-description', '400'],
    ["[data-step='redeem'] .stage-copy > p", '400'],
    ['#notice-message', '400'],
  ])('keeps %s, a title, button or step description, at %s', (selector, weight) => {
    expect(weightIn(page(), selector)).toBe(weight);
  });
});
