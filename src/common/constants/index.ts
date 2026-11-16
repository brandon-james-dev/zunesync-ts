/** Microsoft USB vendor ID shared by every Zune model. */
export const ZUNE_VENDOR_ID = 0x045e;

/** Size of an MTP container header (length, type, code, transaction id). */
export const MTP_CONTAINER_HEADER_SIZE = 12;

/** Payload chunk size used for bulk transfers. */
export const MTP_DATA_CHUNK_SIZE = 16384;

/** USB bulk read size used to pick up a container header. */
export const MTP_HEADER_READ_SIZE = 512;

/** Milliseconds between the Windows FILETIME epoch (1601) and the Unix epoch (1970). */
export const FILETIME_EPOCH_DIFFERENCE_MS = 11644473600000;

/** FILETIME ticks per millisecond (100 ns resolution). */
export const FILETIME_TICKS_PER_MS = 10000n;

/** Size of one RSA block used by the MTPZ handshake. */
export const MTPZ_RSA_BLOCK_SIZE = 128;
