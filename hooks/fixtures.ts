// Builds LevelDB files for the tests: a table (.ldb) with prefix-compressed
// keys and optional snappy compression, and a log (.log). Only the tests use
// this. It's small and slow, but it writes the same formats leveldb.ts
// reads.

const MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 4096) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 4096))
  }
  return btoa(bin)
}

function varintBytes(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}

function u32Bytes(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function u64Bytes(n: number): number[] {
  const out: number[] = []
  for (let k = 0; k < 8; k++) {
    out.push(n % 256)
    n = Math.floor(n / 256)
  }
  return out
}

/** A simple snappy encoder. It takes the longest back-reference it can find at each position, 4 to 64 bytes. */
export function snappyEncode(src: Uint8Array): Uint8Array {
  const out: number[] = varintBytes(src.length)
  let literal: number[] = []
  const flush = () => {
    for (let i = 0; i < literal.length; i += 60) {
      const chunk = literal.slice(i, i + 60)
      out.push((chunk.length - 1) << 2, ...chunk)
    }
    literal = []
  }
  let i = 0
  while (i < src.length) {
    let bestLen = 0
    let bestOff = 0
    for (let off = 1; off <= Math.min(i, 2047); off++) {
      let len = 0
      while (len < 64 && i + len < src.length && src[i + len] === src[i + len - off]) len++
      if (len > bestLen) {
        bestLen = len
        bestOff = off
      }
    }
    if (bestLen >= 4) {
      flush()
      if (bestLen <= 11) {
        out.push(((bestLen - 4) << 2) | ((bestOff >> 8) << 5) | 1, bestOff & 0xff)
      } else {
        out.push(((bestLen - 1) << 2) | 2, bestOff & 0xff, bestOff >> 8)
      }
      i += bestLen
    } else {
      literal.push(src[i++]!)
    }
  }
  flush()
  return Uint8Array.from(out)
}

export type TableEntry = { key: string; seq: number; type?: number; value?: string }

function internalKey(entry: TableEntry): number[] {
  const type = entry.type ?? 1
  const trailer = u64Bytes(entry.seq * 256 + type)
  return [...utf8(entry.key), ...trailer]
}

/** Writes a block of entries, each key stored as a diff against the previous one. */
function buildBlock(entries: [number[], number[]][]): number[] {
  const out: number[] = []
  let prev: number[] = []
  for (const [key, value] of entries) {
    let shared = 0
    while (shared < prev.length && shared < key.length && prev[shared] === key[shared]) shared++
    out.push(...varintBytes(shared), ...varintBytes(key.length - shared), ...varintBytes(value.length))
    out.push(...key.slice(shared), ...value)
    prev = key
  }
  out.push(...u32Bytes(0), ...u32Bytes(1)) // one restart point, at 0
  return out
}

/**
 * Writes a complete table file holding `entries`, which must be in key order.
 * Blocks are snappy-compressed when `compress` is set. The CRCs are zeros;
 * the reader doesn't check them.
 */
export function buildTable(entries: TableEntry[], { compress = true } = {}): Uint8Array {
  const file: number[] = []
  const put = (raw: number[]): [number, number] => {
    const off = file.length
    const data = compress ? [...snappyEncode(Uint8Array.from(raw))] : raw
    file.push(...data, compress ? 1 : 0, 0, 0, 0, 0)
    return [off, data.length]
  }
  const data = buildBlock(entries.map(e => [internalKey(e), [...utf8(e.value ?? '')]]))
  const [dataOff, dataSize] = put(data)
  const [metaOff, metaSize] = put(buildBlock([]))
  const last = internalKey(entries[entries.length - 1]!)
  const [idxOff, idxSize] = put(buildBlock([[last, [...varintBytes(dataOff), ...varintBytes(dataSize)]]]))
  const footer = [...varintBytes(metaOff), ...varintBytes(metaSize), ...varintBytes(idxOff), ...varintBytes(idxSize)]
  while (footer.length < 40) footer.push(0)
  file.push(...footer, ...MAGIC)
  return Uint8Array.from(file)
}

export type LogWrite = { key: string; value?: string } // no value: a deletion
export type LogBatch = { seq: number; writes: LogWrite[] }

/** Writes a log file with one record per batch. */
export function buildLog(batches: LogBatch[]): Uint8Array {
  const file: number[] = []
  for (const batch of batches) {
    const payload = [...u64Bytes(batch.seq), ...u32Bytes(batch.writes.length)]
    for (const write of batch.writes) {
      const key = [...utf8(write.key)]
      if (write.value === undefined) {
        payload.push(0, ...varintBytes(key.length), ...key)
      } else {
        const value = [...utf8(write.value)]
        payload.push(1, ...varintBytes(key.length), ...key, ...varintBytes(value.length), ...value)
      }
    }
    file.push(0, 0, 0, 0, payload.length & 0xff, payload.length >> 8, 1, ...payload)
  }
  return Uint8Array.from(file)
}

/** The keys a real extension store has around the pairing record, so prefix compression gets exercised. */
export function storeEntries(deviceId: string, displayName: string, seq = 100): TableEntry[] {
  return [
    { key: 'anonymousId', seq: seq + 1, value: '"c7ad2894-6327-4174-98d4-a29a2fd603cc"' },
    { key: 'bridgeDefaultDisplayName', seq: seq + 2, value: '"Someone’s MacBook Pro"' },
    { key: 'bridgeDeviceId', seq: seq + 3, value: `"${deviceId}"` },
    { key: 'bridgeDisplayName', seq: seq + 4, value: `"${displayName}"` },
    { key: 'browserControlPermissionAccepted', seq: seq + 5, value: 'true' },
    { key: 'codeVerifier', seq: seq + 6, value: '"KN9KpTCW2hdYFmDPMdcEN7TmEbX6j3ajENnYFfuz5H4"' },
  ]
}
