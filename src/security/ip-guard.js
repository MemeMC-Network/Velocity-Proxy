import dns from 'node:dns/promises';
import net from 'node:net';
import { blocked, badRequest } from '../errors.js';
import { config } from '../config.js';

/**
 * SSRF protection.
 *
 * Two layers:
 *  - every navigation target is validated (protocol, credentials, DNS result)
 *  - every Chromium request is routed through checkRequestUrl() so a page
 *    cannot pivot from a public host to loopback/metadata addresses.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'localhost6',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet'];

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const ipv4ToInt = (ip) => {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
};

const intToIpv4 = (value) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

const isPrivateV4 = (ip) => {
  const value = ipv4ToInt(ip);
  if (value == null) return true;
  return V4_BLOCKS.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (baseValue & mask) >>> 0;
  });
};

const IPV6_BLOCKED_PREFIXES = [
  '::1',
  '::',
  'fc',
  'fd',
  'fe8',
  'fe9',
  'fea',
  'feb',
  'ff',
  '64:ff9b',
  '100::',
  '2001:db8',
  '2001:10',
  '2002',
];

export const isPrivateIp = (rawIp) => {
  if (!rawIp) return true;
  const ip = rawIp.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) {
    if (ip.startsWith('::ffff:')) {
      const embedded = ip.slice('::ffff:'.length);
      if (net.isIP(embedded) === 4) return isPrivateV4(embedded);
      // ::ffff:7f00:1 style
      const hex = embedded.split(':');
      if (hex.length === 2) {
        const high = Number.parseInt(hex[0], 16);
        const low = Number.parseInt(hex[1], 16);
        if (Number.isFinite(high) && Number.isFinite(low)) {
          return isPrivateV4(intToIpv4(((high << 16) + low) >>> 0));
        }
      }
      return true;
    }
    return IPV6_BLOCKED_PREFIXES.some((prefix) => ip === prefix || ip.startsWith(`${prefix}:`) || ip.startsWith(prefix));
  }
  // Not an IP at all: treat as unsafe.
  return true;
};

export const isBlockedHostname = (hostname) => {
  if (!hostname) return true;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.endsWith('.onion')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
};

const DNS_TTL_MS = 120 * 1000;
const DNS_CACHE_MAX = 2000;
const dnsCache = new Map();

export const resolveHost = async (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw cached.error;
    return cached.addresses;
  }
  try {
    const result = await dns.lookup(host, { all: true, verbatim: true });
    const addresses = result.map((entry) => entry.address);
    if (!addresses.length) throw new Error('no addresses');
    if (dnsCache.size > DNS_CACHE_MAX) dnsCache.clear();
    dnsCache.set(host, { addresses, expiresAt: Date.now() + DNS_TTL_MS });
    return addresses;
  } catch (error) {
    if (dnsCache.size > DNS_CACHE_MAX) dnsCache.clear();
    dnsCache.set(host, { error, expiresAt: Date.now() + 30 * 1000 });
    throw badRequest(`Could not resolve ${host}`);
  }
};

/** Returns true when a URL must not be fetched by the browser. */
export const isBlockedUrl = async (rawUrl) => {
  if (config.allowPrivateTargets) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false; // handled elsewhere
  if (url.username || url.password) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addresses = await resolveHost(host);
    return addresses.some((address) => isPrivateIp(address));
  } catch {
    return true;
  }
};

/** Validates a user supplied navigation target and returns a URL object. */
export const assertPublicHttpUrl = async (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('That does not look like a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Only http:// and https:// destinations are supported');
  }
  if (url.username || url.password) throw blocked('URLs containing credentials are not allowed');
  if (url.hostname.length > 253) throw badRequest('Hostname is too long');
  if (config.allowPrivateTargets) return url;
  if (await isBlockedUrl(url.href)) {
    throw blocked('That destination resolves to a private or reserved address');
  }
  return url;
};

export const describeTarget = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    return { host: url.host, protocol: url.protocol.replace(':', ''), path: `${url.pathname}${url.search}` };
  } catch {
    return { host: '', protocol: '', path: '' };
  }
};
