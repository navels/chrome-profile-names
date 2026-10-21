// Works out which Chrome profile each device ID belongs to, from Chrome's own
// files. `Local State` lists the profiles. Inside each profile, the
// extension's storage holds the device ID it got when it was paired and the
// name you typed at the time.

import type { EngineInterface } from 'claude-code'

import { jsonString, snapshot, type StoreFile } from './leveldb'

const CLAUDE_EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const KEY_DEVICE = 'bridgeDeviceId'
const KEY_NAME = 'bridgeDisplayName' // what the person typed at pair time
const KEY_DEFAULT_NAME = 'bridgeDefaultDisplayName' // the extension's suggestion
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_READ = 4 * 1024 * 1024 // $.fs.read's limit

/** What to show for a paired browser: the name you gave it, and which profile it is. */
export type Profile = { name: string; profile: string }
export type ProfileMap = Map<string, Profile> // by deviceId, lowercase

/** Where Chrome-family browsers keep their data on each OS. Only the directories that exist are used. */
async function chromeRoots($: EngineInterface): Promise<[string, string][]> {
  const home = await $.env.get('HOME')
  const localAppData = await $.env.get('LOCALAPPDATA')
  const candidates: [string, string][] = []
  if (home) {
    const mac = `${home}/Library/Application Support`
    candidates.push(
      ['Chrome', `${mac}/Google/Chrome`],
      ['Chrome Beta', `${mac}/Google/Chrome Beta`],
      ['Chrome Canary', `${mac}/Google/Chrome Canary`],
      ['Chromium', `${mac}/Chromium`],
      ['Edge', `${mac}/Microsoft Edge`],
      ['Brave', `${mac}/BraveSoftware/Brave-Browser`],
      ['Chrome', `${home}/.config/google-chrome`],
      ['Chrome Beta', `${home}/.config/google-chrome-beta`],
      ['Chromium', `${home}/.config/chromium`],
      ['Chromium (snap)', `${home}/snap/chromium/common/chromium`],
      ['Chromium (flatpak)', `${home}/.var/app/org.chromium.Chromium/config/chromium`],
      ['Edge', `${home}/.config/microsoft-edge`],
      ['Brave', `${home}/.config/BraveSoftware/Brave-Browser`],
    )
  }
  if (localAppData) {
    const win = localAppData.replaceAll('\\', '/')
    candidates.push(
      ['Chrome', `${win}/Google/Chrome/User Data`],
      ['Chrome Beta', `${win}/Google/Chrome Beta/User Data`],
      ['Chrome Canary', `${win}/Google/Chrome SxS/User Data`],
      ['Chromium', `${win}/Chromium/User Data`],
      ['Edge', `${win}/Microsoft/Edge/User Data`],
      ['Brave', `${win}/BraveSoftware/Brave-Browser/User Data`],
    )
  }
  const roots: [string, string][] = []
  for (const [label, root] of candidates) {
    try {
      if (await $.fs.exists(`${root}/Local State`)) roots.push([label, root])
    } catch (error) {
      $.ui.log(`chrome-profile-names: cannot check ${root}: ${String(error).slice(0, 200)}`, { to: 'debug' })
    }
  }
  if (!home && !localAppData) $.ui.log('chrome-profile-names: neither HOME nor LOCALAPPDATA is set', { to: 'debug' })
  return roots
}

/** Reads each profile's name and email from Chrome's Local State file, keyed by profile folder. */
async function profileNames($: EngineInterface, root: string): Promise<Map<string, { name: string; email: string }>> {
  const out = new Map<string, { name: string; email: string }>()
  let state: unknown
  try {
    state = JSON.parse(await $.fs.read(`${root}/Local State`))
  } catch {
    return out
  }
  const cache = (state as { profile?: { info_cache?: unknown } })?.profile?.info_cache
  if (typeof cache !== 'object' || cache === null) return out
  for (const [folder, info] of Object.entries(cache as Record<string, unknown>)) {
    if (typeof info !== 'object' || info === null) continue
    const { name, user_name } = info as { name?: unknown; user_name?: unknown }
    out.set(folder, {
      name: typeof name === 'string' && name ? name : folder,
      email: typeof user_name === 'string' ? user_name : '',
    })
  }
  return out
}

/** Decodes standard base64 to bytes. `atob` is available to a hooks module. */
export function fromBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Reads the store's table and log files as bytes. Files that are too big or can't be read are skipped. */
async function storeFiles($: EngineInterface, store: string): Promise<StoreFile[]> {
  const files: StoreFile[] = []
  for (const entry of await $.fs.list(store)) {
    if (entry.kind !== 'file' || !(entry.name.endsWith('.ldb') || entry.name.endsWith('.log'))) continue
    if (entry.size > MAX_READ) {
      $.ui.log(`chrome-profile-names: ${store}/${entry.name} is over 4 MiB, skipped`, { to: 'debug' })
      continue
    }
    try {
      const { base64 } = await $.fs.read(`${store}/${entry.name}`, { as: 'bytes' })
      files.push({ name: entry.name, bytes: fromBase64(base64) })
    } catch {
      continue
    }
  }
  return files
}

/** Reads the device ID and display name from one profile's extension store, if it was ever paired. */
async function pairing($: EngineInterface, store: string): Promise<{ deviceId: string; displayName: string } | undefined> {
  let files: StoreFile[]
  try {
    files = await storeFiles($, store)
  } catch {
    return undefined
  }
  const snap = snapshot(files)
  const deviceId = jsonString(snap, KEY_DEVICE).trim().toLowerCase()
  if (!FULL_UUID.test(deviceId)) return undefined
  return { deviceId, displayName: jsonString(snap, KEY_NAME) || jsonString(snap, KEY_DEFAULT_NAME) }
}

/** Finds every paired browser on this machine, keyed by device ID. */
export async function scan($: EngineInterface): Promise<ProfileMap> {
  const map: ProfileMap = new Map()
  for (const [browser, root] of await chromeRoots($)) {
    for (const [folder, { name, email }] of await profileNames($, root)) {
      const store = `${root}/${folder}/Local Extension Settings/${CLAUDE_EXT_ID}`
      if (!(await $.fs.exists(store).catch(() => false))) continue
      const paired = await pairing($, store)
      if (!paired) continue
      const who = email ? `${name} <${email}>` : name
      map.set(paired.deviceId, { name: paired.displayName || name, profile: `${who}, ${browser} / ${folder}` })
    }
  }
  return map
}
