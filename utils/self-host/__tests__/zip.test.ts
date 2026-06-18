import { createZip, type ZipEntry } from "@/utils/self-host/zip";

// Read a little-endian unsigned int of `len` bytes at `off`.
function readUint(buf: Buffer, off: number, len: number): number {
  let v = 0;
  for (let i = len - 1; i >= 0; i--) v = v * 256 + buf[off + i]!;
  return v;
}

describe("createZip", () => {
  const entries: ZipEntry[] = [
    { name: "a.txt", data: "hello" },
    { name: "dir/b.json", data: '{"k":1}' },
  ];

  it("produces a Buffer with the local + central + EOCD signatures", () => {
    const zip = createZip(entries);
    expect(Buffer.isBuffer(zip)).toBe(true);
    // Local file header signature at offset 0: PK\x03\x04.
    expect(readUint(zip, 0, 4)).toBe(0x04034b50);
    // EOCD signature appears (last 22 bytes start it for a comment-less archive).
    const eocdOff = zip.length - 22;
    expect(readUint(zip, eocdOff, 4)).toBe(0x06054b50);
  });

  it("records one central directory entry per file", () => {
    const zip = createZip(entries);
    const eocdOff = zip.length - 22;
    const totalRecords = readUint(zip, eocdOff + 10, 2);
    expect(totalRecords).toBe(entries.length);
  });

  it("stores file contents uncompressed (method 0) and recoverable", () => {
    const zip = createZip([{ name: "a.txt", data: "hello" }]);
    // Compression method is the 2 bytes at local-header offset 8.
    expect(readUint(zip, 8, 2)).toBe(0);
    // The raw bytes "hello" should be findable in the STORE'd payload.
    expect(zip.includes(Buffer.from("hello"))).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const a = createZip(entries);
    const b = createZip(entries);
    expect(a.equals(b)).toBe(true);
  });

  it("handles an empty archive", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22); // EOCD only
    expect(readUint(zip, 0, 4)).toBe(0x06054b50);
  });
});
