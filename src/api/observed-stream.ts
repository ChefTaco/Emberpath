import type { UsageSnapshot } from '../telemetry/tracing.js';
export interface StreamCapture { text: string; firstByteMs?: number; errored: boolean; bytesReceived: number; truncated: boolean; usage?: UsageSnapshot }

/** A single backpressured reader: trace capture cannot keep abandoned work alive. */
export function observeStream(source: ReadableStream<Uint8Array>, maxBytes: number): { stream: ReadableStream<Uint8Array>; completed: Promise<StreamCapture> } {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  const startedAt = Date.now();
  let captured = 0;
  let received = 0;
  let firstByteMs: number | undefined;
  let settled = false;
  let usage: UsageSnapshot | undefined;
  let line = '';
  let discardLine = false;
  const decoder = new TextDecoder();
  const readUsage = (bytes: Uint8Array) => {
    for (const char of decoder.decode(bytes, { stream: true })) {
      if (char !== '\n') { if (line.length < 65536 && !discardLine) line += char; else { line = ''; discardLine = true; } continue; }
      if (!discardLine && line.startsWith('data:')) {
        try {
          const packet = JSON.parse(line.slice(5)) as Record<string, unknown>;
          const value = packet.usage ?? (packet.response as Record<string, unknown> | undefined)?.usage;
          if (value && typeof value === 'object') {
            const raw = value as Record<string, unknown>;
            const valid = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
            const inputTokens = valid(raw.prompt_tokens ?? raw.input_tokens);
            const outputTokens = valid(raw.completion_tokens ?? raw.output_tokens);
            const totalTokens = valid(raw.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
            if (totalTokens !== undefined) usage = { inputTokens, outputTokens, totalTokens };
          }
        } catch { /* SSE comments, sentinel and non-JSON events carry no usage. */ }
      }
      line = ''; discardLine = false;
    }
  };
  let finish!: (capture: StreamCapture) => void;
  const completed = new Promise<StreamCapture>((resolve) => { finish = resolve; });
  const settle = (errored: boolean) => {
    if (settled) return;
    settled = true;
    finish({ text: Buffer.concat(chunks).toString('utf8'), errored, bytesReceived: received, truncated: received > captured, ...(usage ? { usage } : {}), ...(firstByteMs !== undefined ? { firstByteMs } : {}) });
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { settle(false); controller.close(); return; }
        firstByteMs ??= Date.now() - startedAt;
        received += value.byteLength;
        readUsage(value);
        const remaining = Math.max(0, maxBytes - captured);
        if (remaining) { const piece = value.slice(0, remaining); chunks.push(piece); captured += piece.byteLength; }
        controller.enqueue(value);
      } catch (error) { settle(true); controller.error(error); }
    },
    async cancel(reason) { settle(true); await reader.cancel(reason); },
  });
  return { stream, completed };
}
