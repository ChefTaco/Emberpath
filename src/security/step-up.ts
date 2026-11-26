/**
 * Step-up (recent authentication) from an Oathweave ID token, instead of a password.
 *
 * HiveXUI gets a fresh ID token from Oathweave (an authorization request with `prompt=login` /
 * `max_age`, PKCE and a nonce) and posts it to `POST /api/auth/step-up`. Emberpath checks it with
 * the suite's shared verifier: signature, issuer, an audience from EMBERPATH_STEP_UP_AUDIENCES,
 * lifetime, the acting person and session, and `auth_time` within
 * EMBERPATH_STEP_UP_MAX_AGE_SECONDS. A proof that passes counts as that session's latest
 * sign-in: the credential and policy endpoints keep their 15-minute recent-sign-in rule, now
 * measured from the proof's `auth_time`.
 *
 * Step-ups are remembered in memory only, per Emberpath process: a restart asks for a new one.
 */
import {
  createRecentAuthenticationVerifier,
  type RecentAuthenticationVerifier,
} from '@hivemagnus/hive-common/oathweave';
import { randomBytes } from 'node:crypto';

/** How long a sign-in counts as recent for credential and policy changes. */
export const RECENT_OPERATOR_AUTHENTICATION_MS = 15 * 60_000;
/** The suite's HiveXUI browser client for Emberpath: the default step-up audience. */
export const DEFAULT_STEP_UP_AUDIENCES = ['hivexui-emberpath'] as const;
export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;
const STEP_UP_MEMORY_MAX = 10_000;

export interface StepUpSettings {
  issuer: string;
  jwksUrl: string;
  audiences: readonly string[];
  maxAgeSeconds: number;
}

/** EMBERPATH_STEP_UP_AUDIENCES: comma-separated client IDs; empty means the default. */
export function parseStepUpAudiences(value: string | undefined): string[] {
  const audiences = [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
  return audiences.length ? audiences : [...DEFAULT_STEP_UP_AUDIENCES];
}

let cached: { key: string; verifier: RecentAuthenticationVerifier } | undefined;

/** The step-up verifier for these settings, or undefined when Oathweave is not configured. */
export function stepUpVerifier(settings: StepUpSettings | undefined): RecentAuthenticationVerifier | undefined {
  if (!settings) return undefined;
  const key = JSON.stringify([settings.issuer, settings.jwksUrl, settings.audiences, settings.maxAgeSeconds]);
  if (cached?.key !== key) {
    cached = {
      key,
      verifier: createRecentAuthenticationVerifier({
        issuer: settings.issuer,
        jwksUrl: settings.jwksUrl,
        audience: settings.audiences,
        maxAgeSeconds: settings.maxAgeSeconds,
      }),
    };
  }
  return cached.verifier;
}

/** The step-up settings from the environment, when Oathweave is configured. */
export function stepUpSettingsFromEnvironment(env: { EMBERPATH_STEP_UP_AUDIENCES?: string | undefined; EMBERPATH_STEP_UP_MAX_AGE_SECONDS: number }): StepUpSettings | undefined {
  const issuer = process.env['OATHWEAVE_ISSUER'];
  const jwksUrl = process.env['OATHWEAVE_JWKS_URL'];
  if (!issuer || !jwksUrl) return undefined;
  return { issuer, jwksUrl, audiences: parseStepUpAudiences(env.EMBERPATH_STEP_UP_AUDIENCES), maxAgeSeconds: env.EMBERPATH_STEP_UP_MAX_AGE_SECONDS };
}

const stepUps = new Map<string, number>();

function stepUpKey(userId: string, sessionKind: 'oathweave' | 'session', sessionId: string): string {
  return `${userId}\u0000${sessionKind}\u0000${sessionId}`;
}

/** Remember a verified step-up for one admin user and session. `authTimeMs` is the proof's `auth_time`. */
export function rememberStepUp(userId: string, sessionKind: 'oathweave' | 'session', sessionId: string, authTimeMs: number, now = Date.now()): void {
  const key = stepUpKey(userId, sessionKind, sessionId);
  stepUps.delete(key);
  stepUps.set(key, authTimeMs);
  if (stepUps.size <= STEP_UP_MEMORY_MAX) return;
  for (const [entry, at] of stepUps) if (now - at > RECENT_OPERATOR_AUTHENTICATION_MS) stepUps.delete(entry);
  while (stepUps.size > STEP_UP_MEMORY_MAX) stepUps.delete(stepUps.keys().next().value as string);
}

/** The latest verified step-up for this user and session, in epoch milliseconds. */
export function rememberedStepUp(userId: string, sessionKind: 'oathweave' | 'session', sessionId: string | undefined, now = Date.now()): number | undefined {
  if (!sessionId) return undefined;
  const key = stepUpKey(userId, sessionKind, sessionId);
  const at = stepUps.get(key);
  if (at === undefined) return undefined;
  if (now - at > RECENT_OPERATOR_AUTHENTICATION_MS) {
    stepUps.delete(key);
    return undefined;
  }
  return at;
}

/** Forget every remembered step-up (sign-out of a session, tests). */
export function forgetStepUps(userId?: string, sessionKind?: 'oathweave' | 'session', sessionId?: string): void {
  if (userId === undefined || sessionKind === undefined || sessionId === undefined) {
    stepUps.clear();
    return;
  }
  stepUps.delete(stepUpKey(userId, sessionKind, sessionId));
}

/** How long a step-up challenge can be answered: Oathweave's login tickets last as long. */
export const STEP_UP_CHALLENGE_TTL_MS = 10 * 60_000;
const challenges = new Map<string, { userId: string; startedAt: number }>();

/**
 * Start a step-up: a single-use nonce for the authorization request, and the time the
 * re-authentication started. The sign-in that answers it must be at least that new.
 */
export function issueStepUpChallenge(userId: string, now = Date.now()): { nonce: string; startedAt: number } {
  for (const [nonce, challenge] of challenges) if (now - challenge.startedAt > STEP_UP_CHALLENGE_TTL_MS) challenges.delete(nonce);
  while (challenges.size >= STEP_UP_MEMORY_MAX) challenges.delete(challenges.keys().next().value as string);
  const nonce = randomBytes(32).toString('base64url');
  challenges.set(nonce, { userId, startedAt: now });
  return { nonce, startedAt: now };
}

/** Use up a challenge of this user: when it started (epoch ms), or undefined when there is none. */
export function takeStepUpChallenge(nonce: unknown, userId: string, now = Date.now()): number | undefined {
  if (typeof nonce !== 'string') return undefined;
  const challenge = challenges.get(nonce);
  if (!challenge || challenge.userId !== userId) return undefined;
  challenges.delete(nonce);
  return now - challenge.startedAt > STEP_UP_CHALLENGE_TTL_MS ? undefined : challenge.startedAt;
}

export function forgetStepUpChallenges(): void {
  challenges.clear();
}
