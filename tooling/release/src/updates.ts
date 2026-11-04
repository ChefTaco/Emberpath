import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog } from './catalog.js';
import {
  autoEligible,
  compareVersions,
  parseVersion,
  satisfies,
  type Release,
} from './manifest.js';
import { atomic, home, json, writeJson, withLock } from './files.js';
import { installedPackage, activeDirectory, readProject, serviceEnv } from './project.js';
import { upgrade, releaseChanges, type Manager } from './engine.js';

export interface UpdateStatus {
  enabled: boolean;
  checkedAt?: string;
  installed: string;
  available?: string;
  notesUrl?: string;
  summary?: string;
  newRequiredEnv?: Release['newRequiredEnv'];
  migrations?: Release['migrations'];
  stale?: boolean;
  error?: string;
}
export async function printUpdateNotice(current: string): Promise<void> {
  if (process.env.HIVE_UPDATE_CHECK !== 'true') return;
  const notice = await updateStatus(current);
  if (notice.available)
    console.log(
      `Update ${notice.available} available: ${notice.notesUrl}\nRequired environment names: ${notice.newRequiredEnv?.map((e) => e.name).join(', ') || 'none'}\nMigration impact: ${[...new Set(notice.migrations?.map((m) => m.impact) || [])].join(', ') || 'none'}\nFix: hive upgrade --to ${notice.available}`,
    );
  else if (notice.error) console.log(notice.error);
}
export async function updateStatus(
  current: string,
  root = home(),
  persist = false,
): Promise<UpdateStatus> {
  const enabled = process.env.HIVE_UPDATE_CHECK === 'true';
  if (!enabled) return { enabled, installed: current };
  if (!persist && existsSync(join(root, 'config/project.json'))) {
    try {
      const cached = json<UpdateStatus>(join(root, 'run/update-check.json'));
      return {
        ...cached,
        installed: current,
        enabled: true,
        stale:
          !cached.checkedAt ||
          Date.now() - Date.parse(cached.checkedAt) >= 86_400_000 ||
          cached.installed !== current,
      };
    } catch {
      return {
        enabled,
        installed: current,
        stale: true,
        error:
          'Update status is unavailable until the owner coordinator completes its registry check',
      };
    }
  }
  if (persist) {
    try {
      return await withLock(join(root, 'run/update-check.lock'), () =>
        lookupStatus(current, root, true),
      );
    } catch {
      return {
        enabled,
        installed: current,
        stale: true,
        error: 'Update check is in progress or unavailable',
      };
    }
  }
  return lookupStatus(current, root, false);
}
async function lookupStatus(
  current: string,
  root: string,
  persist: boolean,
): Promise<UpdateStatus> {
  const enabled = true;
  const file = join(root, 'run/update-check.json');
  let cached: UpdateStatus | undefined;
  if (existsSync(file)) {
    try {
      cached = json<UpdateStatus>(file);
      if (
        cached.installed === current &&
        cached.checkedAt &&
        Date.now() - Date.parse(cached.checkedAt) < 86_400_000
      )
        return cached;
    } catch {
      /* damaged cache is not a health failure */
    }
  }
  try {
    const releases = (await catalog()).releases
      .filter(
        (r) =>
          parseVersion(r.version)[0] === parseVersion(current)[0] &&
          compareVersions(r.version, current) > 0,
      )
      .sort((a, b) => compareVersions(b.version, a.version));
    const release = releases[0];
    const changes = releaseChanges([...releases].reverse());
    const status: UpdateStatus = {
      enabled,
      installed: current,
      checkedAt: new Date().toISOString(),
      ...(release
        ? {
            available: release.version,
            notesUrl: release.notesUrl,
            summary: release.summary,
            newRequiredEnv: changes.newRequiredEnv,
            migrations: changes.migrations,
          }
        : {}),
    };
    if (persist) writeJson(file, status);
    return status;
  } catch {
    const status = {
      ...cached,
      enabled,
      installed: current,
      checkedAt: new Date().toISOString(),
      stale: true,
      error: 'Update registry is unavailable; installed services are unaffected',
    };
    if (persist) writeJson(file, status);
    return status;
  }
}
export function compatibilityWarnings(
  versions: Record<string, string | undefined>,
  release: Release,
): string[] {
  return Object.entries(release.wireCompatibility).flatMap(([service, range]) => {
    const actual = versions[service];
    if (!actual) return [`${service}: version unknown; inspect its check output before upgrading`];
    try {
      return satisfies(actual, range)
        ? []
        : [`${service} ${actual} is outside ${range}; fix: hive upgrade --to ${release.version}`];
    } catch {
      return [`${service}: unrecognized version ${actual}`];
    }
  });
}
/** Daily windows in an explicitly selected IANA timezone; repeated DST minutes run once per date. */
export function maintenanceDate(
  now: Date,
  window: string | undefined,
  timezone: string | undefined,
): string | null {
  if (!window || !timezone) return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) throw new Error('HIVE_AUTO_UPGRADE_WINDOW must be HH:MM-HH:MM');
  const [sh, sm, eh, em] = match.slice(1).map(Number) as [number, number, number, number];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59 || sh * 60 + sm >= eh * 60 + em)
    throw new Error('Maintenance window must start before it ends on the same local date');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  // Reserve the full bounded 15 minute execution budget before the window ends.
  return minute >= sh * 60 + sm && minute + 15 <= eh * 60 + em
    ? `${parts.year}-${parts.month}-${parts.day}`
    : null;
}
export async function scheduledUpgrade(
  root: string,
  now = new Date(),
  adapter?: Manager,
): Promise<void> {
  if (process.env.HIVE_AUTO_UPGRADE !== 'true') return;
  const date = maintenanceDate(
    now,
    process.env.HIVE_AUTO_UPGRADE_WINDOW,
    process.env.HIVE_AUTO_UPGRADE_TIMEZONE,
  );
  if (!date) return;
  const policy = process.env.HIVE_AUTO_UPGRADE_POLICY || 'patch';
  if (policy !== 'patch' && policy !== 'minor')
    throw new Error('HIVE_AUTO_UPGRADE_POLICY must be patch or minor');
  const stamp = join(root, 'run/last-unattended-date');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === date) return;
  const current = installedPackage(activeDirectory(root), '@hivemagnus/hive').version;
  const target = (await catalog()).releases
    .filter(
      (r) =>
        autoEligible(current, r, policy) &&
        Object.values(r.dataCompatibility).every((range) => satisfies(current, range)),
    )
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!target) return;
  // No retry storm on failure or a repeated DST hour; the failure receipt remains visible.
  atomic(stamp, date);
  await upgrade(root, { to: target.version, automatic: true }, adapter);
}
export function startUpdateChecks(
  current: string,
  root = home(),
  managedOwner = false,
): () => void {
  if (
    process.env.HIVE_UPDATE_CHECK !== 'true' ||
    (process.env.HIVE_MANAGED_PROJECT && !managedOwner)
  )
    return () => {};
  const timer = setTimeout(
    () => {
      void updateStatus(current, root, true);
    },
    Math.floor(Math.random() * 60_000),
  );
  timer.unref();
  const interval = setInterval(() => {
    void updateStatus(current, root, true);
  }, 86_400_000);
  interval.unref();
  return () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
}
