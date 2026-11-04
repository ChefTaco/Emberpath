import { z } from 'zod';
export const MemorySourceSchema = z.enum(['conversation', 'research', 'observation', 'consolidation', 'user_feedback', 'skill', 'system']);
export const MemoryWriteSchema = z.object({
  content: z.string().trim().min(1),
  type: z.enum(['episodic', 'semantic', 'procedural']),
  scope: z.enum(['private', 'shared']),
  source: MemorySourceSchema,
  workspace_id: z.string().trim().min(1).refine((value) => value !== '*', 'Choose a specific workspace'),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;
export const OperationEvidenceSchema = z.object({
  service: z.string(), action: z.string(), status: z.number().int(), ok: z.boolean(),
  resourceId: z.string().optional(), errorCode: z.string().optional(),
}).strict();
