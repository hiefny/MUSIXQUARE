/**
 * Complete translation catalog for build-time rendering and exhaustive tests.
 *
 * The browser runtime deliberately keeps using lazy imports from `index.ts` so
 * adding locales here never folds every dictionary into the initial app bundle.
 */

import ar from './ar.ts';
import bg from './bg.ts';
import bn from './bn.ts';
import cs from './cs.ts';
import da from './da.ts';
import de from './de.ts';
import el from './el.ts';
import en from './en.ts';
import es from './es.ts';
import fa from './fa.ts';
import fi from './fi.ts';
import fil from './fil.ts';
import fr from './fr.ts';
import gu from './gu.ts';
import he from './he.ts';
import hi from './hi.ts';
import hu from './hu.ts';
import id from './id.ts';
import it from './it.ts';
import ja from './ja.ts';
import kn from './kn.ts';
import ko from './ko.ts';
import ml from './ml.ts';
import mr from './mr.ts';
import ms from './ms.ts';
import nb from './nb.ts';
import nl from './nl.ts';
import pa from './pa.ts';
import pl from './pl.ts';
import ptBr from './pt-br.ts';
import ro from './ro.ts';
import ru from './ru.ts';
import sv from './sv.ts';
import ta from './ta.ts';
import te from './te.ts';
import th from './th.ts';
import tr from './tr.ts';
import uk from './uk.ts';
import ur from './ur.ts';
import vi from './vi.ts';
import zhHans from './zh-hans.ts';
import zhHant from './zh-hant.ts';

import type { LanguageCode } from './locales.ts';

export type TranslationDictionary = Readonly<Record<string, string>>;

export const APP_DICTIONARIES = {
  ar,
  bg,
  bn,
  cs,
  da,
  de,
  el,
  en,
  es,
  fa,
  fi,
  fil,
  fr,
  gu,
  he,
  hi,
  hu,
  id,
  it,
  ja,
  kn,
  ko,
  ml,
  mr,
  ms,
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
  th,
  tr,
  uk,
  ur,
  vi,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
} as const satisfies Readonly<Record<LanguageCode, TranslationDictionary>>;
