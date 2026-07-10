/** Dependency-neutral transfer helpers shared by send and receive paths. */

/** Accept ArrayBuffers created in another JavaScript realm. */
export const isArrayBuffer = (v: unknown): v is ArrayBuffer =>
  v instanceof ArrayBuffer ||
  (v != null &&
    typeof v === 'object' &&
    Object.prototype.toString.call(v) === '[object ArrayBuffer]');
