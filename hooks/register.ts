import type { EngineInterface, Register } from 'claude-code'

import { scan, type Profile, type ProfileMap } from './profiles'

// The Claude in Chrome extension calls connected browsers "Browser 1" and
// "Browser 2" and tells them apart by a device ID. Chrome knows more: which
// profile the browser is, and the name you typed when you paired it. This
// mod shows those names instead, and hides browsers that aren't paired in
// any Chrome profile on this machine.

const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
const SWITCH_TOOL = 'mcp__claude-in-chrome__switch_browser'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const BROWSER_N = /\bBrowser \d+\b/
const CACHE_MS = 5 * 60 * 1000

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

function idsIn(text: string): string[] {
  return [...new Set((text.match(UUID) ?? []).map(id => id.toLowerCase()))]
}

/** Fixes the sentence the extension writes after its list: `"Browser 2" (deviceId …)` gets the Chrome name, and "in use" becomes "selected". */
function relabelProse(text: string, map: ProfileMap): string {
  return text
    .replace(/"Browser \d+" \(deviceId ([0-9a-f-]{36})\)/gi, (whole, id: string) => {
      const known = map.get(id.toLowerCase())
      return known ? `"${known.name}" (deviceId ${id})` : whole
    })
    .replace(/\bin use\b/g, 'selected')
    .replace(/\bpicked last\b/g, 'selected last')
}

type Listed = { deviceId: string; name?: unknown; inUse?: unknown }

function isListed(x: unknown): x is Listed {
  return typeof x === 'object' && x !== null && typeof (x as Listed).deviceId === 'string'
}

/**
 * Rewrites the extension's browser list. Each browser paired on this machine
 * gets its Chrome name and a `profile` field. With `hide`, the other browsers
 * are dropped, the count after the list is fixed, and a sentence says what
 * was dropped. If no browser in the list is paired here, the list is left
 * alone, because the scanner may just be unable to read that profile. Text
 * with no list in it only gets the sentence fix.
 */
function rewriteList(text: string, map: ProfileMap, hide: boolean): string {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let list: unknown
  try {
    list = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined
  } catch {
    list = undefined
  }
  if (!Array.isArray(list) || !list.every(isListed)) return relabelProse(text, map)

  selected = list.find(b => b.inUse === true)?.deviceId.toLowerCase() ?? selected
  const named = list.map(b => {
    const known = map.get(b.deviceId.toLowerCase())
    return known ? { ...b, name: known.name, profile: known.profile } : b
  })
  const local = named.filter(b => map.has(b.deviceId.toLowerCase()))
  const remote = named.filter(b => !map.has(b.deviceId.toLowerCase()))
  const hiding = hide && local.length > 0 && remote.length > 0
  if (local.length === 0 && !hiding) return relabelProse(text, map)

  let rest = relabelProse(text.slice(end + 1), map)
  let note = ''
  if (hiding) {
    rest = rest.replace(/^\s*\d+ browsers are connected/, `${local.length} browsers are connected`)
    const gone = remote.map(b => `${typeof b.name === 'string' ? b.name : 'unnamed'} (${b.deviceId})`).join(', ')
    note = ` Hidden by chrome-profile-names, not paired in any Chrome profile on this machine: ${gone}.`
  }
  return `${text.slice(0, start)}${JSON.stringify(hiding ? local : named)}${rest}${note}`
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

/** Finds the device ID in an option's label or description, and the profile for it if we have one. */
function profileOf(option: Option, map: ProfileMap): [string, Profile | undefined] | undefined {
  const id = idsIn(`${option.label} ${option.description}`)[0]
  return id === undefined ? undefined : [id, map.get(id)]
}

function relabelOption(option: Option, map: ProfileMap): Option {
  const [id, known] = profileOf(option, map) ?? []
  if (!id || !known) return option
  const { name, profile } = known
  let label = option.label.replace(BROWSER_N, name)
  if (!label.includes(name)) label = `${name} (${label})`
  let description = option.description.replace(BROWSER_N, name).replace(/\bin use\b/gi, 'selected')
  if (!description.includes(profile)) description = description ? `${description} (${profile})` : profile
  if (id === selected && !/\bselected\b/i.test(description)) description = `${description} Selected now.`
  return { ...option, label, description }
}

/**
 * Relabels the picker's options and, with `hide`, drops the ones for
 * browsers on other machines. Options that name no browser (the "open a
 * confirmation screen" one) stay. Nothing is dropped unless at least one
 * local browser remains and the dialog still has its minimum of two options.
 */
function rewriteOptions(options: Option[], map: ProfileMap, hide: boolean): Option[] {
  const named = options.map(option => relabelOption(option, map))
  if (!hide) return named
  const kind = (option: Option) => {
    const found = profileOf(option, map)
    return found === undefined ? 'none' : found[1] === undefined ? 'remote' : 'local'
  }
  const kept = named.filter(option => kind(option) !== 'remote')
  const hasLocal = kept.some(option => kind(option) === 'local')
  return hasLocal && kept.length >= 2 && kept.length < named.length ? kept : named
}

export const register: Register = (on, options) => {
  const hide = options.hideRemote !== false

  // The extension's list. Fixing it here means the right name shows up
  // everywhere Claude mentions the browser, not just in the picker.
  on('tool.call', { tool: LIST_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const map = await profiles($)
    if (map.size === 0) return ran
    const result = mapResult(ran.result, text => rewriteList(text, map, hide))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // Picking a browser. The extension answers `Selected browser "Browser 2"`.
  on('tool.call', { tool: SELECT_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = typeof e.deviceId === 'string' ? e.deviceId.toLowerCase() : undefined
    if (id) selected = id
    const known = id ? (await profiles($)).get(id) : undefined
    if (!known) return ran
    const result = mapResult(ran.result, text => text.replace(/"Browser \d+"/, `"${known.name}"`))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The confirmation-screen flow answers with the browser you clicked Connect in.
  on('tool.call', { tool: SWITCH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const map = await profiles($)
    if (map.size === 0) return ran
    const result = mapResult(ran.result, text => rewriteList(text, map, false))
    return result === undefined ? ran : { result }
  }).catch(($, e, next) => next(e))

  // The picker itself, in case Claude wrote it from memory rather than from the list.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (idsIn(JSON.stringify(e.questions)).length === 0) return next(e)
    const map = await profiles($)
    if (map.size === 0) return next(e)
    const questions = e.questions.map(question => ({ ...question, options: rewriteOptions(question.options, map, hide) }))
    return next({ ...e, questions })
  }).catch(($, e, next) => next(e))
}
