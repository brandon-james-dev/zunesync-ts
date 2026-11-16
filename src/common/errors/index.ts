/**
 * Machine-readable failure categories raised by the library.
 *
 * `MTP_RESPONSE` carries the device's response code in {@link ZuneError.params}
 * so callers can branch on it without parsing the message.
 */
export type ZuneErrorCode =
  | 'NOT_A_ZMDB'
  | 'MISSING_ZMED'
  | 'MISSING_ZARR'
  | 'TRUNCATED'
  | 'MTP_RESPONSE'
  | 'MTP_TIMEOUT'
  | 'MTP_TRANSPORT'
  | 'MTP_CONTAINER'
  | 'AUTH_FAILED'
  | 'NOT_CONNECTED'
  | 'TRANSFER_IN_PROGRESS'
  | 'DEVICE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT';

/**
 * Error thrown by every public entry point in this library.
 *
 * The `code` is stable API; the message is for humans. For device-side
 * rejections `params` holds the response parameters (for example the
 * rejected property index reported alongside `0xA801`).
 */
export class ZuneError extends Error {
  readonly code: ZuneErrorCode;
  readonly params: number[];

  constructor(code: ZuneErrorCode, message: string, params: number[] = []) {
    super(message);
    this.name = 'ZuneError';
    this.code = code;
    this.params = params;
  }
}
