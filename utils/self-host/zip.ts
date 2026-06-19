// Minimal dependency-free ZIP writer (STORE method, no compression).
//
// We hand-roll the archive instead of pulling in a zip dependency so the
// self-host export bundle adds ZERO new packages — keeping every lockfile
// pristine for the `--frozen-lockfile` deploy. STORE (method 0) is valid per the
// ZIP spec and every unzip tool handles it; the bundle is a handful of tiny text
// files, so compression would buy nothing. Output is a single Node Buffer.

export interface ZipEntry {
  // Forward-slash path inside the archive (e.g. "config/milk-market.config.json").
  name: string;
  // File contents. Strings are encoded as UTF-8.
  data: string | Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// Fixed DOS timestamp (1980-01-01 00:00:00) so the same inputs always produce a
// byte-identical archive — reproducible bundles are easier to test and cache.
const DOS_TIME = 0;
const DOS_DATE = 0x21; // year=1980, month=1, day=1 → (0<<9)|(1<<5)|1

export function createZip(entries: ZipEntry[]): Buffer {
  const fileChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const dataBytes = toBytes(entry.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new Uint8Array([
      ...u32(0x04034b50), // local file header signature
      ...u16(20), // version needed to extract
      ...u16(0), // general purpose bit flag
      ...u16(0), // compression method = store
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size), // compressed size
      ...u32(size), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
    ]);
    fileChunks.push(localHeader, nameBytes, dataBytes);

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50), // central directory header signature
      ...u16(20), // version made by
      ...u16(20), // version needed to extract
      ...u16(0), // general purpose bit flag
      ...u16(0), // compression method = store
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size), // compressed size
      ...u32(size), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...u16(0), // file comment length
      ...u16(0), // disk number start
      ...u16(0), // internal file attributes
      ...u32(0), // external file attributes
      ...u32(offset), // relative offset of local header
    ]);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

  const eocd = new Uint8Array([
    ...u32(0x06054b50), // end of central directory signature
    ...u16(0), // number of this disk
    ...u16(0), // disk where central directory starts
    ...u16(entries.length), // central directory records on this disk
    ...u16(entries.length), // total central directory records
    ...u32(centralSize),
    ...u32(centralStart),
    ...u16(0), // comment length
  ]);

  return Buffer.concat([...fileChunks, ...centralChunks, eocd]);
}
