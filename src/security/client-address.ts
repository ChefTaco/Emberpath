import { getConnInfo } from '@hono/node-server/conninfo';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';

/**
 * Client address for sign-in throttling, admin session records and the address Emberpath
 * forwards to Oathweave and HiveMem.
 *
 * Behind a proxy (Hive's ingress in suite mode, or any reverse proxy) every request comes
 * from the proxy's socket address. `X-Forwarded-For` is read only when the socket peer is a
 * trusted proxy (`EMBERPATH_TRUSTED_PROXIES`), from the right, skipping further trusted
 * proxies, so an address a caller wrote into the header itself is used only when every hop
 * after it is trusted.
 *
 * The setting is a comma- or space-separated list of IP addresses, CIDR ranges, host names
 * (resolved through DNS, such as a Compose service) and the keywords `loopback` (the
 * default) and `none`.
 */
export const DEFAULT_TRUSTED_PROXIES = 'loopback';
const MAX_FORWARDED_HOPS = 32;
const HOST_TTL_MS = 30_000;
const HOST_MISS_RETRY_MS = 5_000;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;
export const TRUSTED_PROXIES_ERROR = 'EMBERPATH_TRUSTED_PROXIES entries must be IP addresses, CIDR ranges, host names, loopback or none';

type Resolver = (host: string) => Promise<string[]>;
interface HostEntry { addresses: Set<string>; at: number; pending?: Promise<void> | undefined }
export interface TrustedProxies {
  trusts(address: string): Promise<boolean>;
}

/** Strip an IPv4-mapped IPv6 prefix and surrounding space. */
export function normalizeIpAddress(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => normalizeIpAddress(entry.address));

/** Parse the list; throws on an entry that is not an address, range, host name or keyword. */
export function parseTrustedProxies(value: string | undefined, resolver: Resolver = defaultResolver, now: () => number = Date.now): TrustedProxies {
  const blocks = new BlockList();
  const hosts = new Map<string, HostEntry>();
  const tokens = (value?.trim() ? value : DEFAULT_TRUSTED_PROXIES).split(/[\s,]+/u).map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token === 'none') continue;
    if (token === 'loopback') {
      blocks.addSubnet('127.0.0.0', 8, 'ipv4');
      blocks.addAddress('::1', 'ipv6');
      continue;
    }
    const [base = '', prefix, extra] = token.split('/');
    const address = normalizeIpAddress(base);
    const kind = family(address);
    if (kind && prefix === undefined) {
      blocks.addAddress(address, kind);
      continue;
    }
    if (kind && extra === undefined && /^\d{1,3}$/u.test(prefix ?? '')) {
      const bits = Number(prefix);
      if (bits <= (kind === 'ipv4' ? 32 : 128)) {
        blocks.addSubnet(address, bits, kind);
        continue;
      }
    }
    if (prefix === undefined && HOST_NAME.test(token) && !/^[\d.]+$/u.test(token)) {
      hosts.set(token.toLowerCase(), { addresses: new Set(), at: -Infinity });
      continue;
    }
    throw new Error(TRUSTED_PROXIES_ERROR);
  }

  async function refresh(host: string, entry: HostEntry): Promise<void> {
    entry.pending ??= resolver(host)
      .then((addresses) => { entry.addresses = new Set(addresses); })
      .catch(() => { entry.addresses = new Set(); })
      .finally(() => {
        entry.at = now();
        entry.pending = undefined;
      });
    await entry.pending;
  }

  return {
    async trusts(raw) {
      const address = normalizeIpAddress(raw);
      const kind = family(address);
      if (!kind) return false;
      if (blocks.check(address, kind)) return true;
      for (const [host, entry] of hosts) {
        const age = now() - entry.at;
        // A container restart can change the proxy's address: look again on a miss.
        if (age > HOST_TTL_MS || (!entry.addresses.has(address) && age > HOST_MISS_RETRY_MS)) await refresh(host, entry);
        if (entry.addresses.has(address)) return true;
      }
      return false;
    },
  };
}

/** Whether the setting parses; for configuration validation (no DNS lookups). */
export function isValidTrustedProxies(value: string | undefined): boolean {
  try {
    parseTrustedProxies(value, async () => []);
    return true;
  } catch {
    return false;
  }
}

let cached: { value: string | undefined; proxies: TrustedProxies } | undefined;
export function trustedProxies(value: string | undefined): TrustedProxies {
  if (!cached || cached.value !== value) cached = { value, proxies: parseTrustedProxies(value) };
  return cached.proxies;
}

/** The Node socket peer, or "" outside the Node adapter (tests using app.request). */
export function socketPeerAddress(context: Context): string {
  try {
    return normalizeIpAddress(getConnInfo(context).remote.address ?? '');
  } catch {
    return '';
  }
}

/** Resolve the client from the socket peer and, behind a trusted proxy, X-Forwarded-For. */
export async function resolveClientAddress(peer: string, forwardedFor: string | undefined, proxies: TrustedProxies): Promise<string> {
  let client = normalizeIpAddress(peer);
  if (!client || !forwardedFor || !(await proxies.trusts(client))) return client;
  const hops = forwardedFor.split(',').slice(-MAX_FORWARDED_HOPS);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = normalizeIpAddress(hops[index]);
    if (!family(hop)) break; // Malformed: keep the last address a trusted proxy vouched for.
    client = hop;
    if (!(await proxies.trusts(hop))) break;
  }
  return client;
}

/** The request's client address, or undefined when it is unknown. */
export async function clientAddress(context: Context, trusted: string | undefined): Promise<string | undefined> {
  const address = await resolveClientAddress(socketPeerAddress(context), context.req.header('x-forwarded-for'), trustedProxies(trusted));
  return address || undefined;
}
