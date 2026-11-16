import { ZuneError } from '../../common/errors/index.js';
import type { MtpTransport } from './types.js';

/**
 * In-memory transport for tests and for replaying captured sessions.
 *
 * Writes are recorded in {@link writes}; reads are served from a queue
 * filled with {@link queueRead}. An optional {@link onWrite} hook lets a
 * caller act as the device and queue responses as commands arrive.
 */
export class MemoryTransport implements MtpTransport {
  /** Every buffer written to the bulk OUT endpoint, in order. */
  readonly writes: Uint8Array[] = [];
  private readonly reads: Uint8Array[] = [];
  private closed = false;

  /** Called after each write; use it to queue the device's response. */
  onWrite?: (data: Uint8Array, transport: MemoryTransport) => void;

  /** Queue bytes to be returned by the next {@link bulkRead}. */
  queueRead(data: Uint8Array): void {
    this.reads.push(data);
  }

  /** Number of queued reads not yet consumed. */
  get pendingReads(): number {
    return this.reads.length;
  }

  async bulkWrite(data: Uint8Array): Promise<void> {
    if (this.closed) throw new ZuneError('NOT_CONNECTED', 'Transport is closed');
    this.writes.push(data);
    this.onWrite?.(data, this);
  }

  async bulkRead(length: number): Promise<Uint8Array> {
    if (this.closed) throw new ZuneError('NOT_CONNECTED', 'Transport is closed');
    const next = this.reads.shift();
    if (!next) {
      throw new ZuneError('MTP_TIMEOUT', `No response queued (requested ${length} bytes)`);
    }
    return next.length > length ? next.slice(0, length) : next;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
