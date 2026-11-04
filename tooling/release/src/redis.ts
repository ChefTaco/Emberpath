import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

type Value = Buffer | number | null | Value[];
/** Minimal RESP2 connection; binary DUMP values never pass through text conversion. */
export class Redis {
  private socket: Socket;
  private bytes = Buffer.alloc(0);
  private pending: { yes: (value: Value) => void; no: (error: Error) => void }[] = [];
  constructor(private url: URL) {
    if (!['redis:', 'rediss:'].includes(url.protocol))
      throw new Error('Redis URL must use redis:// or rediss://');
    const opts = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 6379) };
    this.socket =
      url.protocol === 'rediss:'
        ? tlsConnect({ ...opts, ...(!isIP(opts.host) ? { servername: opts.host } : {}) })
        : netConnect(opts);
    this.socket.setTimeout(10_000, () =>
      this.socket.destroy(new Error('Redis operation timed out')),
    );
    this.socket.on('error', (error) => {
      for (const p of this.pending.splice(0)) p.no(error);
    });
    this.socket.on('data', (data) => {
      this.bytes = Buffer.concat([this.bytes, data]);
      this.drain();
    });
    this.socket.on('close', () => {
      for (const p of this.pending.splice(0)) p.no(new Error('Redis connection closed'));
    });
  }
  private parse(offset: number): [Value | Error, number] | null {
    const end = this.bytes.indexOf('\r\n', offset);
    if (end < 0) return null;
    const prefix = String.fromCharCode(this.bytes[offset]!);
    const line = this.bytes.toString('utf8', offset + 1, end);
    let next = end + 2;
    if (prefix === '-') return [new Error(`Redis refused ${line.split(' ')[0]}`), next];
    if (prefix === '+') return [Buffer.from(line), next];
    if (prefix === ':') return [Number(line), next];
    if (prefix === '$') {
      const n = Number(line);
      if (n === -1) return [null, next];
      if (this.bytes.length < next + n + 2) return null;
      return [this.bytes.subarray(next, next + n), next + n + 2];
    }
    if (prefix === '*') {
      const n = Number(line);
      if (n === -1) return [null, next];
      const values: Value[] = [];
      for (let i = 0; i < n; i++) {
        const p = this.parse(next);
        if (!p) return null;
        if (p[0] instanceof Error) return p;
        values.push(p[0]);
        next = p[1];
      }
      return [values, next];
    }
    throw new Error('Unsupported Redis response');
  }
  private drain(): void {
    while (this.pending.length) {
      const parsed = this.parse(0);
      if (!parsed) return;
      this.bytes = this.bytes.subarray(parsed[1]);
      const p = this.pending.shift()!;
      parsed[0] instanceof Error ? p.no(parsed[0]) : p.yes(parsed[0]);
    }
  }
  command(...args: (string | Buffer)[]): Promise<Value> {
    return new Promise((yes, no) => {
      this.pending.push({ yes, no });
      const data = args.map((a) => (Buffer.isBuffer(a) ? a : Buffer.from(a)));
      this.socket.write(
        Buffer.concat([
          Buffer.from(`*${data.length}\r\n`),
          ...data.flatMap((b) => [Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]),
        ]),
      );
    });
  }
  async ready(): Promise<void> {
    if (this.url.password)
      await this.command(
        'AUTH',
        ...(this.url.username ? [decodeURIComponent(this.url.username)] : []),
        decodeURIComponent(this.url.password),
      );
    const db = this.url.pathname.slice(1);
    if (db) {
      if (!/^\d+$/.test(db)) throw new Error('Invalid Redis database');
      await this.command('SELECT', db);
    }
    await this.command('PING');
    const cluster = (await this.command('INFO', 'cluster')) as Buffer;
    if (!cluster.toString().includes('cluster_enabled:0'))
      throw new Error('Redis Cluster backup is unsupported');
  }
  async keys(prefix: string): Promise<Buffer[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(prefix))
      throw new Error('REDIS_PREFIX must be an explicit safe namespace');
    let cursor = '0';
    const keys = new Map<string, Buffer>();
    do {
      const r = (await this.command('SCAN', cursor, 'MATCH', `${prefix}:*`, 'COUNT', '500')) as [
        Buffer,
        Buffer[],
      ];
      cursor = r[0].toString();
      for (const key of r[1]) keys.set(key.toString('base64'), key);
    } while (cursor !== '0');
    return [...keys.values()];
  }
  close(): void {
    this.socket.destroy();
  }
}
