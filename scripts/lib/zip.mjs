import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const findEndOfCentralDirectory = (buffer) => {
  const earliest = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let i = buffer.length - 22; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  throw new Error('Not a zip file: end of central directory not found');
};

/**
 * Reads a zip archive held in memory. Supports stored and deflated entries,
 * which covers Claude data exports; zip64 archives are rejected explicitly.
 * @returns {Map<string, () => Buffer>} entry name -> lazy reader
 */
export const readZip = (buffer) => {
  const eocd = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('Zip64 archives are not supported; extract the export and pass the folder');
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt zip: bad central directory entry');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }
    entries.set(name, () => {
      if (size > MAX_ENTRY_BYTES) {
        throw new Error(`Zip entry too large: ${name}`);
      }
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error(`Corrupt zip: bad local header for ${name}`);
      }
      const dataStart =
        localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        return raw;
      }
      if (method === 8) {
        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      }
      throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    });
  }
  return entries;
};
