import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const eventStyles = readFileSync(resolve('public/events/event.css'), 'utf8');

function ruleDeclarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const body = eventStyles.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'mu'))?.[1];
  if (body === undefined) throw new Error(`Missing rule ${selector}`);
  return Object.fromEntries(
    body
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== ''),
  );
}

describe('event redeem code field', () => {
  // Owner report (2026-10-20): the hint sat low in Chromium, which places the
  // placeholder on the typed text's baseline. The empty field uses the hint's size.
  it('sizes the empty field like its hint so the hint stays centered', () => {
    const hint = ruleDeclarations('.redeem-input::placeholder');
    const empty = ruleDeclarations('.redeem-input:placeholder-shown');

    for (const property of ['font-size', 'font-weight', 'letter-spacing']) {
      expect(empty[property], property).toBe(hint[property]);
    }
    expect(ruleDeclarations('.redeem-input')['font-size']).toBe('clamp(17px, 5.2vw, 21px)');
  });
});
