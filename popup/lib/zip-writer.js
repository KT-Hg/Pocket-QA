/**
 * zip-writer.js — minimal ZIP builder (Store method: no compression) for the
 * XLSX result file and the screenshot ZIP of a CSV run.
 */

function _makeCRC32() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
}
const _CRC32T = _makeCRC32();
function _zipCrc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ _CRC32T[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
export class ZipWriter {
  constructor() { this._files = []; this._parts = []; this._offset = 0; }
  // Each file: a local file header, then its bytes stored uncompressed.
  add(name, content) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const crc = _zipCrc32(dataBytes);
    const localHeader = new DataView(new ArrayBuffer(30 + nameBytes.length));
    localHeader.setUint32(0, 0x04034b50, true); localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);  localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, 0, true); localHeader.setUint16(12, 0, true);
    localHeader.setUint32(14, crc, true); localHeader.setUint32(18, dataBytes.length, true);
    localHeader.setUint32(22, dataBytes.length, true); localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    new Uint8Array(localHeader.buffer).set(nameBytes, 30);
    this._files.push({ nameBytes, size: dataBytes.length, crc, offset: this._offset });
    this._offset += localHeader.buffer.byteLength + dataBytes.length;
    this._parts.push(new Uint8Array(localHeader.buffer), dataBytes);
  }
  // Then the central directory (one entry per file) and its end record (eocd).
  build(mimeType) {
    const cdParts = []; let cdSize = 0; const cdOffset = this._offset;
    for (const f of this._files) {
      const entry = new DataView(new ArrayBuffer(46 + f.nameBytes.length));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
      entry.setUint16(8, 0, true);  entry.setUint16(10, 0, true);
      entry.setUint16(12, 0, true); entry.setUint16(14, 0, true);
      entry.setUint32(16, f.crc, true); entry.setUint32(20, f.size, true); entry.setUint32(24, f.size, true);
      entry.setUint16(28, f.nameBytes.length, true); entry.setUint16(30, 0, true); entry.setUint16(32, 0, true);
      entry.setUint16(34, 0, true); entry.setUint16(36, 0, true);
      entry.setUint32(38, 0, true); entry.setUint32(42, f.offset, true);
      new Uint8Array(entry.buffer).set(f.nameBytes, 46);
      cdParts.push(new Uint8Array(entry.buffer)); cdSize += entry.buffer.byteLength;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
    eocd.setUint16(8, this._files.length, true); eocd.setUint16(10, this._files.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdOffset, true); eocd.setUint16(20, 0, true);
    return new Blob([...this._parts, ...cdParts, new Uint8Array(eocd.buffer)],
      { type: mimeType || 'application/zip' });
  }
}
