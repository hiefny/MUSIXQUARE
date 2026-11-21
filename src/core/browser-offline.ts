/**
 * The browser's own report that this device has no network.
 *
 * navigator.onLine only describes the network interfaces: WebKit can keep it
 * false after its radio has recovered, and a network without internet access
 * reads as online. So it is read only where a failure is already being
 * handled, to choose the words for that failure, and never to block or skip
 * an attempt that might work.
 */
export function isBrowserReportedOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
