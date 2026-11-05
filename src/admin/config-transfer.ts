import {HTTPException} from 'hono/http-exception';
import {prisma} from '../storage/client.js';
import {configImportSchema, routeRuleActionSchema} from '../contracts/model-admin.js';

function unique(values: Array<string | undefined>, label: string): void {
  const defined = values.filter((value): value is string => value !== undefined);
  if (new Set(defined).size !== defined.length) throw new HTTPException(400, {message: 'Duplicate ' + label + ' in import'});
}

function defined<T extends object>(value: T): {[K in keyof T]: Exclude<T[K], undefined>} {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {[K in keyof T]: Exclude<T[K], undefined>};
}

/** Version-1 archive IDs identify source records, never destination ownership. */
export async function importConfiguration(raw: unknown, adminUserId?: string, database: Pick<typeof prisma, '$transaction'> = prisma): Promise<void> {
  const {data} = configImportSchema.parse(raw);
  unique(data.providers?.map(provider => provider.slug) ?? [], 'provider slug');
  unique(data.providers?.map(provider => provider.id) ?? [], 'source provider ID');
  unique(data.aliases?.map(alias => alias.alias) ?? [], 'model alias');
  unique(data.routeRules?.map(rule => rule.name) ?? [], 'route name');
  unique(data.heuristicRules?.map(rule => rule.name) ?? [], 'heuristic name');
  unique(data.runtimeSettings?.map(setting => setting.key) ?? [], 'runtime setting key');
  for (const provider of data.providers ?? []) {
    unique(provider.models?.map(model => model.model) ?? [], 'provider model');
    for (const model of provider.models ?? []) if (model.providerId !== undefined && model.providerId !== provider.id)
      throw new HTTPException(400, {message: 'Model metadata references a different source provider'});
  }
  await database.$transaction(async tx => {
    const existing = await tx.provider.findMany({select: {id: true}});
    const existingIds = new Set(existing.map(provider => provider.id));
    const sourceIds = new Set(data.providers?.flatMap(provider => provider.id ? [provider.id] : []) ?? []);
    const known = (id: string) => {
      if (!sourceIds.has(id) && !existingIds.has(id)) throw new HTTPException(400, {message: 'Unknown provider reference in import; include its source provider record or select an existing local provider'});
    };
    for (const alias of data.aliases ?? []) if (alias.providerId) known(alias.providerId);
    for (const rule of data.routeRules ?? []) {
      const action = routeRuleActionSchema.parse(JSON.parse(rule.actionJson));
      for (const id of action.providerIds ?? []) known(id);
    }
    const providerIds = new Map<string, string>();
    for (const provider of data.providers ?? []) {
      const {id, createdAt: _createdAt, updatedAt: _updatedAt, lastHealthAt: _lastHealthAt,
        lastHealthStatus: _lastHealthStatus, lastHealthError: _lastHealthError, models, ...settings} = provider;
      const writableModels = models?.map(({id: _id, providerId: _providerId, createdAt: _created, updatedAt: _updated, ...model}) => defined(model));
      const saved = await tx.provider.upsert({where: {slug: provider.slug},
        create: {...defined(settings), ...(writableModels ? {models: {create: writableModels}} : {})},
        update: {...defined(settings), ...(writableModels ? {models: {deleteMany: {}, create: writableModels}} : {})},
      });
      if (id) providerIds.set(id, saved.id);
    }
    const mappedId = (id: string) => providerIds.get(id) ?? id;
    for (const alias of data.aliases ?? []) {
      const {id: _id, createdAt: _created, updatedAt: _updated, ...settings} = alias;
      const values = {...defined(settings), providerId: alias.providerId ? mappedId(alias.providerId) : null};
      await tx.modelAlias.upsert({where: {alias: alias.alias}, create: values, update: values});
    }
    for (const rule of data.routeRules ?? []) {
      const {id: _id, createdAt: _created, updatedAt: _updated, ...settings} = rule;
      const action = routeRuleActionSchema.parse(JSON.parse(rule.actionJson));
      const changed = action.providerIds?.some(id => mappedId(id) !== id);
      const actionJson = changed ? JSON.stringify({...action, providerIds: action.providerIds!.map(mappedId)}) : rule.actionJson;
      await tx.routeRule.upsert({where: {name: rule.name}, create: {...defined(settings), actionJson}, update: {...defined(settings), actionJson}});
    }
    for (const heuristic of data.heuristicRules ?? []) {
      const {id: _id, createdAt: _created, updatedAt: _updated, ...settings} = heuristic;
      await tx.heuristicRule.upsert({where: {name: heuristic.name}, create: defined(settings), update: defined(settings)});
    }
    for (const setting of data.runtimeSettings ?? []) {
      const {id: _id, createdAt: _created, updatedAt: _updated, ...settings} = setting;
      await tx.runtimeSetting.upsert({where: {key: setting.key}, create: settings, update: settings});
    }
    await tx.auditEvent.create({data: {actorType: 'admin-user', adminUserId: adminUserId ?? null,
      action: 'config.import', entityType: 'config', metadataJson: '{"imported":true}'}});
  }, {timeout: 15000});
}
