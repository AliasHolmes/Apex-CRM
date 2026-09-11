import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeDomainUrl, isPrivateOrInternalHost } from '../server/leadSearch/siteProbe.ts';

describe('site probe SSRF and private IP protection', () => {
  it('blocks localhost and loopback IPv4/IPv6 addresses', () => {
    assert.equal(isPrivateOrInternalHost('localhost'), true);
    assert.equal(isPrivateOrInternalHost('127.0.0.1'), true);
    assert.equal(isPrivateOrInternalHost('127.0.1.1'), true);
    assert.equal(isPrivateOrInternalHost('::1'), true);

    assert.equal(normalizeDomainUrl('http://localhost:4000/api'), null);
    assert.equal(normalizeDomainUrl('http://127.0.0.1:8080'), null);
    assert.equal(normalizeDomainUrl('https://127.0.0.1/status'), null);
  });

  it('blocks RFC 1918 private IPv4 networks', () => {
    assert.equal(isPrivateOrInternalHost('10.0.0.1'), true);
    assert.equal(isPrivateOrInternalHost('10.254.0.1'), true);
    assert.equal(isPrivateOrInternalHost('192.168.1.1'), true);
    assert.equal(isPrivateOrInternalHost('172.16.0.1'), true);
    assert.equal(isPrivateOrInternalHost('172.31.255.255'), true);

    assert.equal(normalizeDomainUrl('http://192.168.1.50/admin'), null);
    assert.equal(normalizeDomainUrl('http://10.0.1.5/'), null);
    assert.equal(normalizeDomainUrl('http://172.20.0.10:3000'), null);
  });

  it('blocks cloud instance metadata endpoints (169.254.169.254)', () => {
    assert.equal(isPrivateOrInternalHost('169.254.169.254'), true);
    assert.equal(normalizeDomainUrl('http://169.254.169.254/latest/meta-data'), null);
  });

  it('blocks IPv4-mapped IPv6 loopback and bracketed addresses (Finding 1)', () => {
    assert.equal(isPrivateOrInternalHost('[::ffff:127.0.0.1]'), true);
    assert.equal(isPrivateOrInternalHost('[::ffff:7f00:1]'), true);
    assert.equal(isPrivateOrInternalHost('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrInternalHost('::ffff:7f00:1'), true);
    assert.equal(isPrivateOrInternalHost('http://[::ffff:127.0.0.1]:34567/'), true);
    assert.equal(isPrivateOrInternalHost('http://[::ffff:7f00:1]:34567/'), true);

    assert.equal(normalizeDomainUrl('http://[::ffff:127.0.0.1]:34567/'), null);
    assert.equal(normalizeDomainUrl('http://[::ffff:7f00:1]:34567/'), null);
  });

  it('blocks IPv6 Unique Local Addresses (ULA) and Link-Local addresses', () => {
    assert.equal(isPrivateOrInternalHost('fc00::1'), true);
    assert.equal(isPrivateOrInternalHost('fd00::1'), true);
    assert.equal(isPrivateOrInternalHost('fd12::1'), true);
    assert.equal(isPrivateOrInternalHost('[fd00::1]'), true);

    assert.equal(isPrivateOrInternalHost('fe80::1'), true);
    assert.equal(isPrivateOrInternalHost('fe90::1'), true);
    assert.equal(isPrivateOrInternalHost('fea0::1'), true);
    assert.equal(isPrivateOrInternalHost('[fe80::1]'), true);

    assert.equal(normalizeDomainUrl('http://[fd00::1]:8080'), null);
    assert.equal(normalizeDomainUrl('http://[fe80::1]/status'), null);
  });

  it('blocks CGNAT, benchmarking, and broadcast ranges', () => {
    assert.equal(isPrivateOrInternalHost('100.64.0.1'), true);
    assert.equal(isPrivateOrInternalHost('100.127.255.254'), true);
    assert.equal(isPrivateOrInternalHost('198.18.0.1'), true);
    assert.equal(isPrivateOrInternalHost('0.0.0.0'), true);
    assert.equal(isPrivateOrInternalHost('255.255.255.255'), true);

    assert.equal(normalizeDomainUrl('http://100.64.0.1/'), null);
    assert.equal(normalizeDomainUrl('http://198.18.0.1:8080/'), null);
  });

  it('blocks internal/local domain names', () => {
    assert.equal(isPrivateOrInternalHost('service.internal'), true);
    assert.equal(isPrivateOrInternalHost('db.local'), true);
    assert.equal(isPrivateOrInternalHost('server.lan'), true);

    assert.equal(normalizeDomainUrl('https://service.internal'), null);
    assert.equal(normalizeDomainUrl('http://cluster.local'), null);
  });

  it('permits valid public company domains', () => {
    assert.equal(isPrivateOrInternalHost('stripe.com'), false);
    assert.equal(isPrivateOrInternalHost('apexlead.io'), false);

    assert.equal(normalizeDomainUrl('https://www.stripe.com/about'), 'https://stripe.com');
    assert.equal(normalizeDomainUrl('apexlead.io'), 'https://apexlead.io');
    assert.equal(normalizeDomainUrl('https://subdomain.company.co.uk/team'), 'https://subdomain.company.co.uk');
  });
});
