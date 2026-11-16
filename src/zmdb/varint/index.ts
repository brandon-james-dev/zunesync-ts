import type { ZmdbVarintField } from '../types.js';

/**
 * Parse the backwards-varint fields stored at the tail of a ZMDB record.
 *
 * Fields are written from the end of the record towards the fixed-size
 * header: a field id, a field size, then the payload. Both the id and the
 * size are 7-bits-per-byte little-endian varints with a continuation bit
 * in the high bit of each byte.
 *
 * @param recordData - The complete record bytes.
 * @param entrySize - Length of the fixed-size header; parsing stops there.
 * @returns Fields in record order (oldest first).
 */
export function parseBackwardsVarints(recordData: Uint8Array, entrySize: number): ZmdbVarintField[] {
  const fields: ZmdbVarintField[] = [];
  if (recordData.length <= entrySize) return fields;

  let pos = recordData.length - 1;

  while (pos >= entrySize) {
    const idByte1 = recordData[pos--];
    if (idByte1 === 0) break;

    let fieldId = idByte1;
    if (idByte1 & 0x80) {
      if (pos < entrySize) break;
      const idByte2 = recordData[pos--];
      fieldId = (idByte2 << 7) | (idByte1 & 0x7f);
    }

    if (pos < entrySize) break;
    const sizeByte1 = recordData[pos--];
    let fieldSize = sizeByte1;

    if (sizeByte1 & 0x80) {
      if (pos < entrySize) break;
      const sizeByte2 = recordData[pos--];
      fieldSize = (sizeByte2 << 7) | (sizeByte1 & 0x7f);
      // A third size byte follows only when byte 2 has its continuation bit set.
      if (sizeByte2 & 0x80) {
        if (pos < entrySize) break;
        const sizeByte3 = recordData[pos--];
        fieldSize = (sizeByte3 << 14) | (fieldSize & 0x3fff);
      }
    }

    const fieldEnd = pos + 1;
    if (fieldSize > fieldEnd || fieldEnd - fieldSize < entrySize) break;
    const fieldStart = fieldEnd - fieldSize;

    fields.push({
      fieldId,
      fieldSize,
      data: recordData.slice(fieldStart, fieldEnd),
    });

    pos = fieldStart - 1;
  }

  fields.reverse();
  return fields;
}
