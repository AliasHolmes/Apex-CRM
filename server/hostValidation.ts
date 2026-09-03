/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ParsedHost = {
  hostname: string;
  port: number | null;
};

/**
 * Parses raw Host header into lowercase hostname and optional port.
 * Handles IPv6 bracketed hosts (e.g. `[::1]:3000` or `[::1]`) and IPv4/domain hosts.
 */
export function parseHostHeader(rawHostHeader: string): ParsedHost {
  const rawHost = (rawHostHeader || "").toLowerCase().trim();
  let hostname = "";
  let portStr = "";

  if (rawHost.startsWith("[")) {
    const closeBracketIdx = rawHost.indexOf("]");
    if (closeBracketIdx !== -1) {
      hostname = rawHost.slice(0, closeBracketIdx + 1);
      if (rawHost.charAt(closeBracketIdx + 1) === ":") {
        portStr = rawHost.slice(closeBracketIdx + 2);
      }
    } else {
      hostname = rawHost;
    }
  } else {
    const colonIdx = rawHost.lastIndexOf(":");
    const firstColonIdx = rawHost.indexOf(":");
    if (colonIdx !== -1 && colonIdx === firstColonIdx) {
      hostname = rawHost.slice(0, colonIdx);
      portStr = rawHost.slice(colonIdx + 1);
    } else {
      hostname = rawHost;
    }
  }

  const parsedPort = portStr ? Number(portStr) : null;
  return {
    hostname,
    port: Number.isFinite(parsedPort) && parsedPort !== null && parsedPort > 0 ? parsedPort : null,
  };
}

/**
 * Checks if a hostname corresponds to loopback (localhost, 127.0.0.1, or IPv6 ::1 / [::1]).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase().trim();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Validates Host header against expected PORT and local socket port for DNS rebinding protection.
 */
export function isAllowedHost(
  rawHostHeader: string,
  expectedPort: number,
  localSocketPort?: number,
): boolean {
  const { hostname, port } = parseHostHeader(rawHostHeader);
  if (!isLoopbackHost(hostname)) {
    return false;
  }

  if (port !== null) {
    return port === expectedPort;
  }

  return expectedPort === 80 || expectedPort === 443 || localSocketPort === expectedPort;
}

/**
 * Validates Origin header for CORS protection on loopback API access.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  expectedPort: number,
): boolean {
  if (!originHeader) return true;
  try {
    const originUrl = new URL(originHeader);
    const oHost = originUrl.hostname.toLowerCase();
    const oPort = originUrl.port
      ? Number(originUrl.port)
      : originUrl.protocol === "https:"
        ? 443
        : 80;
    const isLoopback = isLoopbackHost(oHost);
    return isLoopback && oPort === expectedPort;
  } catch {
    return false;
  }
}
