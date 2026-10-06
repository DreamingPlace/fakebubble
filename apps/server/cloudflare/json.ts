import { DomainError, ensure } from '../../../packages/domain/errors.ts';

export async function cloudJSON(request: Request, maximum = 65_536, timeoutMs = 15_000): Promise<unknown> {
  ensure(request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json', 'JSON_REQUIRED');
  ensure(!request.headers.has('content-encoding'), 'INVALID_REQUEST');
  const declared = request.headers.get('content-length');
  ensure(declared === null || /^\d+$/.test(declared), 'INVALID_REQUEST');
  ensure(declared === null || Number(declared) <= maximum, 'PAYLOAD_TOO_LARGE');
  ensure(request.body && !request.signal.aborted, 'INVALID_REQUEST');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DomainError('BODY_TIMEOUT')), timeoutMs);
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]);
      ensure(!request.signal.aborted, 'INVALID_REQUEST');
      if (item.done) break;
      size += item.value.byteLength;
      ensure(size <= maximum, 'PAYLOAD_TOO_LARGE');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new DomainError('INVALID_JSON');
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
