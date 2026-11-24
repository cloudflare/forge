import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * Reads one file from a zip archive, or returns undefined if the archive has none by that name.
 * Handles the stored and deflated entries GitLab's job artifacts use; ZIP64 archives are refused.
 */
export function readZipEntry(archive: Buffer, name: string): Buffer | undefined {
  const end = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error('zip: corrupt central directory');
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryName = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) {
      continue;
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip: ${name} is a ZIP64 entry, which isn't supported`);
    }
    if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`zip: corrupt header for ${name}`);
    }
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(start, start + compressedSize);
    const content = method === STORED ? Buffer.from(data) : method === DEFLATED ? inflateRawSync(data) : undefined;
    if (!content) {
      throw new Error(`zip: ${name} uses unsupported compression method ${method}`);
    }
    if (content.length !== size) {
      throw new Error(`zip: ${name} is ${content.length} bytes, expected ${size}`);
    }
    return content;
  }
  return undefined;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // The record is 22 bytes plus a comment of up to 64 KiB.
  const stop = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= stop; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error('zip: not a zip archive');
}
