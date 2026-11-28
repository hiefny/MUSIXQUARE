/**
 * Chat message length, shared by the composer and the send path.
 *
 * The chat wire contract counts UTF-16 code units, the way `String#length`
 * does: MAX_MSG_LENGTH in src/core/constants.ts, the receive paths in
 * src/chat/protocol.ts and the PRO signaling check
 * (`value.text.length > PRO_REALTIME_TEXT_MAX_LENGTH` in
 * cloudflare/signaling-protocol.ts). A common emoji costs 2 units and a
 * family emoji 11, so the composer shows a plain number and its copy never
 * promises "characters".
 *
 * The composer never edits what someone types to enforce the limit; it blocks
 * the send instead. Only text that the app itself inserts (a paste past
 * CHAT_PASTE_MAX_LENGTH) and the send path's last safety net are cut, and they
 * are cut here, on a grapheme boundary, so no emoji is left half sent.
 */

import { MAX_MSG_LENGTH } from '../core/constants.ts';

/** The composer's count appears and its gauge starts to fill 100 units before the limit. */
export const CHAT_LIMIT_WARN_START = MAX_MSG_LENGTH - 100;

/** A paste never grows the draft past this many UTF-16 units (four messages). */
export const CHAT_PASTE_MAX_LENGTH = MAX_MSG_LENGTH * 4;

/** Typing pause before the composer says, once, that a draft went over the limit. */
export const CHAT_LIMIT_ANNOUNCE_DELAY_MS = 1000;

/** True when the text cannot be sent: more UTF-16 units than the wire allows. */
export function isOverMessageLimit(text: string): boolean {
  return text.length > MAX_MSG_LENGTH;
}

/**
 * The text a send carries: the draft without the spaces and line breaks at
 * either end. It is one slice of the draft. The composer measures the limit on
 * it, so a space after the last word never holds back a message that fits.
 */
export function trimChatDraft(draft: string): string {
  return draft.trim();
}

let _segmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (_segmenter !== undefined) return _segmenter;
  try {
    _segmenter =
      typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  } catch {
    _segmenter = null;
  }
  return _segmenter;
}

const COMBINING_MARK = /^\p{M}$/u;

/** A code point that continues the cluster before it: a combining mark, the
 *  zero-width joiner, a variation selector, an emoji skin tone or an emoji tag. */
function continuesCluster(point: string): boolean {
  const code = point.codePointAt(0) ?? 0;
  return (
    COMBINING_MARK.test(point) ||
    code === 0x200d ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0020 && code <= 0xe007f)
  );
}

function isRegionalIndicator(point: string | undefined): boolean {
  const code = point?.codePointAt(0) ?? 0;
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/**
 * Engines without Intl.Segmenter (the Chrome 79 legacy target) cut on code
 * points and step back over an unfinished cluster: never before a combining
 * mark, joiner, selector or skin tone, never after a joiner, and never between
 * the two regional indicators of a flag.
 */
function fitByCodePoints(text: string, limit: number): string {
  const points: string[] = [];
  let units = 0;
  for (const point of text) {
    if (units + point.length > limit) break;
    points.push(point);
    units += point.length;
  }
  let next = text.slice(units, units + 2);
  next = next ? String.fromCodePoint(next.codePointAt(0)!) : '';
  for (;;) {
    const last = points[points.length - 1];
    if (last === undefined) break;
    let backOff = continuesCluster(next) || last === '\u200D';
    if (!backOff && isRegionalIndicator(next) && isRegionalIndicator(last)) {
      let run = 0;
      for (let index = points.length - 1; index >= 0; index -= 1) {
        if (!isRegionalIndicator(points[index])) break;
        run += 1;
      }
      backOff = run % 2 === 1;
    }
    if (!backOff) break;
    next = points.pop()!;
  }
  return points.join('');
}

/**
 * The longest start of `text` that keeps whole grapheme clusters and fits in
 * `limit` UTF-16 units. A cluster that does not fit is dropped whole.
 */
export function fitToMessageLength(text: string, limit: number = MAX_MSG_LENGTH): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  const segmenter = graphemeSegmenter();
  if (!segmenter) return fitByCodePoints(text, limit);
  let end = 0;
  for (const { index, segment } of segmenter.segment(text)) {
    const next = index + segment.length;
    if (next > limit) break;
    end = next;
  }
  return text.slice(0, end);
}

/** Test seam: run the code-point fallback as the Chrome 79 target does. */
export function fitToMessageLengthWithoutSegmenterForTests(text: string, limit: number): string {
  return text.length <= limit ? text : limit <= 0 ? '' : fitByCodePoints(text, limit);
}
