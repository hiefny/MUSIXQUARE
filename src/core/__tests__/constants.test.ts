import { describe, it, expect } from 'vitest';
import { MAX_MSG_LENGTH, MAX_SENDER_LABEL_LENGTH } from '../constants.ts';

/**
 * Wire-contract test: the chat caps are a cross-client
 * truncation contract — deployed clients ship these exact values, and
 * sender-side (network/sync.ts OP /notice) and receiver-side
 * (chat/protocol.ts) truncation must agree. A "while we're here" value tweak
 * desyncs truncation between updated and deployed clients. If you really
 * need to change them, that is a protocol migration, not a constant edit.
 */
describe('chat wire caps (cross-client wire contract)', () => {
  it('keeps MAX_MSG_LENGTH at exactly 500', () => {
    expect(MAX_MSG_LENGTH).toBe(500);
  });

  it('keeps MAX_SENDER_LABEL_LENGTH at exactly 30', () => {
    expect(MAX_SENDER_LABEL_LENGTH).toBe(30);
  });
});
