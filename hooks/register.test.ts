import { expect, test } from 'claude-code/testing'

import { buildLog, buildTable, storeEntries, toBase64, utf8 } from './fixtures'

const LIST_TOOL = 'mcp__claude-in-chrome__list_connected_browsers'
const SELECT_TOOL = 'mcp__claude-in-chrome__select_browser'
const HOME = '3f9c1a2e-5b7d-4c8e-9a1f-2d4b6e8c0a13'
const WORK = '7a2d9e40-c6b1-4f3a-8e5d-1b9c3a7f2e64'
const OTHER = 'e5b8c3d1-2a7f-4e9b-b6c4-9d0e1f2a3b4c'
const EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const ROOT = '/h/Library/Application Support/Google/Chrome'

const LIST_TEXT =
  `[{"deviceId":"${HOME}","name":"Browser 1","osPlatform":"macOS","isLocal":true},` +
  `{"deviceId":"${OTHER}","name":"Browser 2","osPlatform":"macOS","isLocal":true}]`
const LIST_NOTE = '2 browsers are connected and none is selected for this session.'

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** A fake Chrome on disk: two profiles paired, one with the extension but never paired, one without it. */
function fakeChrome(on: On, { homeSet = true, touched = { disk: false } } = {}) {
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

  on('clock.now', () => ({ value: 1_700_000_000_000 }))
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

test('the connected-browser list gets Chrome names, and a browser from another machine is hidden', async ($, on) => {
  fakeChrome(on)
  // The engine hands an MCP result over as its content blocks.
  on('tool.call', () => ({ result: [{ type: 'text', text: LIST_TEXT }, { type: 'text', text: LIST_NOTE }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const text = textOf(ran.result)
  expect(text).toContain(`"deviceId":"${HOME}","name":"Home"`)
  expect(text).toContain('"profile":"Lee <lee@example.com>, Chrome / Default"')
  expect(text).not.toContain(`"deviceId":"${OTHER}"`)
  expect(text).toContain(`Hidden by chrome-profile-names, not paired in any Chrome profile on this machine: Browser 2 (${OTHER}).`)
  expect((ran.result as unknown[])[1]).toEqual({ type: 'text', text: LIST_NOTE })
})

test('with hideRemote off, the other machine stays listed', { options: { hideRemote: false } }, async ($, on) => {
  fakeChrome(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: LIST_TEXT }, { type: 'text', text: LIST_NOTE }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const text = textOf(ran.result)
  expect(text).toContain(`"deviceId":"${HOME}","name":"Home"`)
  expect(text).toContain(`"deviceId":"${OTHER}","name":"Browser 2"`)
  expect(text).not.toContain('Hidden by')
})

test('the relay prose after the list gets the Chrome name and says "selected"', async ($, on) => {
  fakeChrome(on)
  const inUse = `[{"deviceId":"${WORK}","name":"Browser 1","inUse":true},{"deviceId":"${HOME}","name":"Browser 2"}]`
  const prose = `2 browsers are connected; "Browser 1" (deviceId ${WORK}) is the one in use for this session. No question is needed.`
  on('tool.call', () => ({ result: [{ type: 'text', text: inUse }, { type: 'text', text: prose }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const blocks = ran.result as { text: string }[]
  expect(blocks[1]?.text).toBe(`2 browsers are connected; "Work" (deviceId ${WORK}) is the one selected for this session. No question is needed.`)
  expect(blocks[0]?.text).toContain(`"name":"Work","inUse":true`)
})

test('the selected browser is marked in the dialog, and "in use" becomes "selected"', async ($, on) => {
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

test('choosing a browser answers with its Chrome name and marks it selected afterwards', async ($, on) => {
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

test('a list in one block with the note after it keeps the note and fixes its count', async ($, on) => {
  fakeChrome(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: `${LIST_TEXT}${LIST_NOTE}` }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  const text = textOf(ran.result)
  expect(text).toContain(']1 browsers are connected and none is selected for this session.')
  expect(text).toContain('Hidden by chrome-profile-names')
})

test('when no listed browser is local, nothing is hidden', async ($, on) => {
  fakeChrome(on)
  const onlyRemote = `[{"deviceId":"${OTHER}","name":"Browser 1","osPlatform":"macOS","isLocal":true}]`
  on('tool.call', () => ({ result: [{ type: 'text', text: onlyRemote }] }))

  const ran = await $.tool.call({ tool: LIST_TOOL })
  expect(textOf(ran.result)).toBe(onlyRemote)
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

test('the browser-choice dialog is relabeled', async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{
      question: 'Which browser?',
      header: 'Browser',
      multiSelect: false,
      options: [
        { label: `Browser 1 (${WORK})`, description: 'macOS, local' },
        { label: `Browser 2 (${OTHER})`, description: 'macOS, local' },
        { label: 'Open a confirmation screen in every connected Chrome extension and let me select the right one there.', description: '' },
      ],
    }],
  })
  const questions = ran.result as { options: { label: string; description: string }[] }[]
  const options = questions[0]?.options ?? []
  expect(options.map(o => o.label)).toEqual([
    `Work (${WORK})`,
    'Open a confirmation screen in every connected Chrome extension and let me select the right one there.',
  ])
  expect(options[0]?.description).toBe('macOS, local (Acme <lee@acme.example>, Chrome / Profile 1)')
})

test('the dialog keeps a remote browser when hideRemote is off', { options: { hideRemote: false } }, async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  const ran = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${HOME})`, description: '' },
      { label: `Browser 2 (${OTHER})`, description: '' },
    ] }],
  })
  const questions = ran.result as { options: { label: string }[] }[]
  expect(questions[0]?.options.map(o => o.label)).toEqual([`Home (${HOME})`, `Browser 2 (${OTHER})`])
})

test('the dialog never drops below two options or to no local browser', async ($, on) => {
  fakeChrome(on)
  on('tool.call', (_, e) => ({ result: e.tool === 'AskUserQuestion' ? e.questions : null }))

  // Two browsers, no confirmation option: dropping the remote one would leave one option.
  const two = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${HOME})`, description: '' },
      { label: `Browser 2 (${OTHER})`, description: '' },
    ] }],
  })
  expect((two.result as { options: { label: string }[] }[])[0]?.options.length).toBe(2)

  // Only remote browsers: nothing to prefer, nothing dropped.
  const none = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which browser?', header: 'Browser', multiSelect: false, options: [
      { label: `Browser 1 (${OTHER})`, description: '' },
      { label: 'Open a confirmation screen in every connected Chrome extension and let me select the right one there.', description: '' },
    ] }],
  })
  expect((none.result as { options: { label: string }[] }[])[0]?.options.length).toBe(2)
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
  expect(textOf(ran.result)).toContain('"name":"Browser 1"')
})
