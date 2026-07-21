import profanityPatterns from '../chat/profanity-patterns.generated.json';
import {
  ACCOUNT_NICKNAME_SANITIZE_RE,
  PRO_GENERATED_PEER_NAME_RE,
  RESERVED_NAMES,
} from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { AccountApiError } from './api.ts';
import { saveAccountNickname } from './session.ts';
import { isAccountAuthenticated } from './state.ts';

export const ACCOUNT_NICKNAME_MAX_CODE_POINTS = 12;

// Account nicknames only reject standalone English profanity. Chat moderation
// intentionally keeps its broader Korean-substring and English-word policy.
const ENGLISH_NICKNAME_PROFANITY_RE = profanityPatterns.accountEnglish
  ? new RegExp(profanityPatterns.accountEnglish, 'iu')
  : null;
const ACCOUNT_NICKNAME_WHITESPACE_RE = /\p{White_Space}/u;

function containsEnglishNicknameProfanity(value: string): boolean {
  return Boolean(ENGLISH_NICKNAME_PROFANITY_RE?.test(value));
}

export function normalizeAccountNickname(value: string): string {
  return value.normalize('NFC');
}

/**
 * Match the account service's compatibility/case-folded uniqueness key while
 * keeping the visible nickname in NFC. This key is validation-only on the
 * client; account/member IDs remain the authority for identity and access.
 */
function accountNicknameKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').normalize('NFC');
}

export const accountNicknameKeyForTests = accountNicknameKey;

export function validateAccountNickname(value: string): string | null {
  const nickname = normalizeAccountNickname(value);
  if (!nickname) return t('account.nickname_required');
  const nicknameKey = accountNicknameKey(nickname);
  if (
    ACCOUNT_NICKNAME_WHITESPACE_RE.test(nickname) ||
    ACCOUNT_NICKNAME_WHITESPACE_RE.test(nicknameKey)
  ) {
    return t('account.nickname_whitespace');
  }
  const sanitizedNickname = nickname.replace(ACCOUNT_NICKNAME_SANITIZE_RE, '');
  const sanitizedKey = accountNicknameKey(sanitizedNickname);
  if (sanitizedNickname !== nickname) {
    // Preserve the existing, explicit anti-impersonation message for visually
    // hidden characters inserted into a reserved identity such as HOST.
    if (RESERVED_NAMES.some((name) => sanitizedKey === accountNicknameKey(name))) {
      return t('connect.rename_reserved');
    }
    return t('account.nickname_required');
  }
  if (/^\p{M}+$/u.test(nickname)) return t('account.nickname_required');
  if (Array.from(nickname).length > ACCOUNT_NICKNAME_MAX_CODE_POINTS) {
    return t('account.nickname_hint');
  }
  if (
    RESERVED_NAMES.some((name) => nicknameKey === accountNicknameKey(name)) ||
    /^#\d+$/.test(nicknameKey) ||
    PRO_GENERATED_PEER_NAME_RE.test(nicknameKey)
  ) {
    return t('connect.rename_reserved');
  }
  if (containsEnglishNicknameProfanity(nicknameKey)) return t('connect.rename_profanity');
  return null;
}

export function isAccountNicknameTakenError(error: unknown): boolean {
  return (
    error instanceof AccountApiError && error.status === 409 && error.code === 'NICKNAME_TAKEN'
  );
}

export function accountNicknameMutationErrorMessage(error: unknown): string {
  if (isAccountNicknameTakenError(error)) return t('account.nickname_taken');
  return t('account.action_failed');
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
