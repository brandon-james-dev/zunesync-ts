/**
 * The byte pipe an {@link MtpProtocol} talks over.
 *
 * Implementations exist for USB (Node, via the optional `usb` package)
 * and for in-memory scripted sessions in tests. The protocol itself only
 * needs two bulk endpoints, so any transport that can move opaque byte
 * buffers works.
 */
export interface MtpTransport {
  /** Write one buffer to the bulk OUT endpoint. */
  bulkWrite(data: Uint8Array): Promise<void>;
  /** Read up to `length` bytes from the bulk IN endpoint. */
  bulkRead(length: number, timeoutMs?: number): Promise<Uint8Array>;
  /**
   * Clear a stalled bulk endpoint. Optional.
   *
   * A device that never answers a command leaves its response queued; the next
   * command then reads that stale response and every later read is misaligned.
   * Clearing the IN halt is how the session is resynchronised after a timeout.
   */
  clearHalt?(direction: 'in' | 'out'): Promise<void>;

  /**
   * A still-image class request on the claimed interface.
   *
   * PTP-over-USB cancellation needs two of these: Cancel Request (0x64) and
   * Get Device Status (0x67). Without them a transaction that timed out cannot
   * be cancelled, and the device takes the next command as payload — the
   * session wedges until the device is unplugged.
   *
   * `requestType` is the bmRequestType byte (0x21 to the device, 0xa1 from it).
   * Returns the bytes transferred, or a negative value when unsupported.
   */
  classRequest?(
    requestType: number,
    request: number,
    data: Uint8Array,
    length: number,
    timeoutMs: number,
  ): Promise<number>;

  /**
   * Close and reopen the device, cancelling any in-flight transfer.
   *
   * A timed-out `transferIn` stays in flight inside libusb and blocks every
   * later transfer, so clearing the halt is not enough to recover. Reopening
   * the device is what a physical unplug does.
   */
  recover?(): Promise<void>;
  /** Release the underlying device. Optional. */
  close?(): Promise<void>;
}
