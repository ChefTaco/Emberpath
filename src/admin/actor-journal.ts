import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { HTTPException } from 'hono/http-exception';
import { encryptText, decryptText } from '../security/crypto.js';

export interface ActorStep {
  service: string;
  action: string;
  status: number;
  ok: boolean;
  resourceId: string;
  attempts: number;
}
export interface ActorOperation {
  id: string;
  bindingKey: string;
  actorId: string;
  ownerId: string;
  action: 'rotate' | 'disable';
  identifiersJson: string;
  stepsJson: string;
  encryptedSecrets: string | null;
  receiptExpiresAt: number | null;
  status: string;
}
export interface ActorLease { bindingKey: string; token: string }
export interface ActorRun {
  operation: ActorOperation;
  lease: ActorLease | null;
  steps: Record<string, ActorStep>;
  secrets: Record<string, string>;
}

/** The SQLite lease is shared by enrollment, rotation and containment. */
export class ActorJournal {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher = { encrypt: encryptText, decrypt: decryptText },
    private readonly now: () => number = Date.now,
  ) { database.exec('PRAGMA busy_timeout = 0'); }

  private transaction<T>(fn: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  private lock(bindingKey: string): ActorLease {
    const existing = this.database.prepare('SELECT leaseUntil FROM ActorLifecycleLease WHERE bindingKey = ?').get(bindingKey) as { leaseUntil: number } | undefined;
    if (existing && existing.leaseUntil > this.now()) throw new HTTPException(409, { message: 'An actor operation is running; retry after its lease is released' });
    const lease = { bindingKey, token: randomUUID() };
    this.database.prepare('INSERT INTO ActorLifecycleLease (bindingKey, token, leaseUntil) VALUES (?, ?, ?) ON CONFLICT(bindingKey) DO UPDATE SET token = excluded.token, leaseUntil = excluded.leaseUntil').run(bindingKey, lease.token, this.now() + 120_000);
    return lease;
  }
  holdEnrollment(bindingKey: string): ActorLease {
    return this.transaction(() => {
      const pending = this.database.prepare("SELECT id FROM ActorLifecycleOperation WHERE bindingKey = ? AND status IN ('pending', 'partial') LIMIT 1").get(bindingKey);
      if (pending) throw new HTTPException(409, { message: 'Resume or contain the pending lifecycle operation before enrollment' });
      return this.lock(bindingKey);
    });
  }
  renew(lease: ActorLease): void {
    const result = this.database.prepare('UPDATE ActorLifecycleLease SET leaseUntil = ? WHERE bindingKey = ? AND token = ? AND leaseUntil > ?').run(this.now() + 120_000, lease.bindingKey, lease.token, this.now());
    if (!result.changes) throw new HTTPException(409, { message: 'Actor operation lease was lost; reload its durable status' });
  }
  release(lease: ActorLease): void {
    this.database.prepare('DELETE FROM ActorLifecycleLease WHERE bindingKey = ? AND token = ?').run(lease.bindingKey, lease.token);
  }
  begin(input: { bindingKey: string; actorId: string; ownerId: string; action: 'rotate' | 'disable'; identifiers: Record<string, unknown>; operationId?: string | undefined }): ActorRun {
    return this.transaction(() => {
      this.expireReceipts();
      let operation = input.operationId
        ? this.database.prepare('SELECT * FROM ActorLifecycleOperation WHERE id = ?').get(input.operationId) as unknown as ActorOperation | undefined
        : this.database.prepare("SELECT * FROM ActorLifecycleOperation WHERE bindingKey = ? AND ownerId = ? AND action = ? AND status IN ('pending', 'partial') ORDER BY createdAt DESC LIMIT 1").get(input.bindingKey, input.ownerId, input.action) as unknown as ActorOperation | undefined;
      if (operation && (operation.bindingKey !== input.bindingKey || operation.ownerId !== input.ownerId || operation.action !== input.action)) throw new HTTPException(409, { message: 'Operation ID belongs to another actor, action or operator' });
      if (operation && ['completed', 'acknowledged'].includes(operation.status)) {
        if (operation.action === 'rotate' && (!operation.encryptedSecrets || !operation.receiptExpiresAt || operation.receiptExpiresAt <= this.now())) throw new HTTPException(410, { message: 'Rotation receipt expired or was captured; start a new explicit rotation if credentials were lost' });
        return this.unpack(operation, null);
      }
      if (operation && ['compensated', 'superseded'].includes(operation.status)) throw new HTTPException(409, { message: 'A newer operation replaced or contained this operation; it cannot resume' });
      const lease = this.lock(input.bindingKey);
      const pending = this.database.prepare("SELECT id FROM ActorLifecycleOperation WHERE bindingKey = ? AND status IN ('pending', 'partial') AND id != ?").all(input.bindingKey, operation?.id ?? '') as Array<{ id: string }>;
      if (pending.length && input.action !== 'disable') throw new HTTPException(409, { message: 'Resume the existing operation or use Disable to contain its resources' });
      // Disable is explicit containment compensation; records and provenance remain.
      for (const previous of pending) this.database.prepare("UPDATE ActorLifecycleOperation SET status = 'compensated', encryptedSecrets = NULL, receiptExpiresAt = NULL, updatedAt = ? WHERE id = ?").run(this.now(), previous.id);
      if (input.action === 'disable') this.database.prepare('UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE bindingKey = ?').run(input.bindingKey);
      if (!operation) {
        this.database.prepare("UPDATE ActorLifecycleOperation SET status = 'superseded', encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE bindingKey = ? AND action = 'rotate' AND status IN ('completed', 'acknowledged')").run(input.bindingKey);
        const id = input.operationId ?? randomUUID();
        this.database.prepare("INSERT INTO ActorLifecycleOperation (id, bindingKey, actorId, ownerId, action, identifiersJson, stepsJson, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, '{}', 'pending', ?, ?)").run(id, input.bindingKey, input.actorId, input.ownerId, input.action, JSON.stringify(input.identifiers), this.now(), this.now());
        operation = this.database.prepare('SELECT * FROM ActorLifecycleOperation WHERE id = ?').get(id) as unknown as ActorOperation;
      }
      const run = this.unpack(operation, lease);
      // An expired partial receipt cannot be reconstructed: explicitly recover only
      // secret-bearing steps whose credential was never safely captured.
      if (operation.action === 'rotate' && !operation.encryptedSecrets) {
        for (const step of Object.values(run.steps)) step.ok = false;
      }
      return run;
    });
  }
  private unpack(operation: ActorOperation, lease: ActorLease | null): ActorRun {
    return { operation, lease, steps: JSON.parse(operation.stepsJson) as Record<string, ActorStep>, secrets: operation.encryptedSecrets ? JSON.parse(this.cipher.decrypt(operation.encryptedSecrets)) as Record<string, string> : {} };
  }
  checkpoint(run: ActorRun, mutate?: (database: Database.Database) => void): void {
    if (!run.lease) throw new Error('Cannot mutate a finished actor operation');
    this.transaction(() => {
      this.renew(run.lease!);
      mutate?.(this.database);
      const hasSecrets = Object.keys(run.secrets).length > 0;
      const expiry = hasSecrets ? this.now() + 900_000 : null;
      this.database.prepare('UPDATE ActorLifecycleOperation SET stepsJson = ?, encryptedSecrets = ?, receiptExpiresAt = ?, status = ?, updatedAt = ? WHERE id = ?').run(JSON.stringify(run.steps), hasSecrets ? this.cipher.encrypt(JSON.stringify(run.secrets)) : null, expiry, run.operation.status, this.now(), run.operation.id);
      run.operation.receiptExpiresAt = expiry;
    });
  }
  acknowledge(operationId: string, ownerId: string): void {
    const result = this.database.prepare("UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL, status = 'acknowledged', updatedAt = ? WHERE id = ? AND ownerId = ? AND status = 'completed'").run(this.now(), operationId, ownerId);
    if (!result.changes) throw new HTTPException(409, { message: 'Only the owning operator can acknowledge a completed operation' });
  }
  expireReceipts(): void {
    this.database.prepare('UPDATE ActorLifecycleOperation SET encryptedSecrets = NULL, receiptExpiresAt = NULL WHERE receiptExpiresAt <= ?').run(this.now());
  }
}
