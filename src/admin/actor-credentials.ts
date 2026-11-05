import Database from 'better-sqlite3';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { digestText, encryptText, decryptText, generateOpenAiStyleApiKey, hashValue } from '../security/crypto.js';

export const actorCredentialSchema = z.object({
  action: z.enum(['enroll', 'rotate', 'disable']),
  actorId: z.string().min(2).max(32).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(2).max(128),
  expiresAt: z.iso.datetime(),
  resourceId: z.string().min(1).max(200).optional(),
  workspaceId: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
}).strict();

interface Receipt { ownerId: string; identifiersJson: string; encryptedSecrets: string | null; receiptExpiresAt: number | null }

/** Own only Emberpath keys. Native key mutation and its encrypted replay receipt
 * commit atomically; no remote service or administrator credential is involved. */
export class ActorCredentials {
  constructor(private readonly database: Database.Database, private readonly cipher = { encrypt: encryptText, decrypt: decryptText }, private readonly now: () => number = Date.now) {
    database.pragma('busy_timeout = 0');
  }
  apply(ownerId: string, operationId: string, input: unknown): Record<string, unknown> {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new HTTPException(400, { message: 'Expected a SHA-256 operation ID' });
    const body = actorCredentialSchema.parse(input), digest = digestText(JSON.stringify(body));
    return this.database.transaction(() => {
      const id = 'credential:' + operationId;
      const existing = this.database.prepare('SELECT ownerId, identifiersJson, encryptedSecrets, receiptExpiresAt FROM ActorLifecycleOperation WHERE id = ?').get(id) as Receipt | undefined;
      if (existing) {
        if (existing.ownerId !== ownerId || JSON.parse(existing.identifiersJson).digest !== digest) throw new HTTPException(409, { message: 'Operation belongs to another owner or policy' });
        if (body.action === 'disable') return { ok: true, resourceId: JSON.parse(existing.identifiersJson).resourceId, operationId };
        if (!existing.encryptedSecrets || !existing.receiptExpiresAt || existing.receiptExpiresAt <= this.now()) throw new HTTPException(410, { message: 'Receipt expired or acknowledged; use a new explicitly reviewed rotation' });
        return JSON.parse(this.cipher.decrypt(existing.encryptedSecrets)) as Record<string, unknown>;
      }
      const deadline = Date.parse(body.expiresAt), keyId = body.action === 'enroll' ? 'actor-key-' + body.actorId : body.resourceId;
      if (!keyId) throw new HTTPException(400, { message: 'Explicit existing resource ID is required' });
      if (body.action !== 'disable' && (deadline <= this.now() + 1000 || deadline > this.now() + 720 * 3600_000)) throw new HTTPException(400, { message: 'Credential deadline must be within 720 hours' });
      const key = this.database.prepare('SELECT expiresAt, enabled FROM ClientApiKey WHERE id = ?').get(keyId) as { expiresAt: number | null; enabled: number } | undefined;
      if (body.action === 'enroll' && key) throw new HTTPException(409, { message: 'Key already exists; preserve its identity and use reviewed rotation' });
      if (body.action !== 'enroll' && !key) throw new HTTPException(404, { message: 'Key does not exist' });
      if (body.action === 'rotate' && (!key?.enabled || key.expiresAt !== null && Number(key.expiresAt) <= this.now())) throw new HTTPException(409, { message: 'Disabled or expired keys cannot rotate' });
      const raw = body.action === 'disable' ? undefined : generateOpenAiStyleApiKey();
      const result = { ok: true, resourceId: keyId, operationId, ...(raw ? { apiKey: raw } : {}) };
      if (body.action === 'enroll') this.database.prepare('INSERT INTO ClientApiKey (id,name,keyPrefix,keyHash,enabled,metadataJson,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?,?,?)').run(keyId, body.displayName, raw!.slice(0, 8), hashValue(raw!), JSON.stringify({ actorId: body.actorId, workspaceId: body.workspaceId, scopes: ['models:read', 'inference:write'], tracePrivacy: 'metadata-only' }), deadline, this.now(), this.now());
      else if (raw) this.database.prepare('UPDATE ClientApiKey SET keyPrefix = ?, keyHash = ?, lastUsedAt = NULL, updatedAt = ? WHERE id = ?').run(raw.slice(0, 8), hashValue(raw), this.now(), keyId);
      else this.database.prepare('UPDATE ClientApiKey SET enabled = 0, updatedAt = ? WHERE id = ?').run(this.now(), keyId);
      // Superseded keys must never be recovered from old receipts.
      if (body.action !== 'enroll') this.database.prepare('UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE bindingKey = ?').run('native-credential:' + keyId);
      this.database.prepare('INSERT INTO ActorLifecycleOperation (id,bindingKey,actorId,ownerId,action,identifiersJson,stepsJson,encryptedSecrets,receiptExpiresAt,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,\'{}\',?,?,\'completed\',?,?)').run(id, 'native-credential:' + keyId, body.actorId, ownerId, body.action, JSON.stringify({ digest, resourceId: keyId }), raw ? this.cipher.encrypt(JSON.stringify(result)) : null, raw ? Math.min(this.now() + 900_000, deadline) : null, this.now(), this.now());
      return result;
    }).immediate();
  }
  acknowledge(ownerId: string, operationId: string): void {
    const result = this.database.prepare('UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE id = ? AND ownerId = ?').run('credential:' + operationId, ownerId);
    if (!result.changes) throw new HTTPException(404, { message: 'Owned credential operation does not exist' });
  }
}
