import { describe, expect, it } from 'vitest';

import { resolveHanOrder } from '../startup-han-order.ts';

describe('startup Han order', () => {
  it.each([
    [['ko-KR', 'ja-JP', 'en-US'], 'ko'],
    [['en-US', 'ko'], 'ko'],
    [['ja-JP', 'ko-KR'], 'ja'],
    [['en-US', 'ja'], 'ja'],
    [['zh-CN', 'ko-KR'], 'zh-hans'],
    [['zh-Hans'], 'zh-hans'],
    [['zh-Hans-CN'], 'zh-hans'],
    [['zh-Hans-SG'], 'zh-hans'],
    [['zh-TW'], 'zh-hant'],
    [['zh-HK'], 'zh-hant'],
    [['zh-Hant'], 'zh-hant'],
    [['zh-Hant-TW'], 'zh-hant'],
    [['fr-FR', 'zh-tw', 'ja'], 'zh-hant'],
  ] as const)('takes the first Korean, Japanese or Chinese tag of %j', (languages, order) => {
    expect(resolveHanOrder(languages)).toBe(order);
  });

  it('defaults to Korean when the list names none of them', () => {
    expect(resolveHanOrder(['en-US', 'fr-FR'])).toBe('ko');
    expect(resolveHanOrder([])).toBe('ko');
    expect(resolveHanOrder([''])).toBe('ko');
  });

  it('ignores case and accepts underscores', () => {
    expect(resolveHanOrder(['JA-jp'])).toBe('ja');
    expect(resolveHanOrder(['ZH-HANT'])).toBe('zh-hant');
    expect(resolveHanOrder(['zh_CN'])).toBe('zh-hans');
  });

  it('matches whole subtags only', () => {
    // Konkani and Jamaican Creole are not Korean or Japanese.
    expect(resolveHanOrder(['kok-IN', 'jam'])).toBe('ko');
    expect(resolveHanOrder(['kok-IN', 'jam', 'ja'])).toBe('ja');
  });

  it('treats tags outside the decided list as not found', () => {
    // Bare zh and zh-SG / zh-MO are not in the decided list (owner question).
    expect(resolveHanOrder(['zh', 'ja'])).toBe('ja');
    expect(resolveHanOrder(['zh-SG'])).toBe('ko');
    expect(resolveHanOrder(['zh-MO'])).toBe('ko');
  });
});
