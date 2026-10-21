import { expect, test } from 'claude-code/testing'

import { buildLog, buildTable, snappyEncode, storeEntries, utf8 } from './fixtures'
import { jsonString, readLog, readTable, snappyDecode, snapshot } from './leveldb'

const HOME = '3f9c1a2e-5b7d-4c8e-9a1f-2d4b6e8c0a13'

test('snappy round-trips text with repeats, copies included', async () => {
  const text = 'bridgeDefaultDisplayName bridgeDeviceId bridgeDisplayName ' + 'abcd'.repeat(40)
  const packed = snappyEncode(utf8(text))
  expect(packed.length).toBeLessThan(text.length)
  expect(new TextDecoder().decode(snappyDecode(packed))).toBe(text)
})

test('a compressed table yields every key with prefix compression undone', async () => {
  const keys = [...readTable(buildTable(storeEntries(HOME, 'Home')))].map(e => new TextDecoder().decode(e.key))
  expect(keys).toEqual([
    'anonymousId', 'bridgeDefaultDisplayName', 'bridgeDeviceId', 'bridgeDisplayName',
    'browserControlPermissionAccepted', 'codeVerifier',
  ])
})

test('the snapshot of a table finds the pairing record', async () => {
  for (const compress of [true, false]) {
    const snap = snapshot([{ name: '000005.ldb', bytes: buildTable(storeEntries(HOME, 'Home'), { compress }) }])
    expect(jsonString(snap, 'bridgeDeviceId')).toBe(HOME)
    expect(jsonString(snap, 'bridgeDisplayName')).toBe('Home')
    expect(jsonString(snap, 'browserControlPermissionAccepted')).toBe('') // not a string
  }
})

test('a newer log write wins over the table, and a deletion removes the key', async () => {
  const table = buildTable(storeEntries(HOME, 'Home', 100))
  const log = buildLog([
    { seq: 200, writes: [{ key: 'bridgeDisplayName', value: '"Renamed"' }] },
    { seq: 201, writes: [{ key: 'codeVerifier' }] },
  ])
  const writes = [...readLog(log)]
  expect(writes.map(w => [new TextDecoder().decode(w.key), w.seq, w.type])).toEqual([
    ['bridgeDisplayName', 200, 1], ['codeVerifier', 201, 0],
  ])
  const snap = snapshot([{ name: '000005.ldb', bytes: table }, { name: '000007.log', bytes: log }])
  expect(jsonString(snap, 'bridgeDisplayName')).toBe('Renamed')
  expect(jsonString(snap, 'bridgeDeviceId')).toBe(HOME)
  expect(snap.has('codeVerifier')).toBe(false)
})

test('an older log write loses to the table', async () => {
  const table = buildTable(storeEntries(HOME, 'Home', 100))
  const log = buildLog([{ seq: 5, writes: [{ key: 'bridgeDisplayName', value: '"Stale"' }] }])
  const snap = snapshot([{ name: '000007.log', bytes: log }, { name: '000005.ldb', bytes: table }])
  expect(jsonString(snap, 'bridgeDisplayName')).toBe('Home')
})

test('a file that does not parse is skipped, not fatal', async () => {
  const snap = snapshot([
    { name: '000001.ldb', bytes: utf8('not a table at all, just some bytes that are long enough to look at') },
    { name: '000002.log', bytes: buildLog([{ seq: 1, writes: [{ key: 'bridgeDeviceId', value: `"${HOME}"` }] }]) },
    { name: 'MANIFEST-000001', bytes: utf8('ignored') },
  ])
  expect(jsonString(snap, 'bridgeDeviceId')).toBe(HOME)
})
