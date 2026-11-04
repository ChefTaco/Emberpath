import { defaultHeuristicRules, defaultRouteRules, ROUTING_PROFILE_ALIASES, ROUTING_PROFILE_RULES } from '../routing/defaults.js';
import { AuthMode, ProviderKind } from '../generated/prisma/client.js';
import { loadEnv } from '../config/env.js';
import { encryptText, hashValue } from '../security/crypto.js';
import { EXTERNALLY_MANAGED_PASSWORD_HASH, isAllowedAdminUser } from '../security/os-auth.js';
import { prisma } from './client.js';
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
    update: buildProviderCreateData(providerPayload),
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
      update: {
        displayName: 'OpenAI Codex Spark',
        enabled: true,
        maxContextWindow: 200000,
      },
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

    if (alias.providerSlug && providerId && !existing.providerId) {
      await prisma.modelAlias.update({
        where: { alias: alias.alias },
        data: {
          provider: { connect: { id: providerId } },
        },
      });
    }
  }

  for (const rule of ROUTING_PROFILE_RULES) {
    await prisma.routeRule.upsert({
      where: { name: rule.name },
      update: {
        kind: rule.kind,
        priority: rule.priority,
        matchJson: rule.matchJson,
        actionJson: rule.actionJson,
        enabled: true,
      },
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

  for (const username of env.HIVE_ROUTER_ADMIN_USERS.split(',').map((user) => user.trim()).filter(Boolean)) {
    if (!isAllowedAdminUser(username)) continue;
    await prisma.adminUser.upsert({
      where: { username },
      update: { displayName: username },
      create: {
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
  await bootstrapRoutingProfiles();
}
