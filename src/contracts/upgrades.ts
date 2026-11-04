import { z } from 'zod';

export const UpgradePlanRequest = z
  .object({
    to: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
  })
  .strict();
export const UpgradeApplyRequest = z
  .object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
