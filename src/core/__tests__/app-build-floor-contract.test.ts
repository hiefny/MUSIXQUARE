import { describe, expect, it } from 'vitest';

import {
  APP_BUILD_FLOOR_REPORT_STALE_MS,
  APP_BUILD_HEADER,
  APP_BUILD_MAX,
  APP_UPDATE_REQUIRED_CODE,
  APP_UPDATE_REQUIRED_ERROR_TYPE,
  effectiveAppBuildFloor,
  isOptionalAppBuild,
  parseAppBuild,
} from '../../../cloudflare/app-build-floor-contract.ts';

describe('App build floor wire contract', () => {
  it('pins the wire names and bounds that every Worker, script and client share', () => {
    expect(APP_BUILD_HEADER).toBe('X-MXQR-App-Build');
    expect(APP_UPDATE_REQUIRED_CODE).toBe('APP_UPDATE_REQUIRED');
    expect(APP_UPDATE_REQUIRED_ERROR_TYPE).toBe('app-update-required');
    expect(APP_BUILD_MAX).toBe(2_147_483_647);
    expect(APP_BUILD_FLOOR_REPORT_STALE_MS).toBe(300_000);
  });

  it('accepts an absent or JSON-number build in a signaling auth frame and nothing else', () => {
    for (const value of [undefined, 0, -0, 1, 785, APP_BUILD_MAX]) {
      expect(isOptionalAppBuild(value), String(value)).toBe(true);
    }
    // Header text is the PRO form only; a frame carries a JSON number.
    for (const value of [
      '785',
      '0',
      null,
      -1,
      785.5,
      APP_BUILD_MAX + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      {},
      [785],
      785n,
    ]) {
      expect(isOptionalAppBuild(value), JSON.stringify(String(value))).toBe(false);
    }
  });

  it('accepts only safe integer builds within the wire range', () => {
    expect(parseAppBuild(0)).toBe(0);
    expect(Object.is(parseAppBuild(-0), 0)).toBe(true);
    expect(parseAppBuild(785)).toBe(785);
    expect(parseAppBuild(APP_BUILD_MAX)).toBe(APP_BUILD_MAX);
    for (const value of [
      -1,
      APP_BUILD_MAX + 1,
      785.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      null,
      undefined,
      true,
      {},
      [785],
      785n,
    ]) {
      expect(parseAppBuild(value), String(value)).toBeNull();
    }
  });

  it('accepts only canonical decimal header text', () => {
    expect(parseAppBuild('0')).toBe(0);
    expect(parseAppBuild('785')).toBe(785);
    expect(parseAppBuild(String(APP_BUILD_MAX))).toBe(APP_BUILD_MAX);
    for (const value of [
      '',
      ' 785',
      '785 ',
      '0785',
      '+785',
      '-1',
      '785.0',
      '7e2',
      '0x311',
      'v785',
      String(APP_BUILD_MAX + 1),
      '99999999999',
    ]) {
      expect(parseAppBuild(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('enforces the lower of the stored floor and a fresh live App report', () => {
    const nowMs = 1_800_000_000_000;
    expect(
      effectiveAppBuildFloor(
        { minAppBuild: 785, liveAppBuild: 786, liveReportedAt: nowMs - 1_000 },
        nowMs,
      ),
    ).toBe(785);
    expect(
      effectiveAppBuildFloor(
        { minAppBuild: 785, liveAppBuild: 784, liveReportedAt: nowMs - 1_000 },
        nowMs,
      ),
    ).toBe(784);
    expect(
      effectiveAppBuildFloor({ minAppBuild: 0, liveAppBuild: 785, liveReportedAt: nowMs }, nowMs),
    ).toBe(0);
  });

  it('turns itself off at the stale boundary, without a report, or for a future report', () => {
    const nowMs = 1_800_000_000_000;
    const floor = (liveReportedAt: number | null, liveAppBuild: number | null = 785) =>
      effectiveAppBuildFloor({ minAppBuild: 785, liveAppBuild, liveReportedAt }, nowMs);
    expect(floor(nowMs)).toBe(785);
    expect(floor(nowMs - APP_BUILD_FLOOR_REPORT_STALE_MS)).toBe(785);
    expect(floor(nowMs - APP_BUILD_FLOOR_REPORT_STALE_MS - 1)).toBe(0);
    expect(floor(nowMs + 1)).toBe(0);
    expect(floor(null)).toBe(0);
    expect(floor(nowMs, null)).toBe(0);
  });
});
