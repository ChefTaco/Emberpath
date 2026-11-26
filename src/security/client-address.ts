import { getConnInfo } from '@hono/node-server/conninfo';
import { lookup } from 'node:dns/promises';
import type { Context } from 'hono';
import {
  normalizeIpAddress as normalizeAddress,
  resolveClientAddress as resolveWithTrusted,
  trustedProxies as parseAddressRanges,
  type TrustedProxies as AddressRanges,
} from '@hivemagnus/hive-common/rate-limit';

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
 * The setting is a comma- or space-separated list of IP addresses, CIDR ranges, the
 * HiveCommon presets `loopback` (the default), `private` and `linklocal`, host names (resolved
 * through DNS, such as a Compose service or Hive's `ingress`), and `none`. Parsing and the
 * right-to-left walk are HiveCommon's (`@hivemagnus/hive-common/rate-limit`); host names are
 * resolved here, because HiveCommon's list holds only addresses.
 */
export const DEFAULT_TRUSTED_PROXIES = 'loopback';
const HOST_TTL_MS = 30_000;
const HOST_MISS_RETRY_MS = 5_000;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;
export const TRUSTED_PROXIES_ERROR = 'EMBERPATH_TRUSTED_PROXIES entries must be IP addresses, CIDR ranges, host names, loopback, private, linklocal or none';

type Resolver = (host: string) => Promise<string[]>;
interface HostEntry { addresses: Set<string>; at: number; pending?: Promise<void> | undefined }
export interface TrustedProxies {
  trusts(address: string): Promise<boolean>;
  /** A synchronous view for HiveCommon's resolver, with host names freshly resolved. */
  snapshot(): Promise<AddressRanges>;
}

/** Strip an IPv4-mapped IPv6 prefix and surrounding space; "" when it is not an address. */
export function normalizeIpAddress(raw: string | null | undefined): string {
  return normalizeAddress(raw) ?? '';
}

const PRESETS = new Set(['loopback', 'private', 'linklocal']);

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => normalizeIpAddress(entry.address));

/** Parse the list; throws on an entry that is not an address, range, preset, host name or `none`. */
export function parseTrustedProxies(value: string | undefined, resolver: Resolver = defaultResolver, now: () => number = Date.now): TrustedProxies {
  const tokens = (value?.trim() ? value : DEFAULT_TRUSTED_PROXIES).split(/[\s,]+/u).map((token) => token.trim()).filter(Boolean);
  const ranges: string[] = [];
  const hosts = new Map<string, HostEntry>();
  for (const token of tokens) {
    if (token === 'none') continue;
    if (PRESETS.has(token.toLowerCase()) || normalizeAddress(token.split('/')[0]) !== undefined) {
      ranges.push(token);
      continue;
    }
    if (HOST_NAME.test(token) && !/^[\d.]+$/u.test(token)) {
      hosts.set(token.toLowerCase(), { addresses: new Set(), at: -Infinity });
      continue;
    }
    throw new Error(TRUSTED_PROXIES_ERROR);
  }
  let addressRanges: AddressRanges;
  try {
    addressRanges = parseAddressRanges(ranges);
  } catch {
    throw new Error(TRUSTED_PROXIES_ERROR);
  }

  async function refresh(host: string, entry: HostEntry): Promise<void> {
    entry.pending ??= resolver(host)
      .then((addresses) => { entry.addresses = new Set(addresses.map(normalizeIpAddress).filter(Boolean)); })
      .catch(() => { entry.addresses = new Set(); })
      .finally(() => {
        entry.at = now();
        entry.pending = undefined;
      });
    await entry.pending;
  }
  const hostHas = (address: string): boolean => [...hosts.values()].some((entry) => entry.addresses.has(address));

  return {
    async trusts(raw) {
      const address = normalizeIpAddress(raw);
      if (!address) return false;
      if (addressRanges.has(address)) return true;
      for (const [host, entry] of hosts) {
        const age = now() - entry.at;
        // A container restart can change the proxy's address: look again on a miss.
        if (age > HOST_TTL_MS || (!entry.addresses.has(address) && age > HOST_MISS_RETRY_MS)) await refresh(host, entry);
        if (entry.addresses.has(address)) return true;
      }
      return false;
    },
    async snapshot() {
      // Host names are refreshed when stale, so the synchronous check below sees current addresses.
      for (const [host, entry] of hosts) if (now() - entry.at > HOST_TTL_MS) await refresh(host, entry);
      return { has: (address: string) => addressRanges.has(address) || hostHas(normalizeIpAddress(address)), entries: [...addressRanges.entries, ...hosts.keys()] };
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
  const normalized = normalizeIpAddress(peer);
  if (!normalized) return '';
  // Make sure host-name proxies are looked up (and looked up again on a miss) before the walk.
  if (!(await proxies.trusts(normalized))) return normalized;
  const resolved = resolveWithTrusted({ peer: normalized, forwardedFor, trusted: await proxies.snapshot() });
  return resolved.address === 'unknown' ? '' : resolved.address;
}

/** The request's client address, or undefined when it is unknown. */
export async function clientAddress(context: Context, trusted: string | undefined): Promise<string | undefined> {
  const address = await resolveClientAddress(socketPeerAddress(context), context.req.header('x-forwarded-for'), trustedProxies(trusted));
  return address || undefined;
}
