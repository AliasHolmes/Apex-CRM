/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ParsedHost = {
  hostname: string;
  port: number | null;
};

export type ServerCliArgs = {
  port?: number;
  host?: string;
};

export type HostValidationOptions = {
  allowedHosts?: Iterable<string>;
  allowCloudRun?: boolean;
  allowSameHost?: boolean;
  serverHost?: string;
};

export type OriginValidationOptions = {
  allowedOrigins?: Iterable<string>;
  allowedHosts?: Iterable<string>;
  allowCloudRun?: boolean;
  allowSameHost?: boolean;
  requestHost?: string;
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
 * Checks if a hostname belongs to Google Cloud Run (*.run.app).
 */
export function isCloudRunHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase().trim();
  return h === "run.app" || h.endsWith(".run.app");
}

/**
 * Parses CLI arguments to extract --port and --host flags.
 * Supports both `--flag value` and `--flag=value` syntax.
 */
export function parseServerCliArgs(argv: string[]): ServerCliArgs {
  const result: ServerCliArgs = {};
  if (!Array.isArray(argv)) {
    return result;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--port" || arg === "-p") {
      const nextVal = argv[i + 1];
      if (nextVal !== undefined && !nextVal.startsWith("-")) {
        const parsedPort = Number(nextVal);
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          result.port = parsedPort;
        }
        i++;
      }
    } else if (arg.startsWith("--port=") || arg.startsWith("-p=")) {
      const eqIdx = arg.indexOf("=");
      const valStr = arg.slice(eqIdx + 1);
      const parsedPort = Number(valStr);
      if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        result.port = parsedPort;
      }
    } else if (arg === "--host" || arg === "-h") {
      const nextVal = argv[i + 1];
      if (nextVal !== undefined && !nextVal.startsWith("-")) {
        const trimmed = nextVal.trim();
        if (trimmed) {
          result.host = trimmed;
        }
        i++;
      }
    } else if (arg.startsWith("--host=") || arg.startsWith("-h=")) {
      const eqIdx = arg.indexOf("=");
      const valStr = arg.slice(eqIdx + 1).trim();
      if (valStr) {
        result.host = valStr;
      }
    }
  }

  return result;
}

/**
 * Detects whether the server is running in a hosted environment.
 * Checks for existence of APP_URL or K_SERVICE (Google Cloud Run service env var).
 */
export function isHostedEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env) return false;
  const appUrl = env.APP_URL?.trim();
  const kService = env.K_SERVICE?.trim();
  return Boolean((appUrl && appUrl.length > 0) || (kService && kService.length > 0));
}

function extractHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.hostname.toLowerCase();
    } catch {
      // Fall through
    }
  }

  if (trimmed.startsWith("*.")) {
    return trimmed.toLowerCase();
  }

  const parsed = parseHostHeader(trimmed);
  if (parsed.hostname) {
    return parsed.hostname.toLowerCase();
  }

  return null;
}

/**
 * Parses APP_URL, ALLOWED_HOSTS, and ALLOWED_ORIGINS into a consolidated array of allowed host patterns.
 */
export function getConfiguredHostAllowlist(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!env) return [];
  const hosts = new Set<string>();

  const rawEntries: string[] = [];
  if (env.APP_URL) rawEntries.push(env.APP_URL);
  if (env.ALLOWED_HOSTS) rawEntries.push(env.ALLOWED_HOSTS);
  if (env.ALLOWED_ORIGINS) rawEntries.push(env.ALLOWED_ORIGINS);

  for (const raw of rawEntries) {
    const parts = raw.split(/[,;\s]+/);
    for (const part of parts) {
      const hostname = extractHostname(part);
      if (hostname) {
        hosts.add(hostname);
      }
    }
  }

  return Array.from(hosts);
}

/**
 * Checks if a hostname matches an allowlist entry (exact match or *.domain wildcard).
 */
export function matchesHostAllowlist(
  hostname: string,
  allowedHosts: Iterable<string>,
): boolean {
  const target = (hostname || "").toLowerCase().trim();
  if (!target) return false;

  for (const pattern of allowedHosts) {
    const p = (pattern || "").toLowerCase().trim();
    if (!p) continue;

    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      if (target.endsWith(suffix) && target.length > suffix.length) {
        return true;
      }
    } else if (target === p) {
      return true;
    }
  }

  return false;
}

/**
 * Validates Host header against expected PORT and local socket port for DNS rebinding protection.
 * In hosted environments, optional allowlist, same-host, and Cloud Run validation options are checked.
 * Loopback-only validation is preserved by default when no options are provided.
 */
export function isAllowedHost(
  rawHostHeader: string,
  expectedPort: number,
  localSocketPortOrOptions?: number | HostValidationOptions,
  options?: HostValidationOptions,
): boolean {
  let localSocketPort: number | undefined;
  let opts: HostValidationOptions | undefined;

  if (typeof localSocketPortOrOptions === "number") {
    localSocketPort = localSocketPortOrOptions;
    opts = options;
  } else if (
    typeof localSocketPortOrOptions === "object" &&
    localSocketPortOrOptions !== null
  ) {
    opts = localSocketPortOrOptions;
  } else {
    opts = options;
  }

  const { hostname, port } = parseHostHeader(rawHostHeader);
  if (!hostname) {
    return false;
  }

  if (isLoopbackHost(hostname)) {
    if (port !== null) {
      return port === expectedPort;
    }
    return (
      expectedPort === 80 ||
      expectedPort === 443 ||
      localSocketPort === expectedPort
    );
  }

  if (!opts) {
    return false;
  }

  const isCloudRun = Boolean(opts.allowCloudRun && isCloudRunHost(hostname));
  const isAllowlisted = Boolean(
    opts.allowedHosts && matchesHostAllowlist(hostname, opts.allowedHosts),
  );

  let isSameHost = false;
  if (opts.allowSameHost && opts.serverHost) {
    const parsedServer = parseHostHeader(opts.serverHost);
    if (parsedServer.hostname && hostname === parsedServer.hostname.toLowerCase()) {
      isSameHost = true;
    }
  }

  if (!isCloudRun && !isAllowlisted && !isSameHost) {
    return false;
  }

  if (port !== null) {
    return (
      port === expectedPort ||
      port === 80 ||
      port === 443 ||
      (localSocketPort !== undefined && port === localSocketPort)
    );
  }

  return true;
}

/**
 * Validates Origin header for CORS protection on API access.
 * In hosted environments, optional allowlist, same-host, and Cloud Run validation options are checked.
 * Loopback-only validation on expectedPort is preserved by default when no options are provided.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  expectedPort: number,
  options?: OriginValidationOptions,
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
    if (isLoopback && oPort === expectedPort) {
      return true;
    }

    if (!options) {
      return false;
    }

    if (options.allowedOrigins) {
      const normalizedOrigin = originUrl.origin.toLowerCase();
      for (const allowed of options.allowedOrigins) {
        if (!allowed) continue;
        const normAllowed = allowed.toLowerCase().trim();
        if (
          normAllowed === normalizedOrigin ||
          normAllowed === originHeader.toLowerCase().trim()
        ) {
          return true;
        }
      }
    }

    if (options.allowSameHost && options.requestHost) {
      const parsedReq = parseHostHeader(options.requestHost);
      if (parsedReq.hostname && oHost === parsedReq.hostname.toLowerCase()) {
        if (
          parsedReq.port === null ||
          oPort === parsedReq.port ||
          ((oPort === 80 || oPort === 443) &&
            (parsedReq.port === 80 || parsedReq.port === 443))
        ) {
          return true;
        }
      }
    }

    if (options.allowCloudRun && isCloudRunHost(oHost)) {
      return true;
    }

    if (options.allowedHosts && matchesHostAllowlist(oHost, options.allowedHosts)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
