import { DECISIONS_API_ALIASES, DECISIONS_API_RULES, defaultHeuristicRules, defaultRouteRules, ROUTING_PROFILE_ALIASES, ROUTING_PROFILE_RULES } from '../routing/defaults.js';
import { JEV_DECISIONS_TAG, OPENROUTER_JEV_MODEL, OPENROUTER_JEV_PROVIDER_SLUG, TYPESAFE_JEV_MODEL, TYPESAFE_JEV_PROVIDER_SLUG } from '../decisions-api/backends.js';
import { AuthMode, ProviderKind } from '../generated/prisma/client.js';
import { loadEnv } from '../config/env.js';
import { encryptText, hashValue } from '../security/crypto.js';
import { EXTERNALLY_MANAGED_PASSWORD_HASH, isAllowedAdminUser } from '../security/os-auth.js';
import { prisma } from './client.js';
import { initialAdminIdentities } from './initial-admins.js';
import { buildProviderCreateData } from '../providers/runtime.js';

const defaultRuntimeSettings: Record<string, unknown> = {
  retention: {
    traceRetentionDays: 7,
    captureBinaryMedia: false,
    storeFullText: true,
    storeReasoning: true,
  },
};

const OPENROUTER_PROVIDER_SLUG = 'openrouter';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

async function bootstrapOpenRouterProvider(apiKey: string | undefined): Promise<string | null> {
  if (!apiKey) {
    return null;
  }

  // Environment seed values never replace an existing operator-owned provider.
  const existing = await prisma.provider.findUnique({ where: { slug: OPENROUTER_PROVIDER_SLUG } });
  if (existing) return existing.id;

  const providerPayload = {
    slug: OPENROUTER_PROVIDER_SLUG,
    name: 'OpenRouter',
    kind: ProviderKind.OPENROUTER,
    baseUrl: OPENROUTER_BASE_URL,
    authMode: AuthMode.BEARER,
    authHeaderName: 'Authorization',
    encryptedAuthSecret: encryptText(apiKey),
  };

  const provider = await prisma.provider.upsert({
    where: { slug: OPENROUTER_PROVIDER_SLUG },
    create: buildProviderCreateData(providerPayload),
    update: {},
  });

  await prisma.providerModel.upsert({
    where: {
      providerId_model: {
        providerId: provider.id,
        model: OPENROUTER_DEFAULT_MODEL,
      },
    },
    create: {
      providerId: provider.id,
      model: OPENROUTER_DEFAULT_MODEL,
      enabled: true,
    },
    update: {
      enabled: true,
    },
  });

  return provider.id;
}

/**
 * Public /v1/decisions over Jev, seeded only when the operator opts in with
 * EMBERPATH_DECISIONS_JEV_ENABLED=true. The records reuse the shadow decision
 * model's keys (HIVE_TYPESAFE_AI_KEY, HIVE_ROUTER_OPENROUTER_KEY) but are
 * ordinary provider records from then on: they serve only v1.decisions, follow
 * routing rules and priority, and are never replaced once they exist. Shadow
 * mode keeps reading its env keys directly and is unaffected.
 */
async function bootstrapJevDecisionsProviders(env: ReturnType<typeof loadEnv>): Promise<void> {
  if (!env.EMBERPATH_DECISIONS_JEV_ENABLED) return;
  const seeds = [
    env.HIVE_TYPESAFE_AI_KEY ? { slug: TYPESAFE_JEV_PROVIDER_SLUG, name: 'TypeSafe Jev (Decisions API)', kind: ProviderKind.OPENAI_GENERIC, baseUrl: 'https://api.typesafe.ai/v1', key: env.HIVE_TYPESAFE_AI_KEY, model: TYPESAFE_JEV_MODEL, priority: 90 } : undefined,
    env.HIVE_ROUTER_OPENROUTER_KEY ? { slug: OPENROUTER_JEV_PROVIDER_SLUG, name: 'OpenRouter Jev (Decisions API)', kind: ProviderKind.OPENROUTER, baseUrl: OPENROUTER_BASE_URL, key: env.HIVE_ROUTER_OPENROUTER_KEY, model: OPENROUTER_JEV_MODEL, priority: 95 } : undefined,
  ].filter((seed) => seed !== undefined);
  for (const seed of seeds) {
    if (await prisma.provider.findUnique({ where: { slug: seed.slug } })) continue;
    const provider = await prisma.provider.create({
      data: buildProviderCreateData({
        slug: seed.slug,
        name: seed.name,
        kind: seed.kind,
        baseUrl: seed.baseUrl,
        authMode: AuthMode.BEARER,
        authHeaderName: 'Authorization',
        encryptedAuthSecret: encryptText(seed.key),
        capabilities: { supportedRoutes: ['v1.decisions'], tags: [JEV_DECISIONS_TAG], streaming: false, tools: false, jsonSchema: false, embeddings: false, vision: false, reasoning: false },
        timeoutMs: 30_000,
        // Direct TypeSafe ahead of OpenRouter, as in shadow mode.
        priority: seed.priority,
      }),
    });
    await prisma.providerModel.create({ data: { providerId: provider.id, model: seed.model, displayName: 'Jev', enabled: true } });
  }
}

/**
 * Fresh installs only. Existing installations manage aliases and rules as
 * routing revisions, so the `decision` alias is added there by an admin (see
 * the README's Decisions section) and is never re-created after removal.
 */
async function bootstrapDecisionsAlias(): Promise<void> {
  for (const alias of DECISIONS_API_ALIASES) {
    if (await prisma.modelAlias.findUnique({ where: { alias: alias.alias } })) continue;
    await prisma.modelAlias.create({ data: { alias: alias.alias, upstreamModel: alias.upstreamModel, description: alias.description, enabled: true } });
  }
  for (const rule of DECISIONS_API_RULES) {
    await prisma.routeRule.upsert({ where: { name: rule.name }, update: {}, create: { ...rule, enabled: true } });
  }
}

async function bootstrapRoutingProfiles(): Promise<void> {
  const profileProviderSlugs = [
    ...new Set(
      ROUTING_PROFILE_ALIASES
        .map((alias) => alias.providerSlug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0),
    ),
  ];
  const profileProviders = profileProviderSlugs.length > 0
    ? await prisma.provider.findMany({ where: { slug: { in: profileProviderSlugs } } })
    : [];
  const profileProviderIdsBySlug = new Map(profileProviders.map((provider) => [provider.slug, provider.id]));
  const codexProviderId = profileProviderIdsBySlug.get('openai-codex');

  if (codexProviderId) {
    await prisma.providerModel.upsert({
      where: {
        providerId_model: {
          providerId: codexProviderId,
          model: 'gpt-5.3-codex-spark',
        },
      },
      create: {
        providerId: codexProviderId,
        model: 'gpt-5.3-codex-spark',
        displayName: 'OpenAI Codex Spark',
        enabled: true,
        maxContextWindow: 200000,
      },
      update: {},
    });
  }

  for (const alias of ROUTING_PROFILE_ALIASES) {
    const providerId = alias.providerSlug ? profileProviderIdsBySlug.get(alias.providerSlug) ?? null : undefined;
    const existing = await prisma.modelAlias.findUnique({ where: { alias: alias.alias } });

    if (!existing) {
      await prisma.modelAlias.create({
        data: {
          alias: alias.alias,
          upstreamModel: alias.upstreamModel,
          description: alias.description,
          enabled: true,
          ...(alias.providerSlug && providerId ? { provider: { connect: { id: providerId } } } : {}),
        },
      });
      continue;
    }


  }

  for (const rule of ROUTING_PROFILE_RULES) {
    await prisma.routeRule.upsert({
      where: { name: rule.name },
      update: {},
      create: {
        name: rule.name,
        kind: rule.kind,
        priority: rule.priority,
        matchJson: rule.matchJson,
        actionJson: rule.actionJson,
        enabled: true,
      },
    });
  }
}

export async function bootstrapStorage(): Promise<void> {
  const env = loadEnv();
  // Decided before anything is seeded: a database without any alias or route
  // rule has never been bootstrapped.
  const freshInstall = (await prisma.modelAlias.count()) === 0 && (await prisma.routeRule.count()) === 0;

  const usernames = env.HIVE_ROUTER_ADMIN_USERS.split(',').map((user) => user.trim()).filter(Boolean);
  const initial = initialAdminIdentities(env.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON ?? '[]', usernames);
  // Validate every requested binding before creating anything. Existing IDs are
  // preserved; a name match is never permission to replace an account identity.
  for (const [username, localId] of initial) {
    const existing = await prisma.adminUser.findUnique({ where: { username } });
    const owner = await prisma.adminUser.findUnique({ where: { id: localId } });
    if ((existing && existing.id !== localId) || (owner && owner.username !== username)) throw new Error('Initial model account binding conflicts with an existing identity; use reviewed account linking');
  }
  for (const username of usernames) {
    if (!isAllowedAdminUser(username)) continue;
    await prisma.adminUser.upsert({
      where: { username },
      update: {},
      create: {
        ...(initial.has(username) ? { id: initial.get(username)! } : {}),
        username,
        displayName: username,
        passwordHash: EXTERNALLY_MANAGED_PASSWORD_HASH,
      },
    });
  }

  if (env.SEED_CLIENT_API_KEY) {
    const prefix = env.SEED_CLIENT_API_KEY.slice(0, 8);
    const existing = await prisma.clientApiKey.findFirst({
      where: { keyPrefix: prefix },
    });

    if (!existing) {
      await prisma.clientApiKey.create({
        data: {
          name: 'Seeded API Key',
          keyPrefix: prefix,
          keyHash: hashValue(env.SEED_CLIENT_API_KEY),
          metadataJson: JSON.stringify({ seeded: true }),
        },
      });
    }
  }

  for (const rule of defaultHeuristicRules) {
    await prisma.heuristicRule.upsert({
      where: { name: rule.name },
      update: {},
      create: rule,
    });
  }

  for (const rule of defaultRouteRules) {
    await prisma.routeRule.upsert({
      where: { name: rule.name },
      update: {},
      create: rule,
    });
  }

  for (const [key, value] of Object.entries(defaultRuntimeSettings)) {
    await prisma.runtimeSetting.upsert({
      where: { key },
      update: {},
      create: { key, valueJson: JSON.stringify(value) },
    });
  }

  await bootstrapOpenRouterProvider(env.OPENROUTER_API_KEY);
  await bootstrapJevDecisionsProviders(env);
  await bootstrapRoutingProfiles();
  if (freshInstall) await bootstrapDecisionsAlias();
}
