/**
 * @param {unknown} value
 * @param {readonly string[]} required
 * @param {readonly string[]} [optional]
 * @returns {value is Record<string, unknown>}
 */
export function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(/** @type {number} */ (value)) && /** @type {number} */ (value) >= 0;
}
