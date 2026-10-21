// A small LevelDB reader. It does just enough to get the current value of
// each key in a chrome.storage store (one key, one JSON value) out of the
// store's table files (.ldb) and its log file (.log). It has no dependencies
// because a hooks module has no Node and no npm; the engine hands files over
// as bytes.
//
// A regex over the raw bytes doesn't work, which is why this exists. Tables
// store each key as a diff against the previous key, so `bridgeDeviceId`
// lands on disk as `viceId` after `bridgeDefaultDisplayName`. And each block
// is usually snappy-compressed, so repeated text turns into back-references.

class Corrupt extends Error {}

type Entry = { key: Uint8Array; seq: number; type: number; value: Uint8Array }

const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]
const LOG_BLOCK = 32768

/** Reads a LevelDB varint at `i`. Returns the value and the index just past it. */
function varint(b: Uint8Array, i: number): [number, number] {
  let r = 0
  let shift = 0
  for (;;) {
    if (i >= b.length) throw new Corrupt('varint past end')
    const c = b[i++]!
    r += (c & 0x7f) * 2 ** shift
    shift += 7
    if (c < 0x80) return [r, i]
  }
}

function u16(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8)
}

function u32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 2 ** 24
}

/** Decodes a raw snappy stream, which is what a LevelDB block holds. No framing. */
export function snappyDecode(src: Uint8Array): Uint8Array {
  const [n, start] = varint(src, 0)
  const out = new Uint8Array(n)
  let o = 0
  let i = start
  while (i < src.length) {
    const tag = src[i++]!
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const nb = len - 59
        len = 0
        for (let k = 0; k < nb; k++) len += src[i + k]! * 2 ** (8 * k)
        i += nb
      }
      len += 1
      if (i + len > src.length || o + len > n) throw new Corrupt('snappy literal past end')
      out.set(src.subarray(i, i + len), o)
      i += len
      o += len
      continue
    }
    let len: number
    let off: number
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4
      off = ((tag >> 5) << 8) | src[i]!
      i += 1
    } else if (kind === 2) {
      len = (tag >> 2) + 1
      off = u16(src, i)
      i += 2
    } else {
      len = (tag >> 2) + 1
      off = u32(src, i)
      i += 4
    }
    if (off === 0 || off > o || o + len > n) throw new Corrupt('bad snappy copy')
    // A copy can overlap the bytes it's producing (that's how runs are encoded), so copy one byte at a time.
    for (let k = 0; k < len; k++) out[o + k] = out[o - off + k]!
    o += len
  }
  if (o !== n) throw new Corrupt('snappy length mismatch')
  return out
}

/** Reads one table block and decompresses it if its trailer byte says to. */
function block(buf: Uint8Array, off: number, size: number): Uint8Array {
  if (off + size + 5 > buf.length) throw new Corrupt('block past end')
  const data = buf.subarray(off, off + size)
  const ctype = buf[off + size]
  if (ctype === 0) return data
  if (ctype === 1) return snappyDecode(data)
  throw new Corrupt(`unknown block compression ${ctype}`)
}

/** Walks a block's entries, rebuilding each full key from its diff against the previous one. */
function* blockEntries(data: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
  if (data.length < 4) throw new Corrupt('short block')
  const nrestarts = u32(data, data.length - 4)
  const end = data.length - 4 - 4 * nrestarts
  if (end < 0) throw new Corrupt('bad restart count')
  let i = 0
  let key = new Uint8Array(0)
  while (i < end) {
    let shared: number
    let nonshared: number
    let vlen: number
    ;[shared, i] = varint(data, i)
    ;[nonshared, i] = varint(data, i)
    ;[vlen, i] = varint(data, i)
    if (shared > key.length || i + nonshared + vlen > end) throw new Corrupt('bad entry')
    const next = new Uint8Array(shared + nonshared)
    next.set(key.subarray(0, shared))
    next.set(data.subarray(i, i + nonshared), shared)
    key = next
    i += nonshared
    yield [key, data.subarray(i, i + vlen)]
    i += vlen
  }
}

/** Splits an internal key into the user key, the sequence number, and the type (1 is a value, 0 a deletion). */
function splitInternal(ikey: Uint8Array): [Uint8Array, number, number] {
  if (ikey.length < 8) throw new Corrupt('short internal key')
  const t = ikey.length - 8
  let seq = 0
  for (let k = 1; k < 8; k++) seq += ikey[t + k]! * 2 ** (8 * (k - 1))
  return [ikey.subarray(0, t), seq, ikey[t]!]
}

/** Walks every entry in a table (.ldb) file. */
export function* readTable(buf: Uint8Array): Generator<Entry> {
  if (buf.length < 48) throw new Corrupt('not an ldb file')
  for (let k = 0; k < 8; k++) {
    if (buf[buf.length - 8 + k] !== MAGIC[k]) throw new Corrupt('not an ldb file')
  }
  const footer = buf.subarray(buf.length - 48)
  let i = 0
  ;[, i] = varint(footer, i) // metaindex handle, unused
  ;[, i] = varint(footer, i)
  let ioff: number
  let isize: number
  ;[ioff, i] = varint(footer, i)
  ;[isize] = varint(footer, i)
  for (const [, handle] of blockEntries(block(buf, ioff, isize))) {
    const [doff, j] = varint(handle, 0)
    const [dsize] = varint(handle, j)
    for (const [ikey, value] of blockEntries(block(buf, doff, dsize))) {
      const [key, seq, type] = splitInternal(ikey)
      yield { key, seq, type, value }
    }
  }
}

/** Walks the records of a log file, joining records that were split across blocks. */
function* logRecords(buf: Uint8Array): Generator<Uint8Array> {
  let i = 0
  let parts: Uint8Array[] = []
  while (i + 7 <= buf.length) {
    const room = LOG_BLOCK - (i % LOG_BLOCK)
    if (room < 7) {
      i += room // trailer padding
      continue
    }
    const len = u16(buf, i + 4)
    const type = buf[i + 6]
    const frag = buf.subarray(i + 7, i + 7 + len)
    i += 7 + len
    if (type === 0) continue // preallocated space
    if (type === 1) {
      yield frag
      parts = []
    } else if (type === 2) {
      parts = [frag]
    } else if (type === 3) {
      parts.push(frag)
    } else if (type === 4) {
      parts.push(frag)
      yield concat(parts)
      parts = []
    } else {
      return // trailing garbage
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Walks every write in a log (.log) file, in order. */
export function* readLog(buf: Uint8Array): Generator<Entry> {
  for (const rec of logRecords(buf)) {
    if (rec.length < 12) continue
    let seq = 0
    for (let k = 0; k < 8; k++) seq += rec[k]! * 2 ** (8 * k)
    const count = u32(rec, 8)
    let i = 12
    for (let n = 0; n < count && i < rec.length; n++) {
      const type = rec[i++]!
      let klen: number
      ;[klen, i] = varint(rec, i)
      const key = rec.subarray(i, i + klen)
      i += klen
      let value: Uint8Array = new Uint8Array(0)
      if (type === 1) {
        let vlen: number
        ;[vlen, i] = varint(rec, i)
        value = rec.subarray(i, i + vlen)
        i += vlen
      } else if (type !== 0) {
        break // unknown record type: stop this batch
      }
      yield { key, seq: seq + n, type, value }
    }
  }
}

export type StoreFile = { name: string; bytes: Uint8Array }
type Live = { value: Uint8Array; source: string }

/**
 * Builds the current value of every key in a store from its table and log
 * files. The newest write (highest sequence number) wins, and a deletion
 * removes the key. A file that doesn't parse is skipped. Better to come up
 * empty than to report a wrong value.
 */
export function snapshot(files: Iterable<StoreFile>): Map<string, Live> {
  const latest = new Map<string, { seq: number; type: number; value: Uint8Array; source: string }>()
  const decoder = new TextDecoder()
  for (const file of files) {
    const reader = file.name.endsWith('.log') ? readLog : file.name.endsWith('.ldb') ? readTable : undefined
    if (!reader) continue
    try {
      for (const { key, seq, type, value } of reader(file.bytes)) {
        const k = decoder.decode(key)
        const held = latest.get(k)
        if (!held || seq > held.seq) latest.set(k, { seq, type, value, source: file.name })
      }
    } catch {
      continue
    }
  }
  const out = new Map<string, Live>()
  for (const [k, { type, value, source }] of latest) {
    if (type === 1) out.set(k, { value, source })
  }
  return out
}

/** Reads a chrome.storage value as a string. Returns '' if the key is missing or the value isn't a JSON string. */
export function jsonString(snap: Map<string, Live>, key: string): string {
  const held = snap.get(key)
  if (!held) return ''
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(held.value))
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}
