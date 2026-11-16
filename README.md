# zunesync-ts

A TypeScript/JavaScript library for reading and writing a connected Zune. It parses the ZMDB media database, reads album artwork, and syncs tracks, albums, artists and podcasts over MTPZ. Runs in **Node.js** through `node-usb`, or in the browser through any `MtpTransport` implementation — the package ships `UsbTransport` and `MemoryTransport`, and a WebUSB transport is a small adapter over the same interface.

Ported from [zune-explorer](https://github.com/NiceBeard/zune-explorer) (MIT), rewritten from scratch in TypeScript with typed records, a transport abstraction and a transactional sync session.

## Features

- **Parse ZMDB** — tracks, albums, artists, genres, videos, pictures, playlists, podcast shows and episodes
- **Two layouts** — Zune HD (`ZMed` v5) and Classic (`ZMed` v2), selected automatically from the file
- **MTP protocol** — container framing, transactions, property lists, object upload and the Zune vendor operations
- **MTPZ authentication** — the full libmtp-compatible handshake: RSA certificate, OAEP challenge, AES-CMAC confirmation, trusted-operation hashes
- **Browser-safe crypto** — AES-128, SHA-1 and CMAC implemented over `Uint8Array`; no `node:crypto`, no async WebCrypto round-trip
- **Transactional sync** — `ZuneSync` records every created handle and rolls the batch back on failure
- **Pluggable transports** — USB via the optional `usb` package, plus an in-memory transport for tests and replays
- **Typed errors** — `ZuneError` carries a stable `code` and the device's response parameters

## Install

```bash
npm install zunesync-ts
```

For USB access in Node.js, also install the optional peer:

```bash
npm install usb
```

## Quick Start

### Reading a ZMDB file

```ts
import { readFile } from 'node:fs/promises';
import { parseDatabase } from 'zunesync-ts';

const data = await readFile('ZMDB.bin');
const library = parseDatabase(data, 'hd');

for (const track of library.tracks) {
  console.log(`${track.artist} — ${track.album} — ${track.title}`);
}

console.log(`${library.tracks.length} tracks, ${Object.keys(library.albums).length} albums`);
```

The `ZMed` version inside the file overrides the `deviceFamily` hint, so passing `'hd'` for a Classic database still parses correctly.

### Reading the library off a connected device

```ts
import { Zune } from 'zunesync-ts';

const zune = await Zune.open({ productId: 0x063e });
const library = await zune.readDatabase();

console.log(zune.deviceInfo?.model, zune.storageInfo?.volumeLabel);
console.log(library.tracks.map((t) => t.title));

await zune.eject();
```

### Uploading tracks

```ts
import { readFile } from 'node:fs/promises';
import { Zune } from 'zunesync-ts';

const zune = await Zune.open({ productId: 0x063e });
const session = zune.createSession();

const handles = await session.run(async (active) =>
  zune.uploadTracks(
    [
      {
        data: await readFile('01 All the Love in the World.mp3'),
        filename: '01 All the Love in the World.mp3',
        metadata: {
          albumName: 'With Teeth',
          albumArtist: 'Nine Inch Nails',
          artist: 'Nine Inch Nails',
          genre: 'Industrial',
          track: 1,
          duration: 296000,
        },
      },
    ],
    { session: active, registerTrackContext: true, onProgress: (sent, total) => {
      process.stdout.write(`\r${Math.round((sent / total) * 100)}%`);
    } },
  ),
);

await zune.eject();
```

`uploadTracks` groups the batch by album, creates one artist object and one album object per group, then uploads each track with `SendObjectPropList` followed by `SendObject`.

### Podcasts

```ts
const seriesHandle = await zune.createPodcastSeries({
  name: 'The Daily',
  feedUrl: 'https://feeds.example.com/the-daily',
  author: 'The New York Times',
});

await zune.uploadPodcastEpisode({
  data: await readFile('episode.mp3'),
  filename: '2026-11-16.mp3',
  name: 'Monday, November 16, 2026',
  seriesHandle,
  seriesName: 'The Daily',
  url: 'https://feeds.example.com/the-daily/2026-11-16.mp3',
  duration: 1_800_000,
  dateAuthored: '20261116T060000.0',
});

await zune.setBookmark(episodeHandle, 420_000);
await zune.syncDeviceDB(1);
```

### Device detection

A Zune firmware exposes only two product IDs for the entire family, so a
product ID identifies a **family**, not a model:

| Product ID | Models |
| --- | --- |
| `0x0710` | Zune 4, 8, 16, 30, 80, 120 |
| `0x063e` | Zune HD 16, 32, 64 |

The exact model comes from the capacity the device reports in
`GetStorageInfo.maxCapacity`, matched to the nearest nominal capacity:

```ts
import { detectDevice, getZuneModelVariants, listZuneDevices } from 'zunesync-ts';

detectDevice(0x0710, 8_000_000_000).name;   // 'Zune 8'
detectDevice(0x0710, 30_000_000_000).name;  // 'Zune 30'
detectDevice(0x0710).name;                  // 'Zune 4'  (family default)
detectDevice(0x063e, 32_000_000_000).name;  // 'Zune HD 32'

getZuneModelVariants(0x0710).map((m) => m.name);
// ['Zune 4', 'Zune 8', 'Zune 16', 'Zune 30', 'Zune 80', 'Zune 120']

const attached = await listZuneDevices();
```

Without a capacity the family's smallest model is returned rather than a
wrong specific one. `Zune.model` applies this automatically once `connect()`
has read `GetStorageInfo`.

### Testing without hardware

`MemoryTransport` replays a scripted device, so the whole protocol stack runs in CI:

```ts
import { MemoryTransport, MtpProtocol, buildContainer, ContainerType, ResponseCode } from 'zunesync-ts';

const transport = new MemoryTransport();
transport.onWrite = (data) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  transport.queueRead(
    buildContainer(ContainerType.RESPONSE, ResponseCode.OK, view.getUint32(8, true)),
  );
};

const protocol = new MtpProtocol(transport);
await protocol.openSession();
```

## Project Structure

```
src/
  common/
    binary/       ZuneBinaryReader, ZuneBinaryWriter
    constants/    vendor ID, container sizes, FILETIME epoch
    crypto/       AES-128, SHA-1, CSPRNG — pure Uint8Array, no node:crypto
    errors/       ZuneError and its codes
    util/         FILETIME, string decoding, filename sanitising
  zmdb/
    constants/    schema IDs, entry sizes, descriptor maps
    database/     ZMDB container, record parsers, parseDatabase
    varint/       backwards-varint field decoder
    types.ts      ZmdbTrack, ZmdbAlbum, ZmdbPodcastEpisode, …
  mtp/
    auth/         MTPZ handshake, RSA, AES-CMAC, protocol keys
    constants/    operation, response, format, property codes
    container/    container framing, MTP strings, property lists
    protocol/     MtpProtocol and dataset parsers
    transport/    MtpTransport, UsbTransport, MemoryTransport
    types.ts      MtpDeviceInfo, MtpStorageInfo, MtpObjectMetadata
  device/         model table and USB enumeration
  zune/           Zune high-level API, ZuneSync, property builders
```

## Binary Data Hierarchy

### ZMDB

| Offset | Contents |
| --- | --- |
| `0x00` | `ZMDB` magic |
| `0x20` | `ZMed` magic |
| `0x24` | `uint16` format version — `2` Classic, `5` Zune HD |
| `0x30` | `ZArr` magic, followed by 96 × 20-byte descriptors |
| descriptor 0 | index table: `uint32` atom ID → `uint32` record offset |
| descriptor *n* | `uint16` entry size at `+6`, `uint32` entry count at `+8`, `uint32` data offset at `+16` |

Every record is preceded by a 4-byte header whose low 24 bits hold the record length.

### Music record (`0x01`, Zune HD)

| Offset | Field |
| --- | --- |
| `+0x00` | `uint32` album reference |
| `+0x04` | `uint32` artist reference |
| `+0x08` | `uint32` genre reference |
| `+0x0c` | `uint32` filename reference |
| `+0x10` | `int32` duration (ms) |
| `+0x14` | `int32` size (bytes) |
| `+0x18` | `uint16` track number |
| `+0x1a` | `uint16` play count |
| `+0x1c` | `uint16` codec ID |
| `+0x1e` | `uint8` rating |
| `+0x20` | UTF-8 NUL-terminated title |
| tail | backwards varints (`0x6c` disc number, …) |

### Backwards varints

Fields are written from the end of the record towards the fixed header: payload, then a 7-bit-per-byte size varint, then a 7-bit-per-byte field-ID varint, each with a continuation bit in the high bit.

## API Reference

### Database (`src/zmdb/database/`)

| Export | Description |
| --- | --- |
| `parseDatabase(data, family?)` | Parse a `ZMDB` buffer into a `ZmdbLibrary` |
| `ZMDB` | Container class: `parse()`, `header`, `getRecord()`, `getVarints()`, `resolveString()`, `resolveArtist()`, `resolveAlbum()`, `resolveGenre()` |

### Varint (`src/zmdb/varint/`)

| Export | Description |
| --- | --- |
| `parseBackwardsVarints(record, entrySize)` | Decode a record's varint tail into `{ fieldId, fieldSize, data }[]` |

### Protocol (`src/mtp/protocol/`)

| Export | Description |
| --- | --- |
| `MtpProtocol` | `openSession`, `getDeviceInfo`, `getStorageIDs`, `getObjectHandles`, `sendObjectPropList`, `sendObject`, `setObjectPropValue`, `syncDeviceDB`, `registerTrackContext`, `readZMDB`, `transaction` |
| `parseDeviceInfo` / `parseStorageInfo` / `parseObjectInfo` | Dataset decoders |
| `buildObjectInfoDataset` | `SendObjectInfo` encoder |

### Auth (`src/mtp/auth/`)

| Export | Description |
| --- | --- |
| `MtpzAuth` | `authenticate()` runs the six-step handshake |
| `aesCmac` | AES-CMAC (RFC 4493) |
| `rsaRawPrivate` / `rsaRawPublic` / `mgf1Sha1` | Unpadded RSA and MGF1 primitives |
| `MTPZ_MODULUS` / `MTPZ_PRIVATE_KEY` / `MTPZ_CERTIFICATES` | Protocol constants from libmtp-zune |

### Transport (`src/mtp/transport/`)

| Export | Description |
| --- | --- |
| `MtpTransport` | `bulkWrite`, `bulkRead`, optional `close` |
| `UsbTransport` | `open`, `openFromDevice`, `clearHalt`, `startHotplugDetection`, `close` |
| `MemoryTransport` | `queueRead`, `writes`, `onWrite` |

### High-level API (`src/zune/`)

| Export | Description |
| --- | --- |
| `Zune` | `open`, `connect`, `readDatabase`, `uploadTrack`, `uploadTracks`, `createArtist`, `createAlbum`, `createPodcastSeries`, `uploadPodcastEpisode`, `setBookmark`, `syncDeviceDB`, `deleteObject`, `createSession`, `eject`, `disconnect` |
| `ZuneSync` | `begin`, `track`, `commit`, `rollback`, `run` |
| `buildTrackProps` / `buildAlbumProps` / `buildArtistProps` / `buildPodcastSeriesProps` / `buildEpisodeProps` | Property-list builders |

### Device (`src/device/`)

| Export | Description |
| --- | --- |
| `detectDevice(id, capacityBytes?)` | Product ID (+ optional capacity) → `ZuneModel` |
| `getZuneModelVariants(id)` | Every model a product ID can resolve to |
| `isZuneProductId(id)` | True for a known Zune product ID |
| `listZuneDevices()` | Enumerate attached Zunes |
| `ZUNE_MODELS` | Default model per product ID |
| `ZUNE_MODEL_VARIANTS` | Full model list per product ID |

### Crypto (`src/common/crypto/`)

| Export | Description |
| --- | --- |
| `aesEncryptBlock` / `aesDecryptBlock` | AES-128 single block (FIPS-197) |
| `aesEcbEncrypt` | AES-128-ECB, no padding |
| `aesCbcEncrypt` / `aesCbcDecrypt` | AES-128-CBC, no padding |
| `sha1` | SHA-1 digest (RFC 3174) |
| `getRandomBytes` | CSPRNG bytes via `globalThis.crypto.getRandomValues` |

### Binary (`src/common/binary/`)

| Export | Description |
| --- | --- |
| `ZuneBinaryReader` | `readUint8` … `readUint64`, `readBytes`, `readAscii`, `readUtf16le`, `skip`, `seek` |
| `ZuneBinaryWriter` | `writeUint8` … `writeUint64`, `writeBytes`, `writeAscii`, `writeUtf16le`, `align`, `finalize` |

## Zune Compatibility Notes

- A product ID identifies a family, not a model: `0x0710` covers Zune 4/8/16/30/80/120 and `0x063e` covers Zune HD 16/32/64. The exact model comes from `GetStorageInfo.maxCapacity`.
- The `ZMed` version in the file wins over the `deviceFamily` hint, so a database always parses with the layout it was written with.
- `SendObjectPropList` splits `ObjectSize` into a high and a low 32-bit parameter; the new handle comes back in response parameter 2.
- `SendObject` must write the 12-byte data header and the payload as separate bulk transfers, and must send a zero-length packet when the total length is a multiple of 512.
- `SyncDeviceDB(1)` is sent before a batch and again after writes; the device also refreshes the ZMDB on its own.
- `RegisterTrackContext` sends a fixed 530-byte payload with the album or show name as UTF-16LE at offset 20.
- The MTPZ handshake requires `SessionInitiatorInfo` and an `EndTrustedAppSession` reset before the CMAC confirmation, or the firmware rejects it.
- Rejections such as `0xA801` report the index of the rejected property in `ZuneError.params[1]`.

## Scripts

```bash
npm run lint    # tsc --noEmit
npm run build   # tsc
npm test        # node --import tsx src/__tests__/validate.ts
```

## License

MIT. Protocol constants and the ZMDB layout derive from
[zune-explorer](https://github.com/NiceBeard/zune-explorer) and
[libmtp-zune](https://github.com/kbhomes/libmtp-zune).
