/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validates and normalizes raw input into a safe HTTP/HTTPS URL string.
 *
 * - Allows only http: and https: schemes.
 * - Auto-prefixes valid domain-like strings with https://.
 * - Strictly rejects whitespace, control characters, and non-HTTP schemes
 *   (e.g., javascript:, data:, vbscript:, file:).
 */
export function toSafeHttpUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  // Reject control characters (0x00-0x1F, 0x7F) and whitespace
  if (/[\s\x00-\x1F\x7F]/.test(raw)) {
    return null;
  }

  // Reject non-HTTP schemes (e.g. javascript:, data:, vbscript:, file:)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) {
      return null;
    }
  }

  let candidate = raw;

  if (!/^https?:\/\//i.test(candidate)) {
    if (candidate.startsWith('//')) {
      if (candidate.startsWith('///')) {
        return null;
      }
      const hostPart = candidate.slice(2).split(/[/?#]/)[0];
      const isDomainLike =
        hostPart === 'localhost' ||
        /^localhost:[0-9]+$/.test(hostPart) ||
        /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:[0-9]+)?$/.test(
          hostPart
        );
      if (!isDomainLike) {
        return null;
      }
      candidate = `https:${candidate}`;
    } else {
      const hostPart = candidate.split(/[/?#]/)[0];
      const isDomainLike =
        hostPart === 'localhost' ||
        /^localhost:[0-9]+$/.test(hostPart) ||
        /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:[0-9]+)?$/.test(
          hostPart
        );
      if (!isDomainLike) {
        return null;
      }
      candidate = `https://${candidate}`;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
