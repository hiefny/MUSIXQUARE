import { describe, it, expect } from 'vitest';
import ko from '../ko.ts';
import en from '../en.ts';

const koKeys = Object.keys(ko);
const enKeys = Object.keys(en);

describe('Translation key integrity', () => {
  it('ko and en have the same number of keys', () => {
    expect(koKeys.length).toBe(enKeys.length);
  });

  it('every ko key exists in en', () => {
    const missingInEn = koKeys.filter(k => !(k in en));
    expect(missingInEn).toEqual([]);
  });

  it('every en key exists in ko', () => {
    const missingInKo = enKeys.filter(k => !(k in ko));
    expect(missingInKo).toEqual([]);
  });

  it('no empty values in ko', () => {
    const emptyKo = koKeys.filter(k => !ko[k as keyof typeof ko]);
    expect(emptyKo).toEqual([]);
  });

  it('no empty values in en', () => {
    const emptyEn = enKeys.filter(k => !en[k as keyof typeof en]);
    expect(emptyEn).toEqual([]);
  });

  it('{{param}} placeholders match between ko and en', () => {
    const paramRe = /\{\{(\w+)\}\}/g;
    const mismatched: string[] = [];

    for (const key of koKeys) {
      const koVal = ko[key as keyof typeof ko] || '';
      const enVal = en[key as keyof typeof en] || '';

      const koParams = [...koVal.matchAll(paramRe)].map(m => m[1]).sort();
      const enParams = [...enVal.matchAll(paramRe)].map(m => m[1]).sort();

      if (JSON.stringify(koParams) !== JSON.stringify(enParams)) {
        mismatched.push(`${key}: ko=${koParams.join(',')} en=${enParams.join(',')}`);
      }
    }

    expect(mismatched).toEqual([]);
  });
});
