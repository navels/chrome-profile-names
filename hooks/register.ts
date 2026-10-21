import type { EngineInterface, Register } from 'claude-code'

import { scan, type ProfileMap } from './profiles'

// The Claude in Chrome extension calls connected browsers "Browser 1" and
// "Browser 2" and tells them apart by a device ID. Chrome knows more: which
// profile the browser is, and the name you typed when you paired it. This
// mod shows those names instead. A browser that isn't paired in any Chrome
// profile on this machine is on another computer; it's shown as such, with
// the name from the `remoteNames` setting if you gave it one.

const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
const SWITCH_TOOL = 'mcp__claude-in-chrome__switch_browser'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const BROWSER_N = /\bBrowser \d+\b/
const CACHE_MS = 5 * 60 * 1000
const ELSEWHERE = 'another computer'

let cache: { at: number; map: ProfileMap } | undefined
let selected: string | undefined // device ID of the browser this session's actions go to

/** Reads the device ID to profile map from disk. Cached for a few minutes. */
async function profiles($: EngineInterface): Promise<ProfileMap> {
  const now = await $.clock.now()
  if (cache && now - cache.at < CACHE_MS) return cache.map
  let map: ProfileMap = new Map()
  try {
    map = await scan($)
  } catch (error) {
    $.ui.log(`chrome-profile-names: scan failed: ${String(error).slice(0, 200)}`, { to: 'debug' })
  }
  cache = { at: now, map }
  return map
}

/** Names for browsers on other computers, from the `remoteNames` setting: `deviceId=name` entries separated by commas or newlines. */
function parseRemoteNames(setting: unknown): Map<string, string> {
  const entries = typeof setting === 'string' ? setting.split(/[\n,]/) : []
  const names = new Map<string, string>()
  for (const entry of entries) {
    const m = /^\s*([0-9a-f-]{36})\s*[=:]\s*(.+?)\s*$/i.exec(String(entry))
    if (m) names.set(m[1]!.toLowerCase(), m[2]!)
  }
  return names
}

/** What we know about one browser: its name, where it is, and whether it's on this machine. */
type Known = { name: string; where: string; local: boolean }
type Lookup = (id: string) => Known | undefined

function lookupWith(map: ProfileMap, remoteNames: Map<string, string>): Lookup {
  return id => {
    const key = id.toLowerCase()
    const local = map.get(key)
    if (local) return { name: local.name, where: local.profile, local: true }
    const remote = remoteNames.get(key)
    return remote ? { name: remote, where: ELSEWHERE, local: false } : undefined
  }
}

function idsIn(text: string): string[] {
  return [...new Set((text.match(UUID) ?? []).map(id => id.toLowerCase()))]
}

/** "just now", "12 minutes ago", "5 hours ago", "3 days ago". */
function ago(then: number, now: number): string {
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}

/** Fixes the sentence the extension writes after its list: `"Browser 2" (deviceId …)` gets the name, and "in use" becomes "selected". */
function relabelProse(text: string, lookup: Lookup): string {
  return text
    .replace(/"Browser \d+" \(deviceId ([0-9a-f-]{36})\)/gi, (whole, id: string) => {
      const known = lookup(id)
      return known ? `"${known.name}" (deviceId ${id})` : whole
    })
    .replace(/\bin use\b/g, 'selected')
    .replace(/\bpicked last\b/g, 'selected last')
}

type Listed = { deviceId: string; name?: unknown; inUse?: unknown; osPlatform?: unknown; connectedAt?: unknown }

function isListed(x: unknown): x is Listed {
  return typeof x === 'object' && x !== null && typeof (x as Listed).deviceId === 'string'
}

/**
 * Rewrites the extension's browser list. A browser paired on this machine
 * gets its Chrome name and a `profile` field. Any other browser is on
 * another computer: it gets a `where` field saying so, with its OS and how
 * long ago it connected, and the name from `remoteNames` if there is one.
 * Text with no list in it only gets the sentence fix.
 */
function rewriteList(text: string, lookup: Lookup, now: number): string {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let list: unknown
  try {
    list = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined
  } catch {
    list = undefined
  }
  if (!Array.isArray(list) || !list.every(isListed)) return relabelProse(text, lookup)

  selected = list.find(b => b.inUse === true)?.deviceId.toLowerCase() ?? selected
  const rewritten = list.map(b => {
    const known = lookup(b.deviceId)
    if (known?.local) return { ...b, name: known.name, profile: known.where }
    const os = typeof b.osPlatform === 'string' ? ` (${b.osPlatform})` : ''
    const since = typeof b.connectedAt === 'number' ? `, connected ${ago(b.connectedAt, now)}` : ''
    return { ...b, ...(known ? { name: known.name } : {}), where: `${ELSEWHERE}${os}${since}` }
  })
  return `${text.slice(0, start)}${JSON.stringify(rewritten)}${relabelProse(text.slice(end + 1), lookup)}`
}

type Block = { type?: unknown; text?: unknown }

/**
 * Runs `fn` over every text block of a tool result. Returns undefined when
 * the result isn't a shape it knows, so the caller leaves it alone. The
 * engine hands over an MCP result as a plain array of content blocks; a
 * `{ content, isError }` object and a bare string are handled too.
 */
function mapResult(result: unknown, fn: (text: string) => string): unknown {
  const mapBlocks = (blocks: unknown[]) =>
    blocks.map(block =>
      block && typeof block === 'object' && (block as Block).type === 'text' && typeof (block as Block).text === 'string'
        ? { ...block, text: fn((block as { text: string }).text) }
        : block,
    )
  if (typeof result === 'string') return fn(result)
  if (Array.isArray(result)) return mapBlocks(result)
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as { content?: unknown; isError?: unknown }
  if (record.isError === true || !Array.isArray(record.content)) return undefined
  return { ...record, content: mapBlocks(record.content) }
}

type Option = { label: string; description: string; preview?: string }

/**
 * Relabels one picker option. A local browser gets its Chrome name and
 * profile; a remote one is marked as being on another computer, with its
 * name from `remoteNames` if there is one. The browser the session is using
 * is marked selected.
 */
function relabelOption(option: Option, lookup: Lookup): Option {
  const id = idsIn(`${option.label} ${option.description}`)[0]
  if (id === undefined) return option
  const known = lookup(id) ?? { name: undefined, where: ELSEWHERE, local: false }
  let label = option.label
  let description = option.description.replace(/\bin use\b/gi, 'selected')
  if (known.name !== undefined) {
    label = label.replace(BROWSER_N, known.name)
    if (!label.includes(known.name)) label = `${known.name} (${label})`
    description = description.replace(BROWSER_N, known.name)
  }
  if (!description.includes(known.where)) description = description ? `${description} (${known.where})` : known.where
  if (id === selected && !/\bselected\b/i.test(description)) description = `${description} Selected now.`
  return { ...option, label, description }
}

/** The lookup for one call, or undefined when no profile on this machine can be read (then nothing is touched). */
async function lookupFor($: EngineInterface, remoteNames: Map<string, string>): Promise<Lookup | undefined> {
  const map = await profiles($)
  return map.size === 0 ? undefined : lookupWith(map, remoteNames)
}

export const register: Register = (on, options) => {
  const remoteNames = parseRemoteNames(options.remoteNames)

  // The extension's list. Fixing it here means the right name shows up
  // everywhere Claude mentions the browser, not just in the picker.
  on('tool.call', { tool: LIST_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const lookup = await lookupFor($, remoteNames)
    if (!lookup) return ran
    const now = await $.clock.now()
    const result = mapResult(ran.result, text => rewriteList(text, lookup, now))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // Picking a browser. The extension answers `Selected browser "Browser 2"`.
  on('tool.call', { tool: SELECT_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = typeof e.deviceId === 'string' ? e.deviceId.toLowerCase() : undefined
    if (id) selected = id
    const known = id ? (await lookupFor($, remoteNames))?.(id) : undefined
    if (!known) return ran
    const result = mapResult(ran.result, text => text.replace(/"Browser \d+"/, `"${known.name}"`))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The confirmation-screen flow answers with the browser you clicked Connect in.
  on('tool.call', { tool: SWITCH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const lookup = await lookupFor($, remoteNames)
    if (!lookup) return ran
    const now = await $.clock.now()
    const result = mapResult(ran.result, text => rewriteList(text, lookup, now))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The picker itself, in case Claude wrote it from memory rather than from the list.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (idsIn(JSON.stringify(e.questions)).length === 0) return next(e)
    const lookup = await lookupFor($, remoteNames)
    if (!lookup) return next(e)
    const questions = e.questions.map(question => ({
      ...question,
      options: question.options.map(option => relabelOption(option, lookup)),
    }))
    return next({ ...e, questions })
  }).catch(($, e, next) => next(e))
}
