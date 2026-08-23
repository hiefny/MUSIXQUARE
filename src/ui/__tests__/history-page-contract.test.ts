/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let historyDocument: Document;
let historySource: string;
let historyStyles: string;

beforeAll(() => {
  historySource = readFileSync(resolve('public/history/index.html'), 'utf8');
  historyStyles = readFileSync(resolve('public/editorial-history.css'), 'utf8');
  historyDocument = new DOMParser().parseFromString(historySource, 'text/html');
});

describe('public history page contract', () => {
  it('keeps timeline sections on the shared editorial content rail', () => {
    expect(historyStyles).toMatch(
      /\.editorial-history\s+\.page\s*>\s*\.section\s*\{[^}]*max-width:\s*calc\(1240px\s*-\s*var\(--pad-x\)\s*-\s*var\(--pad-x\)\)[^}]*margin-inline:\s*auto/iu,
    );
  });

  it('keeps status labels and phase decorations out of the timeline', () => {
    const visibleCopy = historyDocument.body.textContent ?? '';

    expect(
      historyDocument.querySelector('.section-head .phase, .phase-tag, .a-tag, .w-tag'),
    ).toBeNull();
    expect(visibleCopy).not.toMatch(
      /\b(?:Phase 0[1-3]|Upcoming|Won't fix|Live|Planned|Not ours|Next|Gated|Later)\b/u,
    );
  });

  it('uses plain punctuation instead of em or en dashes', () => {
    expect(historySource).not.toMatch(/[—–]/u);
  });

  it('uses one plain introduction followed by one consistent vertical log', () => {
    const sections = [...historyDocument.querySelectorAll<HTMLElement>('main > .section')];
    const surfaceRule = historyStyles.match(
      /\.editorial-history\s+:is\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/u,
    );

    expect(sections).toHaveLength(6);
    expect(sections.every((section) => section.querySelector(':scope > .section-copy'))).toBe(true);
    expect(sections.every((section) => section.querySelector(':scope > .log'))).toBe(true);
    expect(
      historyDocument.querySelector(
        '.history-card, .phase-meta, .phase-sub, .milestone, .infra-grid, .infra-card, .ahead-list, .ahead-item, .wall-list, .wall-item',
      ),
    ).toBeNull();
    expect(surfaceRule).toBeTruthy();
    expect(surfaceRule?.[1]).toContain('.history-stat-card');
    expect(surfaceRule?.[1]).toContain('.log li');
    expect(surfaceRule?.[2]).toMatch(/border:\s*0;/u);
    expect(surfaceRule?.[2]).toMatch(/border-radius:\s*var\(--radius-m\);/u);
    expect(surfaceRule?.[2]).toMatch(/box-shadow:\s*none;/u);
    expect(historyStyles).not.toMatch(/translateY\(-2px\)/u);
  });

  it('keeps the launch and infrastructure entries at the same hierarchy as the timeline', () => {
    const ship = historyDocument.getElementById('ship');
    const shipLeads = [...(ship?.querySelectorAll('.log .lead') ?? [])].map((lead) =>
      lead.textContent?.trim(),
    );
    const infrastructure = [...historyDocument.querySelectorAll('main > .section')].find(
      (section) => section.querySelector('h2')?.textContent?.trim() === 'Current infrastructure',
    );

    expect(shipLeads.slice(-2)).toEqual(['Cloudflare WebRTC signaling', 'Product Hunt launch']);
    expect(infrastructure?.querySelectorAll('.log > li')).toHaveLength(3);
    expect(infrastructure?.querySelector('.infra-card')).toBeNull();
  });

  it('uses current factual copy for infrastructure and future work', () => {
    const visibleCopy = historyDocument.body.textContent ?? '';

    expect(visibleCopy).toContain('STUN-only direct path');
    expect(visibleCopy).toContain(
      'D1 stores account, PRO registry, grant, metrics and Developer API records.',
    );
    expect(visibleCopy).toContain('persistent private PRO media');
    expect(visibleCopy).toContain('production hosts do not fall back to it');
    expect(visibleCopy).not.toContain('license flow');
    expect(visibleCopy).not.toContain('Metered kept as a fallback');
  });

  it('publishes concise metadata and a dated timeline summary', () => {
    expect(historyDocument.title).toBe('History | MUSIXQUARE');
    expect(historyDocument.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'MUSIXQUARE development history from the first Web Audio prototype in August 2025 to its May 2026 launch and current architecture.',
    );
    expect(
      [...historyDocument.querySelectorAll('.history-stat-value')].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(['Aug 2025', 'Jan 2026', 'May 2026', 'Today']);
  });
});
