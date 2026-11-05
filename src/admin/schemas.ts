import { z } from 'zod';
import { providerModelSchema, modelAliasSchema } from '../contracts/model-admin.js';
export {endpointKindSchema, providerCapabilitySchema, providerModelSchema, providerSchema, modelAliasSchema, routeRuleMatchSchema, routeRuleActionSchema, heuristicActionSchema, configImportSchema, routeRuleSchema, heuristicSchema, adaptiveRoutingSchema, routingObjectiveSchema, clientKeyMetadataSchema, clientKeySchema, clientKeyUpdateSchema} from '../contracts/model-admin.js';

export type ProviderModelInput = z.infer<typeof providerModelSchema>;
export type ModelAliasInput = z.infer<typeof modelAliasSchema>;
