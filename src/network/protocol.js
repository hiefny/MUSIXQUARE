// @ts-check
/**
 * MUSIXQUARE 2.0 - Message Protocol Handler
 *
 * P2P 메시지 라우팅. 수신된 메시지를 타입별로 적절한 핸들러에 디스패치.
 * 1.0의 거대한 handleData() switch문을 테이블 기반으로 교체.
 *
 * Events consumed:
 *   peer:data - 모든 수신 메시지를 여기서 라우팅
 */

import { bus } from '../core/events.js';
import { MSG } from '../core/constants.js';
import { log } from '../core/log.js';

/**
 * @typedef {(data: any, conn: any) => void | Promise<void>} MessageHandler
 */

/** @type {Map<string, MessageHandler>} */
const handlers = new Map();

/**
 * Register a handler for a message type.
 * @param {string} type - Message type from MSG constants
 * @param {MessageHandler} handler
 */
export function onMessage(type, handler) {
  if (handlers.has(type)) {
    log.warn(`[Protocol] Overwriting handler for "${type}"`);
  }
  handlers.set(type, handler);
}

/**
 * Register multiple handlers at once.
 * @param {Record<string, MessageHandler>} map
 */
export function registerHandlers(map) {
  for (const [type, handler] of Object.entries(map)) {
    onMessage(type, handler);
  }
}

// Route incoming peer data to registered handlers
bus.on('peer:data', ({ data, conn }) => {
  if (!data || !data.type) {
    log.warn('[Protocol] Received message without type:', data);
    return;
  }

  const handler = handlers.get(data.type);
  if (handler) {
    try {
      const result = handler(data, conn);
      // Handle async handlers
      if (result && typeof result.catch === 'function') {
        result.catch(err => log.error(`[Protocol] Async handler error for "${data.type}":`, err));
      }
    } catch (err) {
      log.error(`[Protocol] Handler error for "${data.type}":`, err);
    }
  } else {
    log.debug(`[Protocol] No handler for message type: "${data.type}"`);
  }
});
