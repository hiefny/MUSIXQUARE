import profanityPatterns from '../chat/profanity-patterns.generated.json';
import {
  ACCOUNT_NICKNAME_SANITIZE_RE,
  PRO_GENERATED_PEER_NAME_RE,
  RESERVED_NAMES,
} from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { saveAccountNickname } from './session.ts';
import { isAccountAuthenticated } from './state.ts';

export const ACCOUNT_NICKNAME_MAX_CODE_POINTS = 12;

// Account nicknames only reject standalone English profanity. Chat moderation
// intentionally keeps its broader Korean-substring and English-word policy.
const ENGLISH_NICKNAME_PROFANITY_RE = profanityPatterns.accountEnglish
  ? new RegExp(profanityPatterns.accountEnglish, 'iu')
  : null;

function containsEnglishNicknameProfanity(value: string): boolean {
  return Boolean(ENGLISH_NICKNAME_PROFANITY_RE?.test(value));
}

export function normalizeAccountNickname(value: string): string {
  return value.replace(ACCOUNT_NICKNAME_SANITIZE_RE, '').trim().normalize('NFC');
}

export function validateAccountNickname(value: string): string | null {
  const nickname = normalizeAccountNickname(value);
  if (!nickname) return t('account.nickname_required');
  if (/^\p{M}+$/u.test(nickname)) return t('account.nickname_required');
  if (Array.from(nickname).length > ACCOUNT_NICKNAME_MAX_CODE_POINTS) {
    return t('account.nickname_hint');
  }
  if (
    RESERVED_NAMES.some((name) => nickname.toLowerCase() === name.toLowerCase()) ||
    /^#\d+$/.test(nickname) ||
    PRO_GENERATED_PEER_NAME_RE.test(nickname)
  ) {
    return t('connect.rename_reserved');
  }
  if (containsEnglishNicknameProfanity(nickname)) return t('connect.rename_profanity');
  return null;
}

export async function updateCurrentAccountNickname(value: string): Promise<string> {
  if (!isAccountAuthenticated()) throw new Error('ACCOUNT_LOGIN_REQUIRED');
  const validationError = validateAccountNickname(value);
  if (validationError) throw new Error(validationError);
  const nickname = normalizeAccountNickname(value);
  // Both standard and PRO rooms project account identity from a signed server
  // assertion. saveAccountNickname updates the account snapshot; its
  // subscriber refreshes the live assertion.
  return (await saveAccountNickname(nickname)).nickname;
}
