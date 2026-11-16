// Packfiles and pkt-lines: the wire formats of git smart HTTP.
//
// Parsing handles both delta kinds (ofs-delta and ref-delta) because a real
// git client delta-compresses its pushes. Generation writes plain objects
// with no deltas: a valid pack either way, and the suite's repositories are
// small enough that the simplicity is worth more than the bytes saved.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { getObject, hashObject, storeObject, type GitObjectType } from './gitstore.ts';

const TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// -------------------------------------------------------------- pkt-line ---

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** A cursor over a buffer of pkt-lines. */
export class PktReader {
  offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  /** The next packet, or undefined when the buffer is exhausted mid-line. */
  next(): Pkt | undefined {
    if (this.offset + 4 > this.buf.length) return undefined;
    const header = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length)) return undefined;
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length === 3) {
      // An error packet: surface its text as data so callers can log it.
      const end = Math.min(this.buf.length, this.offset + 4 + 256);
      const data = this.buf.subarray(this.offset + 4, end);
      this.offset = end;
      return { kind: 'data', data };
    }
    const data = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', data };
  }

  /** Everything not yet consumed (the packfile after the pkt-lines). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }
}

// ----------------------------------------------------------------- packs ---

/**
 * Inflate one zlib stream out of `buf` starting at `offset`, reporting how
 * many bytes it consumed. inflateSync succeeds on any buffer that holds the
 * whole stream (trailing bytes are ignored) and throws on a truncated one,
 * so the consumed length is the smallest prefix that inflates — a binary
 * search over the remainder finds it exactly.
 */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const rest = buf.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(rest.subarray(0, lo)), consumed: lo };
}

function readSizeVarint(buf: Buffer, offset: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at];
    at += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { size, next: at };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const source = readSizeVarint(delta, at);
  at = source.next;
  const target = readSizeVarint(delta, at);
  at = target.next;
  if (source.size !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at]; at += 1; }
      if (op & 0x02) { offset |= delta[at] << 8; at += 1; }
      if (op & 0x04) { offset |= delta[at] << 16; at += 1; }
      if (op & 0x08) { offset |= delta[at] << 24; at += 1; }
      if (op & 0x10) { size = delta[at]; at += 1; }
      if (op & 0x20) { size |= delta[at] << 8; at += 1; }
      if (op & 0x40) { size |= delta[at] << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== target.size || produced !== target.size) throw new Error('delta result size mismatch');
  return result;
}

export interface ParsedPack {
  count: number;
  shas: string[];
}

/**
 * Parse a packfile into the object store, resolving deltas. Returns the new
 * objects' SHAs in pack order. Throws on any structural problem.
 */
export function parsePack(pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer before trusting anything in the pack.
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  interface Pending {
    type: GitObjectType;
    data: Buffer;
    baseOffset?: number;
    baseSha?: string;
    start: number;
  }
  const entries: Pending[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const first = pack[offset];
    offset += 1;
    const typeNumber = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeNumber === 6) {
      // ofs-delta: a negative offset to the base entry's start.
      let back = pack[offset] & 0x7f;
      byte = pack[offset];
      offset += 1;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeNumber === 7) {
      baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateOne(pack, offset);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset += consumed;
    byOffset.set(start, entries.length);
    if (typeNumber === 6 || typeNumber === 7) {
      // A delta entry: its real type is its base's type, fixed at resolution.
      entries.push({ type: 'blob', data, baseOffset, baseSha, start });
    } else {
      const type = TYPE_NAMES[typeNumber];
      if (!type) throw new Error(`pack entry type ${typeNumber} unknown`);
      entries.push({ type, data, start });
    }
  }

  // Resolve entries in order; a delta's base always precedes it in the pack
  // (ofs) or already lives in the store or this pack (ref).
  const resolved: Array<{ type: GitObjectType; data: Buffer }> = new Array(entries.length);
  const resolveEntry = (index: number): { type: GitObjectType; data: Buffer } => {
    const done = resolved[index];
    if (done) return done;
    const entry = entries[index];
    let value: { type: GitObjectType; data: Buffer };
    if (entry.baseOffset !== undefined) {
      const baseIndex = byOffset.get(entry.baseOffset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolveEntry(baseIndex);
      value = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.baseSha !== undefined) {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      const existing = getObject(entry.baseSha);
      if (existing) {
        base = existing;
      } else {
        // The base may sit earlier in this same pack (deltas follow bases).
        for (let j = 0; j < index; j += 1) {
          const candidate = resolveEntry(j);
          if (hashObject(candidate.type, candidate.data) === entry.baseSha) {
            base = candidate;
            break;
          }
        }
      }
      if (!base) throw new Error('ref-delta base missing');
      value = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      value = { type: entry.type, data: entry.data };
    }
    resolved[index] = value;
    return value;
  };

  const shas: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const { type, data } = resolveEntry(i);
    shas.push(storeObject(type, data));
  }
  return { count, shas };
}

/** Build a packfile holding exactly `shas` (plain objects, no deltas). */
export function buildPack(shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = getObject(sha);
    if (!obj) throw new Error(`cannot pack missing object ${sha}`);
    const typeNumber = TYPE_NUMBERS[obj.type];
    let size = obj.data.length;
    const head: number[] = [];
    let first = (typeNumber << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    head.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
