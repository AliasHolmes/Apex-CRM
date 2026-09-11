import net from "node:net";

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
 * - Broadcast / Unspecified: 0.0.0.0/8, 255.255.255.255
 * - Internal TLDs: .local, .internal, .lan, .localhost
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

  // Strip enclosing brackets and leading www
  host = host.replace(/^\[|\]$/g, "").replace(/^www\./i, "");
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
    // 0.0.0.0/8 Unspecified
    if (b0 === 0) return true;
    // 255.255.255.255 Broadcast
    if (host === "255.255.255.255") return true;

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
