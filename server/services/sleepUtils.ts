/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical abort-aware sleep utility. Rejects immediately with an AbortError
 * when the signal fires, cleaning up timeouts and listeners properly.
 */
export function abortableSleep(
  delayMs: number,
  signal?: AbortSignal | null,
  defaultMessage = "Operation was aborted.",
): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) {
    const error = new Error(defaultMessage);
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, delayMs);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        const error = new Error(defaultMessage);
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
