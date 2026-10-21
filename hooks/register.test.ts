import { expect, test } from 'claude-code/testing'

import { buildLog, buildTable, storeEntries, toBase64, utf8 } from './fixtures'

const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
const HOME = '3f9c1a2e-5b7d-4c8e-9a1f-2d4b6e8c0a13'
const WORK = '7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64'
const OTHER = 'e5b8c3d1-2a7f-4e9b-b6c4-9d0e1f2a3b4c'
const EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const ROOT = '/h/Library/Application Support/Google/Chrome'

const NOW = 1_700_000_000_000
const FIVE_HOURS_AGO = NOW - 5 * 3_600_000

const LIST_TEXT =
  `[{"deviceId":"${HOME}","name":"Browser 1","osPlatform":"macOS","isLocal":true},` +
  `{"deviceId":"${OTHER}","name":"Browser 2","osPlatform":"macOS","connectedAt":${FIVE_HOURS_AGO},"isLocal":true}]`
const LIST_NOTE = '2 browsers are connected and none is selected for this session.'

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** A fake Chrome on disk: two profiles paired, one with the extension but never paired, one without it. */
type Store = { names?: Record<string, string> }

function fakeChrome(on: On, { homeSet = true, touched = { disk: false }, kept = {} as Store } = {}) {
  const text = new Map<string, string>()
  const bytes = new Map<string, Uint8Array>()
  const dirs = new Map<string, string[]>()
  text.set(`${ROOT}/Local State`, JSON.stringify({
    profile: { info_cache: {
      Default: { name: 'Lee', user_name: 'lee@example.com' },
      'Profile 1': { name: 'Acme', user_name: 'lee@acme.example' },
      'Profile 2': { name: 'Spare', user_name: '' },
      'Profile 3': { name: 'No extension' },
    } },
  }))
  const store = (folder: string, files: Record<string, Uint8Array>) => {
    const dir = `${ROOT}/${folder}/Local Extension Settings/${EXT}`
    dirs.set(dir, Object.keys(files))
    for (const [name, data] of Object.entries(files)) bytes.set(`${dir}/${name}`, data)
  }
  store('Default', {
    '000005.ldb': buildTable(storeEntries(HOME, 'Home')),
    '000007.log': buildLog([{ seq: 300, writes: [{ key: 'selectedModel', value: '"x"' }] }]),
    'MANIFEST-000001': utf8('manifest'),
  })
  store('Profile 1', { '000003.log': buildLog([{ seq: 1, writes: [
    { key: 'bridgeDeviceId', value: `"${WORK}"` }, { key: 'bridgeDisplayName', value: '"Work"' },
  ] }]) })
  store('Profile 2', { '000003.log': buildLog([{ seq: 1, writes: [{ key: 'anonymousId', value: '"x"' }] }]) })

  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_, e) => ({ value: e.key === 'remoteNames' ? kept.names : undefined }))
  on('store.set', (_, e) => {
    if (e.key === 'remoteNames') kept.names = e.value as Record<string, string>
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' && homeSet ? '/h' : undefined }))
  on('fs.exists', (_, e) => {
    touched.disk = true
    return { value: text.has(e.path) || dirs.has(e.path) }
  })
  on('fs.list', (_, e) => ({
    value: (dirs.get(e.path) ?? []).map(name => ({
      name, kind: 'file' as const, size: bytes.get(`${e.path}/${name}`)!.length, mtimeMs: 1, isLink: false,
    })),
  }))
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') {
      const data = bytes.get(e.path)
      return data ? { value: { base64: toBase64(data) } } : { deny: 'ENOENT' }
    }
    const data = text.get(e.path)
    return data !== undefined ? { value: data } : { deny: 'ENOENT' }
  })
}

/** The text of the first block of a tool's MCP-shaped result. */
function textOf(result: unknown): string {
  const blocks = Array.isArray(result) ? result : (result as { content: unknown[] }).content
  return (blocks[0] as { text: string }).text
}

const CONFIRM = 'Open a confirmation screen in every connected Chrome extension and let me select the right one there.'

test('local browsers get Chrome names; a browser on another computer is marked as such', async ($, on) => {
  fakeChrome(on)
  // The engine hands an MCP result over as its content blocks.
  on('tool.call', () => ({ result: [{ type: 'text', text: LIST_TEXT }, { type: 'text', text: LIST_NOTE }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const text = textOf(ran.result)
  expect(text).toContain(`"deviceId":"${HOME}","name":"Home"`)
  expect(text).toContain('"profile":"Lee <lee@example.com>, Chrome / Default"')
  expect(text).toContain(`"deviceId":"${OTHER}","name":"Browser 2"`)
  expect(text).toContain('"where":"another computer (macOS), connected 5 hours ago"')
  expect((ran.result as unknown[])[1]).toEqual({ type: 'text', text: LIST_NOTE })
})

test('a remote browser that was named before gets that name', async ($, on) => {
  fakeChrome(on, { kept: { names: { [OTHER]: 'mini' } } })
  on('tool.call', () => ({ result: [{ type: 'text', text: LIST_TEXT }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toContain(`"deviceId":"${OTHER}","name":"mini"`)
  expect(textOf(ran.result)).toContain('"where":"another computer (macOS), connected 5 hours ago"')
})

test('the sentence after the list gets the name and says "selected"', async ($, on) => {
  fakeChrome(on)
  const inUse = `[{"deviceId":"${WORK}","name":"Browser 1","inUse":true},{"deviceId":"${HOME}","name":"Browser 2"}]`
  const prose = `2 browsers are connected; "Browser 1" (deviceId ${WORK}) is the one in use for this session. No question is needed.`
  on('tool.call', () => ({ result: [{ type: 'text', text: inUse }, { type: 'text', text: prose }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const blocks = ran.result as { text: string }[]
  expect(blocks[1]?.text).toBe(`2 browsers are connected; "Work" (deviceId ${WORK}) is the one selected for this session. No question is needed.`)
  expect(blocks[0]?.text).toContain(`"name":"Work","inUse":true`)
})

test('a list with no local browser is still rewritten, as long as this machine has profiles', async ($, on) => {
  fakeChrome(on)
  const onlyRemote = `[{"deviceId":"${OTHER}","name":"Browser 1","osPlatform":"macOS","isLocal":true}]`
  on('tool.call', () => ({ result: [{ type: 'text', text: onlyRemote }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toBe(`[{"deviceId":"${OTHER}","name":"Browser 1","osPlatform":"macOS","isLocal":true,"where":"another computer (macOS)"}]`)
})

test('a { content } shaped result is relabeled too', async ($, on) => {
  fakeChrome(on)
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: LIST_TEXT }], isError: false } }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toContain(`"deviceId":"${HOME}","name":"Home"`)
})

test('a result the server reported as an error is left alone', async ($, on) => {
  fakeChrome(on)
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: LIST_TEXT }], isError: true } }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toContain('"name":"Browser 1"')
})

test('a call the engine reported as an error is left alone', async ($, on) => {
  fakeChrome(on)
  on('tool.call', () => ({ isError: true, result: LIST_TEXT, text: LIST_TEXT }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(ran.isError).toBe(true)
  expect(String(ran.result)).toContain('"name":"Browser 1"')
})

test('the picker shows Chrome names for local browsers and marks remote ones', async ($, on) => {
  fakeChrome(on, { kept: { names: { [OTHER]: 'mini' } } })
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${WORK})`, description: 'macOS, local' },
      { label: `Browser 2 (${OTHER})`, description: 'macOS' },
      { label: CONFIRM, description: '' },
    ] }],
  })
  const options = (ran.result as { options: { label: string; description: string }[] }[])[0]?.options ?? []
  expect(options.map(o => o.label)).toEqual([`Work (${WORK})`, `mini (${OTHER})`, CONFIRM])
  expect(options[0]?.description).toBe('macOS, local (Acme <lee@acme.example>, Chrome / Profile 1)')
  expect(options[1]?.description).toBe('macOS (another computer)')
})

test('an unnamed remote browser keeps its label and is marked as on another computer', async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${HOME})`, description: '' },
      { label: `Browser 2 (${OTHER})`, description: '' },
    ] }],
  })
  const options = (ran.result as { options: { label: string; description: string }[] }[])[0]?.options ?? []
  expect(options[1]).toEqual({ label: `Browser 2 (${OTHER})`, description: 'another computer' })
})

test('the selected browser is marked in the picker, and "in use" becomes "selected"', async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => e.tool === LIST_TOOL
    ? { result: [{ type: 'text', text: `[{"deviceId":"${WORK}","name":"Browser 1","inUse":true},{"deviceId":"${HOME}","name":"Browser 2"}]` }] }
    : { result: e.tool === 'AskUserQuestion' ? e.questions : null })

  await $.tool.call({ tool: LIST_TOOL })
  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${WORK})`, description: 'Currently in use.' },
      { label: `Browser 2 (${HOME})`, description: '' },
    ] }],
  })
  const options = (ran.result as { options: { label: string; description: string }[] }[])[0]?.options ?? []
  expect(options[0]?.description).toBe('Currently selected. (Acme <lee@acme.example>, Chrome / Profile 1)')
  expect(options[1]?.description).toBe('Lee <lee@example.com>, Chrome / Default')
})

test('choosing a browser answers with its name and marks it selected afterwards', async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => e.tool === SELECT_TOOL
    ? { result: [{ type: 'text', text: 'Selected browser "Browser 2".' }] }
    : { result: e.tool === 'AskUserQuestion' ? e.questions : null })

  const chose = await $.tool.call({ tool: SELECT_TOOL, deviceId: HOME })
  expect(textOf(chose.result)).toBe('Selected browser "Home".')

  const asked = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${WORK})`, description: '' },
      { label: `Browser 2 (${HOME})`, description: '' },
    ] }],
  })
  const options = (asked.result as { options: { description: string }[] }[])[0]?.options ?? []
  expect(options[1]?.description).toBe('Lee <lee@example.com>, Chrome / Default Selected now.')
})

/** Stands for the engine beneath the mod: answers select_browser, and answers the mod's own question with `reply`. */
function engineThatAnswers(on: On, reply: string, asked: string[] = []) {
  on('tool.call', (_, e) => {
    if (e.tool === SELECT_TOOL) return { result: [{ type: 'text', text: 'Selected browser "Browser 2".' }] }
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]!.question
      asked.push(question)
      return { result: { questions: e.questions, answers: { [question]: reply } } }
    }
    return { result: null }
  })
  return asked
}

test('picking an unnamed browser on another computer asks for a name and remembers it', async ($, on) => {
  const store: Store = {}
  fakeChrome(on, { kept: store })
  const asked = engineThatAnswers(on, 'mini')

  const chose = await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(asked).toEqual([`This browser is on another computer (${OTHER}). What should it be called from now on?`])
  expect(store.names).toEqual({ [OTHER]: 'mini' })
  expect(textOf(chose.result)).toBe('Selected browser "mini".')

  // Named now: picking it again asks nothing.
  await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(asked.length).toBe(1)
})

test('"Skip for now" remembers nothing, so it is asked again', async ($, on) => {
  const store: Store = {}
  fakeChrome(on, { kept: store })
  const asked = engineThatAnswers(on, 'Skip for now')

  const chose = await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(store.names).toBeUndefined()
  expect(textOf(chose.result)).toBe('Selected browser "Browser 2".')
  await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(asked.length).toBe(2)
})

test('"Don\'t ask again" is remembered, and the browser stays unnamed', async ($, on) => {
  const store: Store = {}
  fakeChrome(on, { kept: store })
  const asked = engineThatAnswers(on, "Don't ask again")

  await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(store.names).toEqual({ [OTHER]: '' })
  const chose = await $.tool.call({ tool: SELECT_TOOL, deviceId: OTHER })
  expect(asked.length).toBe(1)
  expect(textOf(chose.result)).toBe('Selected browser "Browser 2".')
})

test('picking a local browser never asks', async ($, on) => {
  fakeChrome(on)
  const asked = engineThatAnswers(on, 'unused')

  const chose = await $.tool.call({ tool: SELECT_TOOL, deviceId: HOME })
  expect(asked).toEqual([])
  expect(textOf(chose.result)).toBe('Selected browser "Home".')
})

/** Brings the session up so the command is registered. */
async function startSession($: Parameters<Parameters<typeof test>[1] extends infer B ? Extract<B, (...a: never[]) => unknown> : never>[0], on: On) {
  on('command.register', () => ({ value: { command: 'browser-names' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('/browser-names lists, names, renames and forgets', async ($, on) => {
  const store: Store = { names: { [OTHER]: 'mini', '7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64': '' } }
  fakeChrome(on, { kept: store })
  await startSession($, on)
  const run = async (args: string) => (await $.command.run({
    command: 'browser-names', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
  })).text ?? ''

  expect(await run('')).toBe(`Browsers on other computers:\n  ${OTHER}  mini\n  7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64  (not named; not asked again)`)
  expect(await run('e5b8c3d1 the mini')).toBe(`${OTHER} is now "the mini".`)
  expect(store.names?.[OTHER]).toBe('the mini')
  expect(await run('7a2d9e40 laptop')).toBe('7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64 is now "laptop".')
  expect(await run(`forget ${OTHER}`)).toBe(`Forgot ${OTHER}. You'll be asked for a name the next time you pick it.`)
  expect(store.names).toEqual({ '7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64': 'laptop' })
})

test('/browser-names explains itself and refuses bad ids', async ($, on) => {
  const store: Store = { names: { [OTHER]: 'mini', [WORK]: 'twin' } }
  fakeChrome(on, { kept: store })
  await startSession($, on)
  const run = async (args: string) => (await $.command.run({
    command: 'browser-names', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
  })).text ?? ''

  expect(await run('mini')).toContain('/browser-names <id> <name>')
  expect(await run('xyz name')).toBe('"xyz" isn\'t a device id (at least 8 hex characters).')
  expect(await run('deadbeef name')).toBe('No named browser starts with "deadbeef".')
  expect(await run('forget 00000000-0000-4000-8000-000000000000')).toBe('No name was stored for 00000000-0000-4000-8000-000000000000.')
  // A full id that is not stored yet can still be named outright.
  expect(await run('00000000-0000-4000-8000-000000000000 spare')).toBe('00000000-0000-4000-8000-000000000000 is now "spare".')
  expect(store.names?.['00000000-0000-4000-8000-000000000000']).toBe('spare')
})

test('a question with no device ids is passed through without touching the disk', async ($, on) => {
  const touched = { disk: false }
  fakeChrome(on, { touched })
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  const questions = [{ question: 'Tea?', header: 'Drink', multiSelect: false,
    options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }]
  const ran = await $.tool.call({ tool: 'AskUserQuestion', questions })
  expect(ran.result).toEqual(questions)
  expect(touched.disk).toBe(false)
})

test('with no Chrome on disk, everything passes through', async ($, on) => {
  fakeChrome(on, { homeSet: false })
  on('tool.call', () => ({ result: [{ type: 'text', text: LIST_TEXT }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toBe(LIST_TEXT)
})
