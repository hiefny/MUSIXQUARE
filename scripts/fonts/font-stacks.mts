/**
 * The app's font stacks as a browser resolves them on the document element,
 * read from the app stylesheets (css/app.css and the sheets it imports).
 *
 * The stacks live in custom properties on the root: --font-sans is the body's
 * font, and the html:lang(), dir and data-mxqr-han-order rules swap which
 * stack it reads. This module applies the CSS cascade to those root rules for
 * one document state (language, direction, attributes) and expands every
 * var(), so tests and scripts/check-app-font.mts can compare the stacks of
 * two UI languages family by family.
 *
 * Supported on purpose: root rules whose selector is one compound of html or
 * :root with attribute selectors and :lang(), in any cascade layer. A root
 * font property set in any other way (inside @media, say) throws, so a new
 * construct cannot slip past the comparison.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule, type Declaration, type Node, type Rule } from 'postcss';

import {
  fontCodePoints,
  openFontFile,
  parseFontFaceRules,
  parseUnicodeRange,
} from './font-files.mts';

export interface DocumentState {
  /** html lang. */
  readonly htmlLang: string;
  /** html dir; ltr when absent. */
  readonly dir?: 'ltr' | 'rtl';
  /** Other html attributes, such as data-mxqr-han-order. */
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface AppStyleRule {
  readonly sheet: string;
  /** The whole selector list, whitespace collapsed. */
  readonly selector: string;
  readonly selectors: readonly string[];
  /** The cascade layer, or null outside every layer. */
  readonly layer: string | null;
  /** The non-layer at-rules around the rule, outermost first. */
  readonly conditions: readonly string[];
  readonly rule: Rule;
}

export interface FontStacks {
  /** The app sheets in cascade order. */
  readonly sheets: readonly string[];
  /** Every style rule of the app sheets, in cascade order. */
  readonly rules: readonly AppStyleRule[];
  /** A root custom property with every var() expanded, or null when unset. */
  rootValue(state: DocumentState, property: string): string | null;
  /** The families of a font-family value under the root of `state`. */
  families(state: DocumentState, value: string): string[];
  /** The body's font: the families of --font-sans. */
  fontSans(state: DocumentState): string[];
}

/** The font stack properties whose root cascade this module applies (not the weight roles). */
const ROOT_FONT_PROPERTY = /^--font-(?!weight-)/u;

const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

interface Specificity {
  readonly ids: number;
  readonly classes: number;
  readonly types: number;
}

type RootCondition =
  | { readonly kind: 'lang'; readonly range: string }
  | { readonly kind: 'attribute'; readonly name: string; readonly value: string | null };

interface RootSelector {
  readonly conditions: readonly RootCondition[];
  readonly specificity: Specificity;
}

/**
 * A selector that targets the document element, or null for any other.
 * Throws on a root selector this module cannot evaluate.
 */
function parseRootSelector(selector: string): RootSelector | null {
  const match = /^(html|:root)((?:\[[^\]]+\]|:lang\([^)]+\))*)$/u.exec(selector);
  if (!match) {
    if (/^(?:html|:root)(?:$|[[:.])/u.test(selector) && !/[\s>+~]/u.test(selector)) {
      throw new Error(`Unsupported root selector for the font cascade: ${selector}`);
    }
    return null;
  }
  const conditions: RootCondition[] = [];
  let classes = match[1] === ':root' ? 1 : 0;
  const types = match[1] === 'html' ? 1 : 0;
  for (const part of (match[2] ?? '').matchAll(/\[([^\]]+)\]|:lang\(([^)]+)\)/gu)) {
    classes += 1;
    if (part[2] !== undefined) {
      conditions.push({ kind: 'lang', range: part[2].trim().replace(/^['"]|['"]$/gu, '') });
      continue;
    }
    const attribute = /^([\w-]+)(?:=(['"]?)([^'"]*)\2)?$/u.exec((part[1] ?? '').trim());
    if (!attribute?.[1]) throw new Error(`Unsupported attribute selector: ${selector}`);
    conditions.push({ kind: 'attribute', name: attribute[1], value: attribute[3] ?? null });
  }
  return { conditions, specificity: { ids: 0, classes, types } };
}

/** :lang() matching: a range matches its tag and every tag that extends it. */
function langMatches(tag: string, range: string): boolean {
  const lower = tag.toLowerCase();
  const wanted = range.toLowerCase();
  return lower === wanted || lower.startsWith(`${wanted}-`);
}

function matches(selector: RootSelector, state: DocumentState): boolean {
  return selector.conditions.every((condition) => {
    if (condition.kind === 'lang') return langMatches(state.htmlLang, condition.range);
    const actual =
      condition.name === 'dir'
        ? (state.dir ?? 'ltr')
        : condition.name === 'lang'
          ? state.htmlLang
          : state.attributes?.[condition.name];
    if (actual === undefined) return false;
    return condition.value === null || actual === condition.value;
  });
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left.ids - right.ids || left.classes - right.classes || left.types - right.types;
}

/** The sheets css/app.css imports, in order. */
function appSheets(repoRoot: string): string[] {
  const entry = readFileSync(path.join(repoRoot, 'css/app.css'), 'utf8');
  const sheets = [...entry.matchAll(/@import\s+['"]\.\/([^'"]+)['"]/gu)].map(
    (match) => `css/${match[1] ?? ''}`,
  );
  if (sheets.length === 0) throw new Error('css/app.css imports no sheet');
  return sheets;
}

function layerAndConditions(rule: Rule): { layer: string | null; conditions: string[] } {
  let layer: string | null = null;
  const conditions: string[] = [];
  for (
    let node: Node | undefined = rule.parent as Node | undefined;
    node;
    node = node.parent as Node | undefined
  ) {
    if (node.type !== 'atrule') continue;
    const atRule = node as AtRule;
    if (atRule.name === 'layer') {
      layer = layer === null ? atRule.params.trim() : `${atRule.params.trim()}.${layer}`;
    } else {
      conditions.unshift(`@${atRule.name} ${normalize(atRule.params)}`);
    }
  }
  return { layer, conditions };
}

/** Splits a value at its top-level commas. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const unquote = (family: string): string => family.replace(/^(['"])(.*)\1$/su, '$2');

interface RootDeclaration {
  readonly property: string;
  readonly value: string;
  readonly selector: RootSelector;
  readonly layerRank: number;
  readonly order: number;
}

export function readFontStacks(repoRoot: string): FontStacks {
  const sheets = appSheets(repoRoot);
  const roots = sheets.map((sheet) =>
    postcss.parse(readFileSync(path.join(repoRoot, sheet), 'utf8'), { from: sheet }),
  );

  // The first layer statement names the layer order; unlayered rules win.
  let layerOrder: string[] = [];
  for (const root of roots) {
    root.walkAtRules('layer', (atRule) => {
      if (!atRule.nodes && layerOrder.length === 0) {
        layerOrder = atRule.params.split(',').map((name) => name.trim());
      }
    });
  }

  const rules: AppStyleRule[] = [];
  const rootDeclarations: RootDeclaration[] = [];
  roots.forEach((root, index) => {
    const sheet = sheets[index] ?? '';
    root.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes$/u.test((rule.parent as AtRule).name)) {
        return;
      }
      const { layer, conditions } = layerAndConditions(rule);
      const selectors = rule.selectors.map(normalize);
      rules.push({ sheet, selector: selectors.join(', '), selectors, layer, conditions, rule });

      const fontDeclarations = rule.nodes.filter(
        (node): node is Declaration => node.type === 'decl' && ROOT_FONT_PROPERTY.test(node.prop),
      );
      if (fontDeclarations.length === 0) return;
      const parsed = selectors.map((selector) => parseRootSelector(selector));
      if (parsed.every((selector) => selector === null)) return;
      if (conditions.length > 0) {
        throw new Error(
          `${sheet}: ${selectors.join(', ')} sets a root font property under ${conditions.join(' > ')}`,
        );
      }
      const topLayer = layer?.split('.')[0] ?? null;
      const layerRank = topLayer === null ? layerOrder.length : layerOrder.indexOf(topLayer);
      if (layerRank < 0) throw new Error(`${sheet}: unknown cascade layer ${layer ?? ''}`);
      for (const selector of parsed) {
        if (!selector) continue;
        for (const declaration of fontDeclarations) {
          rootDeclarations.push({
            property: declaration.prop,
            value: normalize(declaration.value),
            selector,
            layerRank,
            order: rootDeclarations.length,
          });
        }
      }
    });
  });

  /** Cascade order: layer, then specificity, then source order. */
  const precedence = (left: RootDeclaration, right: RootDeclaration): number =>
    left.layerRank - right.layerRank ||
    compareSpecificity(left.selector.specificity, right.selector.specificity) ||
    left.order - right.order;

  function cascaded(state: DocumentState): Map<string, string> {
    const winners = new Map<string, RootDeclaration>();
    for (const declaration of rootDeclarations) {
      if (!matches(declaration.selector, state)) continue;
      const current = winners.get(declaration.property);
      if (!current || precedence(declaration, current) > 0) {
        winners.set(declaration.property, declaration);
      }
    }
    return new Map([...winners].map(([property, { value }]) => [property, value]));
  }

  function expand(value: string, values: ReadonlyMap<string, string>, seen: string[]): string {
    let result = '';
    let rest = value;
    for (;;) {
      const start = rest.indexOf('var(');
      if (start < 0) return result + rest;
      result += rest.slice(0, start);
      let depth = 0;
      let end = start + 3;
      for (; end < rest.length; end += 1) {
        if (rest[end] === '(') depth += 1;
        else if (rest[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const inner = rest.slice(start + 4, end);
      const comma = inner.indexOf(',');
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
      if (seen.includes(name))
        throw new Error(`Cyclic font property: ${[...seen, name].join(' -> ')}`);
      const own = values.get(name);
      if (own !== undefined) result += expand(own, values, [...seen, name]);
      else if (fallback !== null) result += expand(fallback, values, seen);
      else throw new Error(`${name} is not set on the root (${seen.join(' -> ') || 'value'})`);
      rest = rest.slice(end + 1);
    }
  }

  const rootValue = (state: DocumentState, property: string): string | null => {
    const values = cascaded(state);
    const own = values.get(property);
    return own === undefined ? null : normalize(expand(own, values, [property]));
  };

  const families = (state: DocumentState, value: string): string[] =>
    splitTopLevel(expand(value, cascaded(state), [])).map(unquote);

  return {
    sheets,
    rules,
    rootValue,
    families,
    fontSans: (state) => families(state, 'var(--font-sans)'),
  };
}

export interface FontSheetEntry {
  readonly path: string;
  readonly family: string;
}

export interface FaceChoice {
  readonly family: string;
  /** The face's file, relative to the repository root. */
  readonly file: string;
}

export interface FaceResolver {
  /**
   * The face that draws a code point in a stack: the first family with a face
   * whose unicode-range holds it and whose file has it in its cmap, the way
   * the browser falls back per character. Null when no declared face draws
   * it (a device font would).
   */
  faceFor(families: readonly string[], codePoint: number): FaceChoice | null;
}

/**
 * Loads every @font-face of the given sheets with its file's cmap, read one
 * file at a time (the WOFF2 decoder is not reentrant).
 */
export async function readFaceResolver(
  repoRoot: string,
  sheets: readonly FontSheetEntry[],
): Promise<FaceResolver> {
  const byFamily = new Map<string, Map<number, FaceChoice[]>>();
  const cmaps = new Map<string, ReadonlySet<number>>();
  for (const sheet of sheets) {
    const css = readFileSync(path.join(repoRoot, sheet.path), 'utf8');
    for (const rule of parseFontFaceRules(css)) {
      if (rule.family !== sheet.family) {
        throw new Error(`${sheet.path}: ${rule.file} declares ${rule.family}, not ${sheet.family}`);
      }
      if (!rule.unicodeRange) throw new Error(`${sheet.path}: ${rule.file} has no unicode-range`);
      const file = path.posix.normalize(path.posix.join(path.posix.dirname(sheet.path), rule.url));
      if (!cmaps.has(file)) {
        cmaps.set(file, fontCodePoints(await openFontFile(path.join(repoRoot, file))));
      }
      const index = byFamily.get(rule.family) ?? new Map<number, FaceChoice[]>();
      byFamily.set(rule.family, index);
      for (const codePoint of parseUnicodeRange(rule.unicodeRange)) {
        const faces = index.get(codePoint) ?? [];
        faces.push({ family: rule.family, file });
        index.set(codePoint, faces);
      }
    }
  }
  return {
    faceFor(families, codePoint) {
      for (const family of families) {
        for (const face of byFamily.get(family)?.get(codePoint) ?? []) {
          if (cmaps.get(face.file)?.has(codePoint)) return face;
        }
      }
      return null;
    },
  };
}
