import { aesCbcDecrypt } from '../../common/crypto/aes.js';
import { sha1 } from '../../common/crypto/sha1.js';
import { getRandomBytes } from '../../common/crypto/random.js';
import { MTPZ_RSA_BLOCK_SIZE } from '../../common/constants/index.js';
import { ZuneError } from '../../common/errors/index.js';
import { DeviceProperty } from '../constants/index.js';
import type { MtpProtocol } from '../protocol/MtpProtocol.js';
import { aesCmac } from './cmac.js';
import { MTPZ_CERTIFICATES } from './keys.js';
import { bytesEqual, mgf1Sha1, rsaRawPrivate } from './rsa.js';

/** Result of the MTPZ handshake. */
export interface MtpzSession {
  /** 20-byte MAC hash: 16-byte CMAC key followed by a 4-byte counter. */
  macHash: Uint8Array;
}

/**
 * MTPZ (WMDRMPD) authentication for Zune devices.
 *
 * The sequence mirrors libmtp exactly, because the firmware rejects any
 * deviation:
 *   1. `SetDevicePropValue(SessionInitiatorInfo)`
 *   2. `EndTrustedAppSession` (reset stale state)
 *   3. `SendWMDRMPDAppRequest` with the signed application certificate
 *   4. `GetWMDRMPDAppResponse`, RSA-decrypt and OAEP-unmask the challenge
 *   5. `SendWMDRMPDAppRequest` with the AES-CMAC confirmation
 *   6. `EnableTrustedFilesOperations` with four derived hashes
 */
export class MtpzAuth {
  private readonly mtp: MtpProtocol;

  constructor(mtp: MtpProtocol) {
    this.mtp = mtp;
  }

  /** Run the full handshake. Throws {@link ZuneError} `AUTH_FAILED` on mismatch. */
  async authenticate(): Promise<MtpzSession> {
    await this.mtp.setDeviceProperty(
      DeviceProperty.SessionInitiatorInfo,
      'libmtp/Sajid Anwar - MTPZClassDriver',
    );

    await this.mtp.resetMtpzHandshake();

    const { message, random } = this.buildAppCertificateMessage();
    await this.mtp.sendMtpzRequest(message);

    const response = await this.mtp.getMtpzResponse();
    const { macHash } = this.parseDeviceResponse(response, random);

    await this.mtp.sendMtpzRequest(this.buildConfirmation(macHash));

    const [h1, h2, h3, h4] = this.deriveTrustedHashes(macHash);
    await this.mtp.enableTrustedFileOperations(h1, h2, h3, h4);

    return { macHash };
  }

  /**
   * Build the 785-byte application certificate message.
   *
   * Layout: 5 header bytes, uint16BE certificate length + certificates,
   * `0x00 0x10` + 16 random bytes, then `0x01 0x00 0x80` + the 128-byte
   * signature over bytes `[2, preSignLen)`.
   */
  buildAppCertificateMessage(random?: Uint8Array): { message: Uint8Array; random: Uint8Array } {
    const randomData = random ?? getRandomBytes(16);
    const certsLength = MTPZ_CERTIFICATES.length;
    const preSignLength = 5 + 2 + certsLength + 2 + 16;
    const totalLength = preSignLength + 3 + MTPZ_RSA_BLOCK_SIZE;

    const message = new Uint8Array(totalLength);
    let offset = 0;

    message[offset++] = 0x02;
    message[offset++] = 0x01;
    message[offset++] = 0x01;
    message[offset++] = 0x00;
    message[offset++] = 0x00;

    new DataView(message.buffer).setUint16(offset, certsLength, false);
    offset += 2;
    message.set(MTPZ_CERTIFICATES, offset);
    offset += certsLength;

    message[offset++] = 0x00;
    message[offset++] = 0x10;
    message.set(randomData, offset);
    offset += 16;

    message[offset++] = 0x01;
    message[offset++] = 0x00;
    message[offset++] = 0x80;

    message.set(this.computeSignature(message, preSignLength), offset);
    return { message, random: randomData };
  }

  /** Compute the PSS-like RSA signature over `message[2, preSignLength)`. */
  computeSignature(message: Uint8Array, preSignLength: number): Uint8Array {
    const innerHash = sha1(message.subarray(2, preSignLength));

    const v16 = new Uint8Array(28);
    v16.set(innerHash, 8);

    const hash = sha1(v16);
    const mask = mgf1Sha1(hash, 107);

    const padded = new Uint8Array(MTPZ_RSA_BLOCK_SIZE);
    padded[106] = 0x01;
    padded.set(hash, 107);

    for (let i = 0; i < 107; i++) padded[i] ^= mask[i];

    padded[0] &= 0x7f;
    padded[127] = 0xbc;

    return rsaRawPrivate(padded);
  }

  /**
   * Decrypt and parse the device's challenge response.
   *
   * The 128-byte block at offset 4 is RSA-decrypted, OAEP-unmasked, and
   * its last 16 bytes become the AES-128-CBC key for the payload at
   * offset 136. The payload echoes our random, then carries the MAC hash.
   */
  parseDeviceResponse(response: Uint8Array, sentRandom: Uint8Array): MtpzSession {
    if (response.length < 136 + 16) {
      throw new ZuneError('AUTH_FAILED', `MTPZ: device response too short (${response.length} bytes)`);
    }
    if (response[0] !== 0x02 || response[1] !== 0x02 || response[3] !== 0x80) {
      throw new ZuneError(
        'AUTH_FAILED',
        `MTPZ: unexpected device response header [${response[0]}, ${response[1]}, ${response[2]}, ${response[3]}]`,
      );
    }

    const decrypted = rsaRawPrivate(response.subarray(4, 4 + MTPZ_RSA_BLOCK_SIZE));

    const seedMask = mgf1Sha1(decrypted.subarray(21, MTPZ_RSA_BLOCK_SIZE), 20);
    for (let i = 0; i < 20; i++) decrypted[1 + i] ^= seedMask[i];

    const dataMask = mgf1Sha1(decrypted.subarray(1, 21), 107);
    for (let i = 0; i < 107; i++) decrypted[21 + i] ^= dataMask[i];

    const sessionKey = decrypted.slice(112, MTPZ_RSA_BLOCK_SIZE);

    const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
    const aesBlockLength = view.getUint16(134, false);
    if (aesBlockLength === 0 || aesBlockLength % 16 !== 0) {
      throw new ZuneError('AUTH_FAILED', `MTPZ: invalid AES block length ${aesBlockLength}`);
    }
    if (response.length < 136 + aesBlockLength) {
      throw new ZuneError('AUTH_FAILED', 'MTPZ: truncated AES payload');
    }

    const plaintext = aesCbcDecrypt(sessionKey, new Uint8Array(16), response.subarray(136, 136 + aesBlockLength));

    let offset = 1;
    const certsLength = readUint32BE(plaintext, offset);
    offset += 4 + certsLength;

    const randomLength = readUint16BE(plaintext, offset);
    offset += 2;
    const echoedRandom = plaintext.subarray(offset, offset + randomLength);
    offset += randomLength;

    if (!bytesEqual(echoedRandom, sentRandom)) {
      throw new ZuneError('AUTH_FAILED', 'MTPZ: device echoed random does not match sent random');
    }

    const deviceRandomLength = readUint16BE(plaintext, offset);
    offset += 2 + deviceRandomLength;

    offset += 1;
    const signatureLength = readUint16BE(plaintext, offset);
    offset += 2 + signatureLength;

    offset += 1;
    const macHashLength = readUint16BE(plaintext, offset);
    offset += 2;

    return { macHash: plaintext.slice(offset, offset + macHashLength) };
  }

  /** Build the 20-byte CMAC confirmation sent in step 5. */
  buildConfirmation(macHash: Uint8Array): Uint8Array {
    const confirmation = new Uint8Array(20);
    confirmation[0] = 0x02;
    confirmation[1] = 0x03;
    confirmation[2] = 0x00;
    confirmation[3] = 0x10;

    const seed = new Uint8Array(16);
    seed[15] = 0x01;

    confirmation.set(aesCmac(macHash.subarray(0, 16), seed), 4);
    return confirmation;
  }

  /** Derive the four 32-bit hashes for `EnableTrustedFilesOperations`. */
  deriveTrustedHashes(macHash: Uint8Array): [number, number, number, number] {
    const cmac = aesCmac(macHash.subarray(0, 16), macHash.subarray(16, 20));
    const view = new DataView(cmac.buffer, cmac.byteOffset, cmac.byteLength);
    return [view.getUint32(0, false), view.getUint32(4, false), view.getUint32(8, false), view.getUint32(12, false)];
  }
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) throw new ZuneError('AUTH_FAILED', 'MTPZ: truncated payload');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new ZuneError('AUTH_FAILED', 'MTPZ: truncated payload');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}
