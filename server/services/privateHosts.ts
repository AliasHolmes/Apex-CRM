import net from "node:net";

/** Expand a 32-bit integer into dotted-quad form, or null when out of range. */
function intToDottedQuad(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

/**
 * Canonicalise the numeric IPv4 literals that resolvers accept but `net.isIP()`
 * rejects: bare decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`)
 * and the shortened dotted forms (`127.1`). These are standard SSRF filter
 * bypasses - `2130706433` and `127.1` both resolve to 127.0.0.1.
 *
 * Returns a dotted-quad string, or null when the input is not a numeric host
 * (i.e. it is a real DNS name and must be left alone).
 */
function normalizeNumericHost(host: string): string | null {
  if (/^0x[0-9a-f]+$/i.test(host)) {
    return intToDottedQuad(Number.parseInt(host.slice(2), 16));
  }
  if (/^\d+$/.test(host)) {
    return intToDottedQuad(Number.parseInt(host, 10));
  }

  const parts = host.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((part) => /^(?:0x[0-9a-f]+|\d+)$/i.test(part))) return null;

  // inet_aton semantics: a leading `0x` means hex, a leading `0` means octal.
  const values = parts.map((part) =>
    /^0x/i.test(part)
      ? Number.parseInt(part.slice(2), 16)
      : /^0\d/.test(part)
        ? Number.parseInt(part, 8)
        : Number.parseInt(part, 10),
  );
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;

  if (parts.length === 4) {
    return values.some((value) => value > 255) ? null : values.join('.');
  }

  // Fewer than four parts: the final part carries all remaining bytes.
  const leading = values.slice(0, -1);
  const last = values[values.length - 1];
  if (leading.some((value) => value > 255)) return null;
  const remainingBytes = 4 - leading.length;
  if (last >= 256 ** remainingBytes) return null;
  const lastBytes: number[] = [];
  for (let i = remainingBytes - 1; i >= 0; i--) {
    lastBytes.push((last >> (8 * i)) & 0xff);
  }
  return [...leading, ...lastBytes].join('.');
}

/**
 * Checks whether a given host or URL points to a private, loopback, link-local,
 * or otherwise internal/reserved network destination.
 *
 * Covers:
 * - Loopback: 127.0.0.0/8, ::1, [::ffff:127.0.0.1], [::ffff:7f00:1]
 * - RFC 1918 Private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Link-Local / Metadata: 169.254.0.0/16, fe80::/10
 * - ULA: fc00::/7 (fc00:: - fdff::)
 * - Carrier-Grade NAT (CGNAT): 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
 * - Benchmark: 198.18.0.0/15 (198.18.0.0 - 198.19.255.255)
 * - Multicast 224.0.0.0/4, Reserved 240.0.0.0/4, IETF protocol 192.0.0.0/24
 * - Broadcast / Unspecified: 0.0.0.0/8, 255.255.255.255
 * - Internal TLDs: .local, .internal, .lan, .localhost
 * - Non-canonical numeric IPv4 literals (decimal / hex / octal / shortened)
 * - Fully-qualified names with a trailing root dot (`localhost.`, `127.0.0.1.`)
 */
export function isPrivateOrInternalHost(input: string): boolean {
  if (!input || typeof input !== "string") return true;

  let host = input.trim().toLowerCase();
  // If a full URL was provided, extract the hostname safely
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return true;
    }
  }

  // Strip enclosing brackets, leading www, and a trailing root dot. The root dot
  // matters: `localhost.` and `127.0.0.1.` are the same destinations as their
  // dotless forms but failed every string comparison below.
  host = host.replace(/^\[|\]$/g, "").replace(/^www\./i, "").replace(/\.$/, "");
  if (!host) return true;

  // Domain name / internal suffix checks
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  // Unpack IPv4-mapped IPv6 addresses: e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (host.startsWith("::ffff:")) {
    const remainder = host.slice(7);
    if (net.isIPv4(remainder)) {
      host = remainder;
    } else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(remainder)) {
      const [h1, h2] = remainder.split(":").map((part) => parseInt(part, 16));
      host = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
    }
  }

  // Canonicalise non-standard numeric IPv4 literals before the range checks so
  // `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` are recognised as
  // loopback rather than sailing through as "not an IP".
  const canonicalNumeric = normalizeNumericHost(host);
  if (canonicalNumeric) host = canonicalNumeric;

  const ipFamily = net.isIP(host);
  if (ipFamily === 4) {
    const parts = host.split(".").map(Number);
    const [b0, b1] = parts;
    // 127.0.0.0/8 Loopback
    if (b0 === 127) return true;
    // 10.0.0.0/8 RFC 1918 Private
    if (b0 === 10) return true;
    // 172.16.0.0/12 RFC 1918 Private (172.16 - 172.31)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 RFC 1918 Private
    if (b0 === 192 && b1 === 168) return true;
    // 169.254.0.0/16 Link-local / Cloud metadata (169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // 100.64.0.0/10 Carrier-Grade NAT (100.64 - 100.127)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // 198.18.0.0/15 Benchmarking (198.18 - 198.19)
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    // 192.0.0.0/24 IETF protocol assignments
    if (b0 === 192 && b1 === 0) return true;
    // 224.0.0.0/4 Multicast
    if (b0 >= 224 && b0 <= 239) return true;
    // 240.0.0.0/4 Reserved, including 255.255.255.255 broadcast
    if (b0 >= 240) return true;
    // 0.0.0.0/8 Unspecified
    if (b0 === 0) return true;

    return false;
  }

  if (ipFamily === 6) {
    if (host === "::1" || host === "::") return true;
    // Unique Local Addresses (ULA): fc00::/7 (covers fc00:: through fdff::)
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    // Link-Local: fe80::/10 (covers fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

    return false;
  }

  return false;
}
