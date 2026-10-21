import type { EngineInterface, Register } from 'claude-code'

import { scan, type ProfileMap } from './profiles'

// The Claude in Chrome extension calls connected browsers "Browser 1" and
// "Browser 2" and tells them apart by a device ID. Chrome knows more: which
// profile the browser is, and the name you typed when you paired it. This
// mod shows those names instead. A browser that isn't paired in any Chrome
// profile on this machine is on another computer; it's shown as such, and
// the first time you pick one the mod asks what to call it and remembers.

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

const NAMES_KEY = 'remoteNames' // in $.store, kept across sessions: { [deviceId]: name }, '' meaning "don't ask"
const SKIP = 'Skip for now'
const NEVER = "Don't ask again"

/** Names given to browsers on other computers, from the mod's own store. */
async function remoteNames($: EngineInterface): Promise<Map<string, string>> {
  const held = await $.store.get(NAMES_KEY)
  const names = new Map<string, string>()
  if (typeof held === 'object' && held !== null) {
    for (const [id, name] of Object.entries(held)) {
      if (typeof name === 'string') names.set(id.toLowerCase(), name)
    }
  }
  return names
}

/**
 * Asks what to call a browser on another computer, the first time it's
 * picked, and remembers the answer. "Skip for now" asks again another time;
 * "Don't ask again" remembers that instead. A dismissed dialog counts as skip.
 */
async function askRemoteName($: EngineInterface, id: string): Promise<void> {
  const names = await remoteNames($)
  if (names.has(id)) return
  let answer: string
  try {
    answer = await $.ui.ask(
      `This browser is on another computer (${id}). What should it be called from now on?`,
      { options: [SKIP, NEVER], header: 'Browser name' },
    )
  } catch {
    return
  }
  if (answer === SKIP || answer.trim() === '') return
  names.set(id, answer === NEVER ? '' : answer.trim())
  await $.store.set(NAMES_KEY, Object.fromEntries(names))
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
    return remote ? { name: remote, where: ELSEWHERE, local: false } : undefined // '' (don't ask) is unnamed
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
async function lookupFor($: EngineInterface): Promise<Lookup | undefined> {
  const map = await profiles($)
  return map.size === 0 ? undefined : lookupWith(map, await remoteNames($))
}

export const register: Register = on => {

  // The extension's list. Fixing it here means the right name shows up
  // everywhere Claude mentions the browser, not just in the picker.
  on('tool.call', { tool: LIST_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const lookup = await lookupFor($)
    if (!lookup) return ran
    const now = await $.clock.now()
    const result = mapResult(ran.result, text => rewriteList(text, lookup, now))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // Picking a browser. The extension answers `Selected browser "Browser 2"`.
  // A browser on another computer with no name yet gets asked for one here.
  on('tool.call', { tool: SELECT_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = typeof e.deviceId === 'string' ? e.deviceId.toLowerCase() : undefined
    if (!id) return ran
    selected = id
    let lookup = await lookupFor($)
    if (!lookup) return ran
    if (!lookup(id)) {
      await askRemoteName($, id)
      lookup = (await lookupFor($)) ?? lookup
    }
    const known = lookup(id)
    if (!known) return ran
    const result = mapResult(ran.result, text => text.replace(/"Browser \d+"/, `"${known.name}"`))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The confirmation-screen flow answers with the browser you clicked Connect in.
  on('tool.call', { tool: SWITCH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const lookup = await lookupFor($)
    if (!lookup) return ran
    const now = await $.clock.now()
    const result = mapResult(ran.result, text => rewriteList(text, lookup, now))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The picker itself, in case Claude wrote it from memory rather than from the list.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (idsIn(JSON.stringify(e.questions)).length === 0) return next(e)
    const lookup = await lookupFor($)
    if (!lookup) return next(e)
    const questions = e.questions.map(question => ({
      ...question,
      options: question.options.map(option => relabelOption(option, lookup)),
    }))
    return next({ ...e, questions })
  }).catch(($, e, next) => next(e))
}
