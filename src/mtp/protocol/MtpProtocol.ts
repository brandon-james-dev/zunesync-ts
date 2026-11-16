import { MTP_CONTAINER_HEADER_SIZE, MTP_DATA_CHUNK_SIZE, MTP_HEADER_READ_SIZE } from '../../common/constants/index.js';
import { ZuneError } from '../../common/errors/index.js';
import { ZuneBinaryWriter } from '../../common/binary/writer.js';
import {
  buildContainer,
  decodeMtpString,
  decodeUint32Array,
  encodeMtpString,
  encodePropList,
  parseContainer,
} from '../container/index.js';
import { ContainerType, OperationCode, ResponseCode } from '../constants/index.js';
import type { MtpContainer, MtpDeviceInfo, MtpPropValue, MtpStorageInfo } from '../types.js';
import type { MtpTransport } from '../transport/types.js';
import { buildObjectInfoDataset, parseDeviceInfo, parseObjectInfo, parseStorageInfo } from './parsers.js';

const RESPONSE_CODE_NAMES = new Map<number, string>(
  Object.entries(ResponseCode).map(([name, code]) => [code, name]),
);

/** Options for {@link MtpProtocol}. */
export interface MtpProtocolOptions {
  /** Payload chunk size for bulk transfers. Defaults to 16384. */
  chunkSize?: number;
  /** Milliseconds to wait after a ZMDB request before reading. Defaults to 250. */
  zmdbSettleMs?: number;
  /** Per-transaction response timeout. Defaults to 15000. */
  responseTimeoutMs?: number;
  /** Diagnostic sink. Defaults to a no-op. */
  logger?: (message: string) => void;
}

/**
 * MTP command layer for a Zune.
 *
 * Wraps a byte transport with container framing, transaction IDs, the
 * standard MTP operations the sync engine needs, the Zune vendor
 * operations (`0x9217`, `0x922A`, …) and the raw ZMDB bulk pipe.
 */
export class MtpProtocol {
  readonly transport: MtpTransport;
  transactionId = 0;
  sessionId = 0;

  private readonly chunkSize: number;
  private readonly zmdbSettleMs: number;
  private readonly responseTimeoutMs: number;
  private readonly log: (message: string) => void;

  /**
   * Tail of the transaction queue.
   *
   * MTP is a strictly sequential request/response protocol on one session: a
   * command may only be sent once the previous response has been read. Callers
   * do issue transactions concurrently — `ZuneDetector` runs `Promise.all` over
   * the tracks it needs to re-read, three property reads each — and without
   * this lock those commands interleave on the wire, so responses are matched
   * to the wrong command and the session hangs with the device left showing
   * "Syncing" until it is ejected.
   */
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor(transport: MtpTransport, options: MtpProtocolOptions = {}) {
    this.transport = transport;
    this.chunkSize = options.chunkSize ?? MTP_DATA_CHUNK_SIZE;
    this.zmdbSettleMs = options.zmdbSettleMs ?? 250;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 15000;
    this.log = options.logger ?? (() => {});
  }

  /** Run `work` after every previously queued transaction has settled. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(work, work);
    // Keep the chain alive whether `work` resolves or rejects, so one failed
    // transaction does not wedge every later one.
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Send a command container, incrementing the transaction ID first. */
  async sendCommand(opcode: number, params: number[] = []): Promise<void> {
    this.transactionId++;
    await this.writeWithTimeout(
      buildContainer(ContainerType.COMMAND, opcode, this.transactionId, params),
    );
  }

  /**
   * Bound a transport write by `responseTimeoutMs`.
   *
   * `closeSession` writes before it reads, and `disconnect()` awaits it, so an
   * unbounded write hung the teardown as well — the session stayed open and the
   * device stayed on "syncing...".
   */
  private async writeWithTimeout(data: Uint8Array): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ZuneError(
              'MTP_TIMEOUT',
              `Device did not accept a write within ${this.responseTimeoutMs}ms`,
            ),
          ),
        this.responseTimeoutMs,
      );
    });

    try {
      await Promise.race([this.transport.bulkWrite(data), timeout]);
      const elapsed = Date.now() - startedAt;
      if (elapsed > this.responseTimeoutMs / 2) {
        this.log(`MTP: slow write ${elapsed}ms for ${data.length} bytes`);
      }
    } catch (error) {
      // A stalled OUT endpoint fails every later command, so clear it here too.
      await this.resynchronise();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Bound a raw transport write by `responseTimeoutMs`, without triggering
   * recovery.
   *
   * `sendObject` streams file data straight through `bulkWrite` and
   * `openSession` writes its command the same way, so neither went through
   * `writeWithTimeout`. A stalled OUT endpoint therefore hung the upload with
   * no timeout at all: the sync stopped mid-run, the session stayed open and
   * the interface stayed claimed until the device was unplugged. Recovery is
   * deliberately not attempted here because `openSession` is itself called
   * from `resynchronise`.
   */
  private async writeBounded(data: Uint8Array): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ZuneError(
              'MTP_TIMEOUT',
              `Device did not accept a write within ${this.responseTimeoutMs}ms`,
            ),
          ),
        this.responseTimeoutMs,
      );
    });

    try {
      await Promise.race([this.transport.bulkWrite(data), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Send a data container as two transfers: header, then payload. */
  async sendData(opcode: number, data: Uint8Array): Promise<void> {
    const header = new ZuneBinaryWriter(MTP_CONTAINER_HEADER_SIZE);
    header.writeUint32(MTP_CONTAINER_HEADER_SIZE + data.length);
    header.writeUint16(ContainerType.DATA);
    header.writeUint16(opcode);
    header.writeUint32(this.transactionId);
    await this.writeWithTimeout(header.toUint8Array());
    await this.writeWithTimeout(data);
  }

  /**
   * Bound a transport read by `responseTimeoutMs`.
   *
   * `WebUsbMtpTransport.bulkRead` calls `device.transferIn()` with no timeout,
   * so a device that accepts a command and then stops answering hung the read
   * forever: the scan never settled, `disconnect()` never ran, and the Zune
   * kept its MTP session open — the screen stayed on "syncing..." until it was
   * unplugged. Every read now fails instead of hanging.
   */
  private async readWithTimeout(length: number): Promise<Uint8Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ZuneError(
              'MTP_TIMEOUT',
              `No response from the device within ${this.responseTimeoutMs}ms`,
            ),
          ),
        this.responseTimeoutMs,
      );
    });

    const read = this.transport.bulkRead(length);

    try {
      return await Promise.race([read, timeout]);
    } catch (error) {
      // Wait for the abandoned transfer to settle before touching the device.
      // node-usb refuses `close()` while a transfer still holds the device
      // borrow ("The same native value cannot be borrowed mutably while another
      // borrow is active"), and a Zune 120 does fail the transfer on its own
      // after a few seconds. Waiting first is what lets recovery reopen the
      // device instead of failing.
      await Promise.race([
        read.catch(() => new Uint8Array(0)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await this.resynchronise();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Guard against re-entering recovery from the reads recovery itself makes.
   */
  private recovering = false;

  /**
   * Cancel the transaction that timed out, the PTP-over-USB way.
   *
   * A `Promise.race` timeout abandons the transfer but does not cancel it: the
   * device still waits for, or still sends, the rest of the declared length and
   * would take the next command as payload, so the session wedges until the
   * device is unplugged. Verified on a Zune 120 — after one timed-out read,
   * every later transfer failed until the device was physically reconnected.
   *
   * libzune solves this in `ptp_cancel_transaction` (src/ptp.c): Cancel Request
   * (0x64) carrying CancellationCode 0x4001 and the transaction ID, then Get
   * Device Status (0x67) polled until OK, clearing any endpoint the device
   * reports stalled, then discarding data it had already queued. This mirrors
   * that, including its bounds: at most 100 polls 100 ms apart and at most 10 s
   * in all.
   */
  private async cancelTransaction(): Promise<boolean> {
    const classRequest = this.transport.classRequest?.bind(this.transport);
    if (!classRequest) {
      this.log('MTP: this transport cannot cancel a transaction');
      return false;
    }

    const cancel = new Uint8Array(6);
    cancel[0] = 0x01;
    cancel[1] = 0x40; // CancellationCode 0x4001
    new DataView(cancel.buffer).setUint32(2, this.transactionId, true);

    try {
      const sent = await classRequest(0x21, 0x64, cancel, cancel.length, 2000);
      if (sent < 0) {
        this.log(`MTP: cancel request for transaction ${this.transactionId} failed`);
        return false;
      }
    } catch (error) {
      this.log(`MTP: cancel request failed: ${(error as Error).message}`);
      return false;
    }

    const startedAt = Date.now();
    for (let poll = 0; poll < 100; poll++) {
      if (Date.now() - startedAt >= 10_000) break;

      const status = new Uint8Array(32);
      let received = -1;
      try {
        received = await classRequest(0xa1, 0x67, status, status.length, 1000);
      } catch {
        received = -1;
      }

      if (received >= 4) {
        const view = new DataView(status.buffer, status.byteOffset, status.byteLength);
        const length = view.getUint16(0, true);

        // Every endpoint the device lists as stalled has to be cleared.
        for (let k = 4; k + 4 <= length && k + 4 <= received; k += 4) {
          const endpoint = status[k];
          try {
            await this.transport.clearHalt?.(endpoint & 0x80 ? 'in' : 'out');
          } catch {
            // Best effort, as in libzune.
          }
        }

        if (view.getUint16(2, true) === ResponseCode.OK) {
          // Discard whatever the device had already queued for this transaction.
          for (let reads = 0; reads < 256; reads++) {
            try {
              const drained = await Promise.race([
                this.transport.bulkRead(MTP_HEADER_READ_SIZE),
                new Promise<Uint8Array>((resolve) =>
                  setTimeout(() => resolve(new Uint8Array(0)), 200),
                ),
              ]);
              if (drained.length === 0) break;
            } catch {
              break;
            }
          }

          // Clearing the OUT halt is what actually frees the pipe. Verified on
          // a Zune 120: after a cancelled transaction the next read still
          // timed out until `clearHalt('out')` ran, and then it returned
          // `"09 Higher.mp3"`. The IN halt cannot be cleared while the
          // abandoned transfer still holds it, so both are bounded.
          for (const direction of ['out', 'in'] as const) {
            try {
              await Promise.race([
                this.transport.clearHalt?.(direction) ?? Promise.resolve(),
                new Promise((resolve) => setTimeout(resolve, 1000)),
              ]);
            } catch {
              // Best effort, as in libzune.
            }
          }

          this.log(`MTP: transaction ${this.transactionId} cancelled`);
          return true;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.log(`MTP: device still busy after cancelling transaction ${this.transactionId}`);
    return false;
  }

  /**
   * Bring the session back after a failed transfer.
   *
   * Cancel the transaction first; only fall back to reopening the device when
   * the transport cannot cancel or the device stays busy. Reopening is what a
   * physical unplug does, and it is the last resort because it drops the
   * session.
   */
  private async resynchronise(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;

    try {
      if (await this.cancelTransaction()) return;

      if (this.transport.recover) {
        this.log('MTP: reopening the device to cancel the pending transfer');
        await this.transport.recover();
        this.transactionId = 0;
        await this.openSession(this.sessionId || 1);
        return;
      }

      for (const direction of ['in', 'out'] as const) {
        try {
          await this.transport.clearHalt?.(direction);
        } catch {
          // Best effort: a transport without halt control cannot be resynced here.
        }
      }
    } catch (error) {
      this.log(`MTP: recovery failed: ${(error as Error).message}`);
    } finally {
      this.recovering = false;
    }
  }

  /** Read one container, reassembling it across bulk reads when needed. */
  async receiveData(): Promise<MtpContainer> {
    const initial = await this.readWithTimeout(MTP_HEADER_READ_SIZE);
    if (initial.length < MTP_CONTAINER_HEADER_SIZE) {
      throw new ZuneError('MTP_CONTAINER', `Short container header (${initial.length} bytes)`);
    }

    const totalLength = new DataView(initial.buffer, initial.byteOffset, initial.byteLength).getUint32(0, true);
    if (initial.length >= totalLength) return parseContainer(initial.slice(0, totalLength));

    const chunks: Uint8Array[] = [initial];
    let received = initial.length;

    while (received < totalLength) {
      const chunk = await this.readWithTimeout(Math.min(totalLength - received, this.chunkSize));
      chunks.push(chunk);
      received += chunk.length;
      if (chunk.length === 0) break;
    }

    const joined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return parseContainer(joined);
  }

  /** Read a response container and throw on any non-`OK` code. */
  async receiveResponse(): Promise<MtpContainer> {
    const container = await this.receiveData();
    if (container.type !== ContainerType.RESPONSE) {
      throw new ZuneError(
        'MTP_CONTAINER',
        `Expected RESPONSE container, got type 0x${container.type.toString(16).padStart(4, '0')}`,
      );
    }
    if (container.code !== ResponseCode.OK) {
      const name = RESPONSE_CODE_NAMES.get(container.code) ?? `0x${container.code.toString(16).padStart(4, '0')}`;
      throw new ZuneError('MTP_RESPONSE', `MTP response error: ${name}`, [container.code, ...container.params]);
    }
    return container;
  }

  /** Open an MTP session, recovering from a stale session left by a crash. */
  async openSession(sessionId = 1): Promise<void> {
    this.sessionId = sessionId;
    this.transactionId = 0;
    await this.writeBounded(
      buildContainer(ContainerType.COMMAND, OperationCode.OpenSession, 0, [sessionId]),
    );

    try {
      await this.receiveResponse();
    } catch (error) {
      const code = error instanceof ZuneError ? error.code : '';
      const params = error instanceof ZuneError ? error.params : [];
      const recoverable =
        code === 'MTP_RESPONSE' &&
        (params[0] === ResponseCode.SessionAlreadyOpen || params[0] === ResponseCode.InvalidParameter);
      if (!recoverable) throw error;

      this.log('MTP: stale session detected, closing and retrying');
      this.transactionId = 0;
      await this.sendCommand(OperationCode.CloseSession);
      try {
        await this.receiveResponse();
      } catch {
        // The session may not have been open at all.
      }

      this.transactionId = 0;
      await this.writeBounded(
        buildContainer(ContainerType.COMMAND, OperationCode.OpenSession, 0, [sessionId]),
      );
      await this.receiveResponse();
    }

    this.transactionId = 0;
  }

  /** Close the current MTP session. */
  async closeSession(): Promise<void> {
    await this.sendCommand(OperationCode.CloseSession);
    await this.receiveResponse();
    this.sessionId = 0;
  }

  /** `GetDeviceInfo` (0x1001). */
  async getDeviceInfo(): Promise<MtpDeviceInfo> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetDeviceInfo);
      const data = await this.receiveData();
      await this.receiveResponse();
      return parseDeviceInfo(data.payload);
    });
  }

  /** `GetStorageIDs` (0x1004). */
  async getStorageIDs(): Promise<number[]> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetStorageIDs);
      const data = await this.receiveData();
      await this.receiveResponse();
      return decodeUint32Array(data.payload);
    });
  }

  /** `GetStorageInfo` (0x1005). */
  async getStorageInfo(storageId: number): Promise<MtpStorageInfo> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetStorageInfo, [storageId]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return parseStorageInfo(data.payload);
    });
  }

  /** `GetObjectHandles` (0x1007). */
  async getObjectHandles(storageId: number, formatCode = 0, parent = 0): Promise<number[]> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetObjectHandles, [storageId, formatCode, parent]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return decodeUint32Array(data.payload);
    });
  }

  /** `GetObjectInfo` (0x1008). */
  async getObjectInfo(objectHandle: number): Promise<ReturnType<typeof parseObjectInfo>> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetObjectInfo, [objectHandle]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return parseObjectInfo(data.payload);
    });
  }

  /** `SendObjectInfo` (0x100C), returning the handle the device assigned. */
  async sendObjectInfo(
    storageId: number,
    parentHandle: number,
    info: { objectFormat: number; compressedSize: number; filename: string },
  ): Promise<{ storageId: number; parentHandle: number; objectHandle: number }> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SendObjectInfo, [storageId, parentHandle]);
      await this.sendData(
        OperationCode.SendObjectInfo,
        buildObjectInfoDataset({
          storageId,
          objectFormat: info.objectFormat,
          compressedSize: info.compressedSize,
          parentObject: parentHandle,
          filename: info.filename,
        }),
      );
      const response = await this.receiveResponse();
      return {
        storageId: response.params[0],
        parentHandle: response.params[1],
        objectHandle: response.params[2],
      };
    });
  }

  /** `SendObject` (0x100D), streaming the payload in chunks. */
  async sendObject(
    fileData: Uint8Array,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SendObject);

      const totalLength = MTP_CONTAINER_HEADER_SIZE + fileData.length;
      const header = new ZuneBinaryWriter(MTP_CONTAINER_HEADER_SIZE);
      header.writeUint32(totalLength);
      header.writeUint16(ContainerType.DATA);
      header.writeUint16(OperationCode.SendObject);
      header.writeUint32(this.transactionId);
      await this.writeBounded(header.toUint8Array());

      let sent = 0;
      while (sent < fileData.length) {
        const end = Math.min(sent + this.chunkSize, fileData.length);
        await this.writeBounded(fileData.slice(sent, end));
        sent = end;
        onProgress?.(sent, fileData.length);
      }

      if (totalLength % 512 === 0) await this.writeBounded(new Uint8Array(0));
      await this.receiveResponse();
    });
  }

  /** `SetDevicePropValue` (0x1016) for a string property. */
  async setDeviceProperty(propCode: number, value: string): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetDevicePropValue, [propCode]);
      await this.sendData(OperationCode.SetDevicePropValue, encodeMtpString(value));
      await this.receiveResponse();
    });
  }

  /** `SetObjectPropValue` (0x9804) for a string property. */
  async setObjectPropString(objectHandle: number, propCode: number, value: string): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
      await this.sendData(OperationCode.SetObjectPropValue, encodeMtpString(value));
      await this.receiveResponse();
    });
  }

  /** `SetObjectPropValue` (0x9804) for a uint32 property. */
  async setObjectPropUint32(objectHandle: number, propCode: number, value: number): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
      const writer = new ZuneBinaryWriter(4);
      writer.writeUint32(value);
      await this.sendData(OperationCode.SetObjectPropValue, writer.toUint8Array());
      await this.receiveResponse();
    });
  }

  /** `SetObjectPropValue` (0x9804) for a uint16 property. */
  async setObjectPropUint16(objectHandle: number, propCode: number, value: number): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
      const writer = new ZuneBinaryWriter(2);
      writer.writeUint16(value);
      await this.sendData(OperationCode.SetObjectPropValue, writer.toUint8Array());
      await this.receiveResponse();
    });
  }

  /** `SetObjectPropValue` (0x9804) for a UTF-16 code-unit array property. */
  async setObjectPropAuint16(objectHandle: number, propCode: number, text: string): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
      const units = `${text}\0`;
      const writer = new ZuneBinaryWriter(4 + units.length * 2);
      writer.writeUint32(units.length);
      writer.writeUtf16le(units);
      await this.sendData(OperationCode.SetObjectPropValue, writer.toUint8Array());
      await this.receiveResponse();
    });
  }

  /** `SetObjectPropValue` (0x9804) for a byte-array property. */
  async setObjectPropArray(objectHandle: number, propCode: number, data: Uint8Array): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
      const writer = new ZuneBinaryWriter(4 + data.length);
      writer.writeUint32(data.length);
      writer.writeBytes(data);
      await this.sendData(OperationCode.SetObjectPropValue, writer.toUint8Array());
      await this.receiveResponse();
    });
  }

  /** `GetObjectPropValue` (0x9803), returning the raw payload. */
  async getObjectPropValue(objectHandle: number, propCode: number): Promise<Uint8Array> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetObjectPropValue, [objectHandle, propCode]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return data.payload;
    });
  }

  /** `GetObjectPropValue` decoded as an MTP string. */
  async getObjectPropString(objectHandle: number, propCode: number): Promise<string> {
    return decodeMtpString(await this.getObjectPropValue(objectHandle, propCode)).value;
  }

  /** `GetObjectPropValue` decoded as a uint32. */
  async getObjectPropUint32(objectHandle: number, propCode: number): Promise<number> {
    const payload = await this.getObjectPropValue(objectHandle, propCode);
    return payload.length >= 4 ? new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true) : 0;
  }

  /** `GetObjectPropValue` decoded as a uint16. */
  async getObjectPropUint16(objectHandle: number, propCode: number): Promise<number> {
    const payload = await this.getObjectPropValue(objectHandle, propCode);
    return payload.length >= 2 ? new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, true) : 0;
  }

  /** `GetObjectPropValue` decoded as a byte array. */
  async getObjectPropArray(objectHandle: number, propCode: number): Promise<Uint8Array> {
    const payload = await this.getObjectPropValue(objectHandle, propCode);
    if (payload.length < 4) return new Uint8Array(0);
    const count = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
    return payload.slice(4, 4 + count);
  }

  /** `GetThumb` (0x100A). */
  async getThumb(objectHandle: number): Promise<Uint8Array> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetThumb, [objectHandle]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return data.payload;
    });
  }

  /** `GetObject` (0x1009). */
  async getObject(objectHandle: number): Promise<Uint8Array> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetObject, [objectHandle]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return data.payload;
    });
  }

  /** `DeleteObject` (0x100B). */
  async deleteObject(objectHandle: number): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.DeleteObject, [objectHandle]);
      await this.receiveResponse();
    });
  }

  /** `GetObjectReferences` (0x9810). */
  async getObjectReferences(objectHandle: number): Promise<number[]> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.GetObjectReferences, [objectHandle]);
      const data = await this.receiveData();
      await this.receiveResponse();
      return decodeUint32Array(data.payload);
    });
  }

  /** `SetObjectReferences` (0x9811). */
  async setObjectReferences(objectHandle: number, references: number[]): Promise<void> {
    return this.serialize(async () => {
      await this.sendCommand(OperationCode.SetObjectReferences, [objectHandle]);
      const writer = new ZuneBinaryWriter(4 + references.length * 4);
      writer.writeUint32(references.length);
      for (const reference of references) writer.writeUint32(reference);
      await this.sendData(OperationCode.SetObjectReferences, writer.toUint8Array());
      await this.receiveResponse();
    });
  }

  /**
   * Generic transaction: command, optional outbound data, optional inbound data.
   *
   * Rejections carry the device response code in {@link ZuneError.params}
   * (for example `0xA801` reports the index of the rejected property).
   */
  async transaction(
    opcode: number,
    params: number[] = [],
    outData: Uint8Array | null = null,
    timeoutMs = this.responseTimeoutMs,
  ): Promise<{ data: Uint8Array | null; params: number[] }> {
    // Serialised: see `transactionTail`. Concurrent callers queue here rather
    // than interleaving commands on the wire.
    return this.serialize(() =>
      this.runTransaction(opcode, params, outData, timeoutMs),
    );
  }

  private async runTransaction(
    opcode: number,
    params: number[],
    outData: Uint8Array | null,
    timeoutMs: number,
  ): Promise<{ data: Uint8Array | null; params: number[] }> {
    await this.sendCommand(opcode, params);
    if (outData) await this.sendData(opcode, outData);

    const label = `0x${opcode.toString(16)}`;
    const read = async (): Promise<MtpContainer> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.receiveData(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ZuneError('MTP_TIMEOUT', `MTP timeout (${timeoutMs}ms) on ${label}`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let data: Uint8Array | null = null;
    let container = await read();
    if (container.type === ContainerType.DATA) {
      data = container.payload;
      container = await read();
    }

    if (container.type !== ContainerType.RESPONSE) {
      throw new ZuneError(
        'MTP_CONTAINER',
        `Expected RESPONSE for ${label}, got container type 0x${container.type.toString(16)}`,
      );
    }
    if (container.code !== ResponseCode.OK) {
      const name = RESPONSE_CODE_NAMES.get(container.code) ?? `0x${container.code.toString(16).padStart(4, '0')}`;
      throw new ZuneError(
        'MTP_RESPONSE',
        `MTP ${label} failed: ${name} params=[${container.params.map((p) => `0x${p.toString(16)}`).join(', ')}]`,
        [container.code, ...container.params],
      );
    }

    return { data, params: container.params };
  }

  /**
   * `SendObjectPropList` (0x9808): create an object and its properties in
   * one call. Follow with {@link sendObject} (an empty buffer for folders
   * and `.ser` objects). Returns the new object handle.
   */
  async sendObjectPropList(
    storageId: number,
    parentHandle: number,
    objectFormat: number,
    objectSize: number,
    props: MtpPropValue[],
  ): Promise<number> {
    const sizeHi = Math.floor(objectSize / 0x100000000);
    const sizeLo = objectSize % 0x100000000;
    const { params } = await this.transaction(
      OperationCode.SendObjectPropList,
      [storageId, parentHandle, objectFormat, sizeHi, sizeLo],
      encodePropList(props),
    );
    return params[2] ?? 0;
  }

  /** `GetObjectPropDesc` (0x9802). */
  async getObjectPropDesc(propCode: number, objectFormat: number): Promise<Uint8Array | null> {
    return (await this.transaction(OperationCode.GetObjectPropDesc, [propCode, objectFormat])).data;
  }

  /** `GetObjectPropList` (0x9805). Handle 0 with depth 1 lists the root's children. */
  async getObjectPropList(
    objectHandle: number,
    formatCode: number,
    propCode: number,
    groupCode: number,
    depth: number,
  ): Promise<Uint8Array | null> {
    return (
      await this.transaction(OperationCode.GetObjectPropList, [
        objectHandle,
        formatCode,
        propCode,
        groupCode,
        depth,
      ])
    ).data;
  }

  /** `GetDevicePropValue` (0x1015). */
  async getDevicePropValue(propCode: number): Promise<Uint8Array | null> {
    return (await this.transaction(OperationCode.GetDevicePropValue, [propCode])).data;
  }

  /** Zune vendor op `0x9217` — called with 1 before uploads and after writes. */
  async syncDeviceDB(param = 1): Promise<void> {
    await this.transaction(OperationCode.SyncDeviceDB, [param]);
  }

  /** Zune vendor op `0x9215` — sent at the end of a sync session. */
  async disableTrustedFiles(): Promise<void> {
    await this.transaction(OperationCode.DisableTrustedFiles);
  }

  /**
   * Zune vendor op `0x922A` — registers the album/show name about to be
   * written. 530 bytes: u64 0, u32 100, u32 0, u32 1, UTF-16LE name.
   */
  async registerTrackContext(name: string): Promise<void> {
    const data = new Uint8Array(530);
    const view = new DataView(data.buffer);
    view.setUint32(8, 100, true);
    view.setUint32(16, 1, true);
    const encoded = new ZuneBinaryWriter(500);
    encoded.writeUtf16le(name.slice(0, 250));
    data.set(encoded.toUint8Array(), 20);
    await this.transaction(OperationCode.RegisterTrackContext, [], data);
  }

  /** Send a WMDRMPD application request (`0x9212`) and await `OK`. */
  async sendMtpzRequest(data: Uint8Array): Promise<void> {
    this.transactionId++;
    await this.transport.bulkWrite(
      buildContainer(ContainerType.COMMAND, OperationCode.SendWMDRMPDAppRequest, this.transactionId),
    );
    await this.sendData(OperationCode.SendWMDRMPDAppRequest, data);
    await this.receiveResponse();
  }

  /** Read a WMDRMPD application response (`0x9213`). */
  async getMtpzResponse(): Promise<Uint8Array> {
    this.transactionId++;
    await this.transport.bulkWrite(
      buildContainer(ContainerType.COMMAND, OperationCode.GetWMDRMPDAppResponse, this.transactionId),
    );
    const data = await this.receiveData();
    await this.receiveResponse();
    return data.payload;
  }

  /** End a trusted application session (`0x9216`). */
  async resetMtpzHandshake(): Promise<void> {
    this.transactionId++;
    await this.transport.bulkWrite(
      buildContainer(ContainerType.COMMAND, OperationCode.EndTrustedAppSession, this.transactionId),
    );
    await this.receiveResponse();
  }

  /** Enable trusted file operations (`0x9214`) with four 32-bit hashes. */
  async enableTrustedFileOperations(
    hash1: number,
    hash2: number,
    hash3: number,
    hash4: number,
  ): Promise<void> {
    this.transactionId++;
    await this.transport.bulkWrite(
      buildContainer(ContainerType.COMMAND, OperationCode.EnableTrustedFilesOperations, this.transactionId, [
        hash1,
        hash2,
        hash3,
        hash4,
      ]),
    );
    await this.receiveResponse();
  }

  /**
   * Fetch the ZMDB blob over the vendor bulk pipe.
   *
   * This is not a standard MTP command: a raw 16-byte packet is written
   * and the device answers with a 12-byte header followed by the payload.
   *
   * @param objectId - 3-byte object ID; defaults to the music library.
   */
  async readZMDB(objectId: [number, number, number] = [0x03, 0x92, 0x1f]): Promise<Uint8Array> {
    const request = new Uint8Array(16);
    request[0] = 0x10;
    request[4] = 0x01;
    request[6] = 0x17;
    request[7] = 0x92;
    request[8] = objectId[0];
    request[9] = objectId[1];
    request[10] = objectId[2];
    request[12] = 0x01;

    await this.transport.bulkWrite(request);
    if (this.zmdbSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.zmdbSettleMs));
    }

    const header = await this.readWithTimeout(65536);
    if (header.length < 12) throw new ZuneError('TRUNCATED', 'ZMDB: response too short');

    const totalSize = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
    if (totalSize <= 12) throw new ZuneError('TRUNCATED', 'ZMDB: empty response');

    const payloadSize = totalSize - 12;
    const chunks: Uint8Array[] = [header.slice(12)];
    let received = chunks[0].length;

    while (received < payloadSize) {
      const chunk = await this.readWithTimeout(Math.min(payloadSize - received, 65536));
      chunks.push(chunk);
      received += chunk.length;
      if (chunk.length === 0) break;
    }

    try {
      await Promise.race([
        this.transport.bulkRead(512),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
    } catch {
      // Draining the pipe is best effort.
    }

    const payload = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    return payload;
  }
}
