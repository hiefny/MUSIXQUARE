/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let aboutDocument: Document;
let aboutStyles: string;
let aboutRuntime: string;
let landingI18n: string;
let heroPng: Buffer;

beforeAll(() => {
  const source = readFileSync(resolve('.workshop/landing/landing.html'), 'utf8');
  aboutDocument = new DOMParser().parseFromString(source, 'text/html');
  aboutStyles = readFileSync(resolve('public/editorial-about.css'), 'utf8');
  aboutRuntime = readFileSync(resolve('.workshop/landing/main.ts'), 'utf8');
  landingI18n = readFileSync(resolve('browser/classic-runtime/landing-i18n.ts'), 'utf8');
  heroPng = readFileSync(resolve('public/landing/hero.png'));
});

describe('About page current UI contract', () => {
  it('uses the current portrait app capture in the hero phone', () => {
    expect(aboutDocument.querySelector('.lp-phone-3d__frame img')?.getAttribute('src')).toBe(
      '/landing/hero.png?cache=v480',
    );
    expect(heroPng.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(heroPng.readUInt32BE(16)).toBe(1179);
    expect(heroPng.readUInt32BE(20)).toBe(2556);
  });

  it('renders the current flat chat and rectangular pinned notice from first paint', () => {
    const chat = aboutDocument.querySelector('.lp-chat');

    expect(chat?.classList.contains('lp-chat--flat')).toBe(true);
    expect(aboutRuntime).not.toContain('initChatMorph');
    expect(aboutStyles).toMatch(
      /\.lp-chat--flat \.lp-chat-bubble\s*\{[^}]*border-radius:\s*var\(--radius-m\);/su,
    );
    expect(aboutStyles).toMatch(
      /\.lp-chat--flat \.lp-chat-bubble--pin\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/su,
    );
  });

  it('shows four synchronized peers without the generated example caption', () => {
    const peerRows = [...aboutDocument.querySelectorAll('.lp-sync__rows > div')];

    expect(peerRows.map((row) => row.querySelector('dt')?.textContent?.trim())).toEqual([
      'peer-1',
      'peer-2',
      'peer-3',
      'peer-4',
    ]);
    expect(aboutDocument.querySelector('[data-i18n="sync.meta"]')).toBeNull();
  });

  it('uses centered filled speaker glyphs instead of rounded wave strokes', () => {
    const standin = aboutDocument.querySelector('.lp-standin');
    const sounds = [...(standin?.querySelectorAll<SVGGElement>('.lp-standin__sound') ?? [])];

    expect(standin?.textContent).not.toContain('SILENT');
    expect(standin?.querySelector('.lp-standin__eq')).toBeNull();
    expect(sounds).toHaveLength(2);
    expect(sounds.map((sound) => sound.getAttribute('transform'))).toEqual([
      'translate(67 283) scale(2.1)',
      'translate(203 283) scale(2.1)',
    ]);
    expect(standin?.querySelectorAll('.lp-standin__sound-glyph')).toHaveLength(2);
    expect(standin?.querySelector('.lp-standin__speaker, .lp-standin__wave')).toBeNull();
    expect(aboutStyles).toMatch(
      /\.lp-standin__sound-glyph\s*\{[^}]*fill:\s*var\(--primary\);[^}]*stroke:\s*none;/su,
    );
  });

  it('keeps invite and footer geometry aligned with the current editorial shell', () => {
    expect(aboutStyles).toMatch(/\.lp-copy-link\s*\{[^}]*border-radius:\s*999px;/su);
    expect(aboutStyles).toMatch(
      /\.lp-footer\s*\{[^}]*max-width:\s*var\(--max-w\);[^}]*margin-inline:\s*auto;/su,
    );
    expect(aboutStyles).toMatch(/\.lp-footer__inner\s*\{[^}]*max-width:\s*none;/su);
  });

  it('keeps joining and synchronization copy neutral across room types', () => {
    expect(landingI18n).toContain("'code.h2': '여섯 자리 숫자만<br>있으면 돼요'");
    expect(landingI18n).toContain(
      '방을 열고 여섯 자리 숫자만 공유해요. 브라우저만 있으면 누구나 몇 초 안에 참여할 수 있어요.',
    );
    expect(landingI18n).toContain("'sync.h2': '네트워크를 넘어<br>프레임 단위로 정확하게'");
    expect(landingI18n).toContain('각 기기가 지연을 측정하고 칼같이 정렬해요.');
    expect(landingI18n).not.toMatch(
      /'(?:code\.lead|sync\.lead|sync\.transport_value)':\s*'[^']*\bPRO\b[^']*'/giu,
    );
    expect(aboutDocument.querySelector('[data-i18n="code.lead"]')?.textContent).not.toMatch(
      /\bPRO\b/iu,
    );
    expect(aboutDocument.querySelector('[data-i18n="sync.lead"]')?.textContent).not.toMatch(
      /\bPRO\b/iu,
    );
  });

  it('names the transmitting device in the Korean system-audio warning', () => {
    expect(landingI18n).toContain('송신 중인 기기를 포함해 최대 4대');
    expect(landingI18n).toContain('송신 중인 기기의 볼륨을 낮춰 주세요');
  });
});
