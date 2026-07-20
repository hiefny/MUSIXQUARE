import { containsProfanity } from '../chat/profanity.ts';
import {
  DEVICE_LABEL_SANITIZE_RE,
  PRO_GENERATED_PEER_NAME_RE,
  RESERVED_NAMES,
} from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { saveAccountNickname } from './session.ts';
import { isAccountAuthenticated } from './state.ts';

export function normalizeAccountNickname(value: string): string {
  return value.replace(DEVICE_LABEL_SANITIZE_RE, '').trim().normalize('NFC');
}

export function validateAccountNickname(value: string): string | null {
  const nickname = normalizeAccountNickname(value);
  if (!nickname) return t('account.nickname_required');
  if (/^\p{M}+$/u.test(nickname)) return t('account.nickname_required');
  if (Array.from(nickname).length > 20) return t('chat.cmd_nick_too_long');
  if (
    RESERVED_NAMES.some((name) => nickname.toLowerCase() === name.toLowerCase()) ||
    /^#\d+$/.test(nickname) ||
    PRO_GENERATED_PEER_NAME_RE.test(nickname)
  ) {
    return t('connect.rename_reserved');
  }
  if (containsProfanity(nickname)) return t('connect.rename_profanity');
  return null;
}

export async function updateCurrentAccountNickname(value: string): Promise<string> {
  if (!isAccountAuthenticated()) throw new Error('ACCOUNT_LOGIN_REQUIRED');
  const validationError = validateAccountNickname(value);
  if (validationError) throw new Error(validationError);
  const nickname = normalizeAccountNickname(value);
  // Both standard and PRO rooms project account identity from a signed server
  // assertion. saveAccountNickname updates the account snapshot; its
  // subscriber refreshes the live assertion without ever sending the
  // browser-authored legacy rename frame.
  return (await saveAccountNickname(nickname)).nickname;
}
