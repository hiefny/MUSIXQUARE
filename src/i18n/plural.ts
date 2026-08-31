/**
 * Exhaustive plural-message catalog for tests and build-time audits.
 *
 * The browser runtime reads each named export from the matching lazy locale
 * module instead, so importing the i18n engine never pulls this aggregate
 * catalog into the production entry chunk.
 */

import { pluralMessages as ar } from './ar.ts';
import { pluralMessages as da } from './da.ts';
import { pluralMessages as de } from './de.ts';
import { pluralMessages as es } from './es.ts';
import { pluralMessages as fi } from './fi.ts';
import { pluralMessages as fr } from './fr.ts';
import { pluralMessages as gu } from './gu.ts';
import { pluralMessages as he } from './he.ts';
import { pluralMessages as hi } from './hi.ts';
import { pluralMessages as it } from './it.ts';
import { pluralMessages as kn } from './kn.ts';
import { pluralMessages as ml } from './ml.ts';
import { pluralMessages as mr } from './mr.ts';
import { pluralMessages as nb } from './nb.ts';
import { pluralMessages as nl } from './nl.ts';
import { pluralMessages as pa } from './pa.ts';
import { pluralMessages as pl } from './pl.ts';
import { pluralMessages as ptBr } from './pt-br.ts';
import { pluralMessages as ro } from './ro.ts';
import { pluralMessages as ru } from './ru.ts';
import { pluralMessages as sv } from './sv.ts';
import { pluralMessages as ta } from './ta.ts';
import { pluralMessages as te } from './te.ts';
import { pluralMessages as ur } from './ur.ts';
import type { LanguageCode } from './locales.ts';
import { EN_PLURAL_MESSAGES } from './plural-en.ts';
import type { LocalePluralMessages } from './plural-contract.ts';

export { PLURAL_PARAM_BY_KEY } from './plural-contract.ts';
export type { LocalePluralMessages, PluralCategory, PluralI18nKey } from './plural-contract.ts';

export const pluralMessagesForTests = {
  en: EN_PLURAL_MESSAGES,
  ar,
  da,
  de,
  es,
  fi,
  fr,
  gu,
  he,
  hi,
  it,
  kn,
  ml,
  mr,
  nb,
  nl,
  pa,
  pl,
  'pt-br': ptBr,
  ro,
  ru,
  sv,
  ta,
  te,
  ur,
} satisfies Partial<Record<LanguageCode, LocalePluralMessages>>;
