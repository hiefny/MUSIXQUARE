import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('integrated borderless control surfaces', () => {
  it('owns the shared semantic state tokens in the core component stylesheet', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toContain('--control-active: rgba(var(--primary-rgb), 0.13);');
    expect(css).toContain('--control-danger: rgba(255, 59, 48, 0.09);');
    expect(css).toContain('--control-danger-hover: rgba(255, 59, 48, 0.13);');
    expect(css).toMatch(
      /html\[data-theme='light'\]\s*\{[^}]*--control-active:\s*rgba\(var\(--primary-rgb\), 0\.11\);[^}]*--control-danger:\s*rgba\(255, 59, 48, 0\.075\);[^}]*--control-danger-hover:\s*rgba\(255, 59, 48, 0\.11\);/u,
    );
  });

  it('uses the design-system surfaces directly for settings and demo choices', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /\.ch-opt\s*\{(?=[^}]*background:\s*var\(--surface-2\);)(?=[^}]*border:\s*2px solid transparent;)[^}]*\}/u,
    );
    expect(css).toMatch(
      /#tab-settings \.ch-opt:not\(\.active\):not\(\.selected\):hover,\s*#demo-overlay \.ch-opt\.demo-choice:not\(\.active\):not\(\.selected\):not\(\[aria-pressed='true'\]\):hover\s*\{[^}]*background:\s*var\(--surface-3\);/u,
    );
    expect(css).toMatch(
      /\.ch-opt\.active,\s*\.ch-opt\.selected,\s*#demo-overlay \.ch-opt\.demo-choice\[aria-pressed='true'\]\s*\{(?=[^}]*background:\s*var\(--control-active\);)(?=[^}]*border-color:\s*transparent;)(?=[^}]*color:\s*var\(--primary\);)(?=[^}]*box-shadow:\s*none;)[^}]*\}/u,
    );
  });

  it('keeps every guided-demo control family borderless with semantic states', async () => {
    const css = await readFile('css/style.css', 'utf8');

    expect(css).toMatch(
      /\.demo-role-segmented button\s*\{(?=[^}]*border:\s*none;)(?=[^}]*border-radius:\s*var\(--radius-s\);)(?=[^}]*background:\s*var\(--surface-2\);)[^}]*\}/u,
    );
    expect(css).toMatch(
      /\.demo-role-segmented button\[aria-pressed='true'\]\s*\{(?=[^}]*background:\s*var\(--control-active\);)(?=[^}]*color:\s*var\(--primary\);)[^}]*\}/u,
    );
    expect(css).toMatch(
      /\.demo-step-nav button\s*\{(?=[^}]*border:\s*1px solid transparent;)(?=[^}]*background:\s*var\(--surface-2\);)[^}]*\}/u,
    );
    expect(css).toMatch(
      /\.demo-step-nav button\.active\s*\{(?=[^}]*background:\s*var\(--control-active\);)(?=[^}]*border-color:\s*transparent;)(?=[^}]*color:\s*var\(--primary\);)[^}]*\}/u,
    );
    expect(css).toMatch(/\.accent-action-btn\s*\{[^}]*border:\s*none;/u);
    expect(css).toMatch(/\.leave-session-btn\s*\{[^}]*border:\s*none;/u);
    expect(css).toMatch(
      /\.demo-large-actions \.accent-action-btn\s*\{[^}]*background:\s*var\(--control-active\);/u,
    );
    expect(css).toMatch(
      /\.demo-large-actions \.leave-session-btn\s*\{[^}]*background:\s*var\(--control-danger\);/u,
    );
    expect(css).toMatch(
      /\.demo-large-actions \.leave-session-btn:hover\s*\{[^}]*background:\s*var\(--control-danger-hover\);/u,
    );
  });
});
