import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { BuildRun } from '../types'
import {
  delta,
  detectBuild,
  duration,
  failedTestOf,
  formatCommand,
  formatLog,
  joinPath,
  logChunks,
  parseOutput,
  platformsOf,
  progressText,
  remaining,
  segments,
  upgrade,
  words,
  workdirOf,
} from '../hooks/lib'

const NOW = Date.parse('2026-10-06T10:00:00Z')

const XCODE_FAILED = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme Orbit test
/Users/dev/Orbit/Orbit/LoginView.swift:42:17: error: cannot find 'session' in scope
/Users/dev/Orbit/Orbit/LoginView.swift:42:17: error: cannot find 'session' in scope
/Users/dev/Orbit/Orbit/MapView.swift:10:5: warning: variable 'zoom' was never used
/Users/dev/Orbit/OrbitTests/TripTests.swift:88: error: -[OrbitTests.TripTests testDuration] : XCTAssertEqual failed: ("3") is not equal to ("4")
Test Case '-[OrbitTests.TripTests testDuration]' failed (0.012 seconds).
Executed 12 tests, with 1 failure (0 unexpected) in 0.420 (0.433) seconds
** TEST FAILED **
`

// xcodebuild as it prints with nothing in between: each step's commands under it, an error once per
// architecture with its code, the tools' own logging.
const XCODE_RAW = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme Orbit build

2026-10-06 12:19:51.322 xcodebuild[91243:17663762] [MT] IDERunDestination: Supported platforms for the buildables in the current scheme is empty.
ComputeTargetDependencyGraph
note: Building targets in dependency order
note: Target dependency graph (2 targets)
    Target 'Orbit' in project 'Orbit' (no dependencies)

SwiftCompile normal arm64 Compiling\\ Trip.swift /Users/dev/Orbit/Orbit/Trip.swift (in target 'Orbit' from project 'Orbit')
    cd /Users/dev/Orbit
    builtin-swiftTaskExecution -- /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c -primary-file /Users/dev/Orbit/Orbit/Trip.swift

SwiftCompile normal arm64 Compiling\\ Map.swift /Users/dev/Orbit/Orbit/Map.swift (in target 'Orbit' from project 'Orbit')
    cd /Users/dev/Orbit

SwiftCompile normal x86_64 Compiling\\ Trip.swift /Users/dev/Orbit/Orbit/Trip.swift (in target 'Orbit' from project 'Orbit')
    cd /Users/dev/Orbit

/Users/dev/Orbit/Orbit/Login.swift:2:29: error: cannot find 'session' in scope
1 | struct Login {
2 |     var user: String { session.user }
  |                        \`- error: cannot find 'session' in scope
3 | }

/Users/dev/Orbit/Orbit/Login.swift:2:29: error: cannot find 'session' in scope
1 | struct Login {
2 |     var user: String { session.user }
  |                        \`- error: cannot find 'session' in scope
3 | }
Failed frontend command:
/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c -primary-file /Users/dev/Orbit/Orbit/Login.swift

ExtractAppIntentsMetadata (in target 'Orbit' from project 'Orbit')
    cd /Users/dev/Orbit

Ld /Users/dev/Orbit/build/Orbit.app/Orbit normal (in target 'Orbit' from project 'Orbit')
    cd /Users/dev/Orbit

** BUILD FAILED **


The following build commands failed:
	SwiftCompile normal arm64 Compiling\\ Login.swift /Users/dev/Orbit/Orbit/Login.swift (in target 'Orbit' from project 'Orbit')
	SwiftCompile normal x86_64 /Users/dev/Orbit/Orbit/Login.swift (in target 'Orbit' from project 'Orbit')
	Building project Orbit with scheme Orbit
(3 failures)
`

// A test run: XCTest, then Swift Testing with the SF Symbols Xcode prints for its marks.
const XCODE_TESTS = `Test Suite 'All tests' started at 2026-10-06 12:21:07.037.
Test Suite 'OrbitTests.xctest' started at 2026-10-06 12:21:07.038.
Test Suite 'TripTests' started at 2026-10-06 12:21:07.038.
Test Case '-[OrbitTests.TripTests testDuration]' started.
/Users/dev/Orbit/OrbitTests/TripTests.swift:10: error: -[OrbitTests.TripTests testDuration] : XCTAssertEqual failed: ("10") is not equal to ("11")
Test Case '-[OrbitTests.TripTests testDuration]' failed (0.432 seconds).
Test Case '-[OrbitTests.TripTests testPoints]' started.
Test Case '-[OrbitTests.TripTests testPoints]' passed (0.000 seconds).
Test Suite 'TripTests' failed at 2026-10-06 12:21:07.472.
	 Executed 2 tests, with 1 failure (0 unexpected) in 0.433 (0.434) seconds
Test Suite 'All tests' failed at 2026-10-06 12:21:07.472.
	 Executed 2 tests, with 1 failure (0 unexpected) in 0.433 (0.434) seconds
\u{1007C8} Test run started.
\u{100135} Testing Library Version: 2084
\u{1007C8} Test "Best trip wins" started.
\u{10105B} Test "Best trip wins" passed after 0.001 seconds.
\u{100884} Test "Total adds up" recorded an issue at BoardTests.swift:11:5: Expectation failed: board.total == 60
\u{100135} board.total == 60 → false
\u{100884} Test "Total adds up" failed after 0.002 seconds with 1 issue.
\u{100884} Test run with 2 tests in 0 suites failed after 0.002 seconds with 1 issue.
Failing tests:
	TripTests.testDuration()
	total()
** TEST FAILED **
`

const GRADLE_SUCCEEDED = `> Task :app:compileDebugKotlin
> Task :app:assembleDebug

BUILD SUCCESSFUL in 41s
38 actionable tasks: 12 executed, 26 up-to-date
`

const GRADLE_FAILED = `> Task :app:compileDebugKotlin FAILED
e: file:///Users/dev/orbit/app/src/main/java/com/acme/orbit/MainActivity.kt:27:9 Unresolved reference: bindng
w: file:///Users/dev/orbit/app/src/main/java/com/acme/orbit/TripMap.kt:5:1 'MapView' is deprecated.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.

BUILD FAILED in 9s
`

const PANE = {
  plugin: 'build-monitor',
  component: 'Pane',
  requestId: 'build-monitor',
  props: {
    title: 'Build',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Bash = {
  stdout: string
  isError: boolean
  interrupted: boolean
  background: boolean
  persisted: string | null
}

type Fake = {
  clock: MockClock
  paths: string[]
  runs: string[][]
  bash: Bash
  gate: Promise<void> | undefined
  commands: string[]
  opened: string[]
  toasts: string[]
  invalidations: number
  files: Record<string, string>
}

/** Stands in for the surface, the clock, the filesystem and the Bash tool beneath the mod. */
function fake(on: On, surfaces: ('terminal' | 'desktop')[] = ['desktop']): Fake {
  const state: Fake = {
    clock: mock.clock(on, { now: NOW }),
    paths: [],
    runs: [],
    bash: { stdout: '', isError: false, interrupted: false, background: false, persisted: null },
    gate: undefined,
    commands: [],
    opened: [],
    toasts: [],
    invalidations: 0,
    files: {},
  }
  on('ui.open', ($, e) => {
    state.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.invalidate', () => {
    state.invalidations += 1

    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: state.paths.includes(e.path) }))
  on('process.run', ($, e) => {
    state.runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', ($, e) => {
    const text = state.files[e.path]

    return text === undefined ? { deny: `no such file: ${e.path}` } : { value: text }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    state.commands.push(e.command)
    if (state.gate !== undefined) await state.gate
    const { bash } = state
    const result = {
      stdout: bash.stdout,
      stderr: '',
      interrupted: bash.interrupted,
      ...(bash.persisted === null ? {} : { persistedOutputPath: bash.persisted }),
      ...(bash.background ? { backgroundTaskId: 'bg1' } : {}),
    }

    return bash.isError ? { result, text: bash.stdout, isError: true as const } : { result, text: bash.stdout }
  })

  return state
}

/** Every text the pane draws, a line each: what a person reads. */
async function heroAlt(ui: { findAll: (query: { type: 'Text' }) => Promise<Array<{ text: string }>> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
}

/** Runs `command` through the Bash tool as Claude would. */
function bash($: Engine, command: string, extra: { run_in_background?: boolean } = {}) {
  return $.tool.call({ tool: 'Bash', command, ...extra })
}

/** Holds the next Bash call open until the returned function is called. */
function hold(state: Fake): () => void {
  let release = () => {}
  state.gate = new Promise<void>(resolve => {
    release = resolve
  })

  return () => {
    state.gate = undefined
    release()
  }
}

describe('pane', () => {
  test('an xcodebuild opens the pane as it starts, then shows how it ended', async ($, on) => {
    const state = fake(on)
    const release = hold(state)
    const call = bash($, "set -o pipefail && xcodebuild -scheme Orbit -destination 'platform=iOS Simulator,name=iPhone 16' test | xcpretty")
    await state.clock.settle()
    expect(state.opened).toEqual(['build-monitor'])

    await state.clock.advance(65_000)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      if (surface === 'desktop') {
        // The ring timer: the time so far; with no earlier run, an arc that turns.
        const timer = await ui.find({ type: 'Svg' })
        expect(timer?.props).toMatchObject({ alt: 'Building Orbit · test: 1:05', isInteractive: true })
        expect(String(timer?.props.source)).toContain('iPhone 16')
        expect(String(timer?.props.source)).toContain('No earlier run to time it against')
      } else {
        expect(await ui.find({ type: 'Text', text: 'Orbit · test' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'iPhone 16' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Building…' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '· 1m 05s' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeDefined()
      }
      await ui.unmount()
    }

    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    release()
    await call
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // The failed assertion is the test's failure, not a second error.
    expect(await heroAlt(ui)).toContain(
      [
        'Orbit · test failed in 1m 05s',
        'iOS · iPhone 16 · 12:00',
        '1 of 12 tests failed · 1 error',
        'Failed tests',
        '✗ TripTests.testDuration',
        'new',
        'TripTests.swift:88',
        'XCTAssertEqual failed: ("3") is not equal to ("4")',
        'Errors',
        'LoginView.swift:42',
        "cannot find 'session' in scope",
      ].join('\n'),
    )
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: 'Orbit · test failed in 1m 05s' })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: '1 of 12 tests failed · 1 error' })).toBeDefined()
    await terminal.unmount()
    expect(state.toasts).toEqual(['iOS build failed in 1m 05s · 1 error · 1 of 12 tests failed · 1 warning'])
  })

  test('a Gradle build that succeeds, with its task and flags', async ($, on) => {
    const state = fake(on)
    state.bash.stdout = GRADLE_SUCCEEDED
    await bash($, 'cd android && ./gradlew :app:assembleDebug --stacktrace')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Android · Gradle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ':app:assembleDebug' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '--stacktrace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Succeeded' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect(state.toasts).toEqual(['Android build succeeded in 0s'])
  })

  test('other commands pass through and open nothing', async ($, on) => {
    const state = fake(on)
    for (const command of ['git status', 'xcodebuild -list', './gradlew tasks', 'echo xcodebuild build', 'xcodebuild -version']) {
      await bash($, command)
    }
    expect(state.commands).toHaveLength(5)
    expect(state.opened).toEqual([])
    expect(state.toasts).toEqual([])
  })

  test('a build sent to the background is marked so, with no toast', async ($, on) => {
    const state = fake(on)
    state.bash.background = true
    await bash($, './gradlew assembleRelease', { run_in_background: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Running in the background' })).toBeDefined()
    expect(state.toasts).toEqual([])
  })

  test('a long output is read from the file Claude Code kept', async ($, on) => {
    const state = fake(on)
    state.files['/tmp/out-1.txt'] = GRADLE_FAILED
    state.bash = { ...state.bash, stdout: 'Output too large. Full output saved to /tmp/out-1.txt', isError: true, persisted: '/tmp/out-1.txt' }
    await bash($, './gradlew assembleDebug')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'MainActivity.kt' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Unresolved reference: bindng' })).toBeDefined()
    expect(state.toasts).toEqual(['Android build failed in 0s · 1 error · 1 warning'])
  })

  test('earlier builds are listed under the latest, and Clear removes them', async ($, on) => {
    const state = fake(on)
    state.bash.stdout = GRADLE_SUCCEEDED
    await bash($, './gradlew assembleDebug')
    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    await bash($, 'xcodebuild -scheme Orbit build')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Earlier' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'assembleDebug' })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: 'Earlier' })).toBeUndefined()
    expect(await heroAlt(ui)).toMatch(/^Orbit · build failed in/m)
  })

  test('under a failed build: its failed tests and errors, then links to its warnings, log and command', async ($, on) => {
    const state = fake(on)
    state.bash = { ...state.bash, stdout: `\u001b[1mCompiling\u001b[0m\r\n${XCODE_FAILED}`, isError: true }
    const line = "cd ios && cat > Notes.swift <<'EOF'\nlet a = 1\nEOF\nxcodebuild -scheme Orbit build | xcpretty"
    await bash($, line)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const links = async () => (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('tab:')).map(one => one.text)
    expect(await links()).toEqual(['1 warning', 'Log', 'Command'])
    expect(await ui.find({ type: 'Text', text: 'MapView.swift:10' })).toBeUndefined()

    await ui.press({ key: 'tab:warnings' })
    expect(await links()).toEqual(['Hide 1 warning', 'Log', 'Command'])
    expect(await ui.find({ type: 'Text', text: 'MapView.swift:10' })).toBeDefined()

    await ui.press({ key: 'tab:command' })
    expect((await ui.findAll({ type: 'Code' })).map(code => code.text)).toEqual([
      "cd ios && cat > Notes.swift <<'EOF'\nlet a = 1\nEOF\nxcodebuild -scheme Orbit build |\nxcpretty",
    ])
    expect(await ui.find({ type: 'Text', text: 'MapView.swift:10' })).toBeUndefined()

    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ type: 'Text', text: 'testDuration (0.01s)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '12 tests, 1 failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Test failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Compiling' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text' })).some(text => text.text.includes('\u001b') || text.text.includes('Command line invocation'))).toBe(false)
    expect(await ui.find({ key: 'full-log' })).toBeUndefined()

    // An open link closes when pressed again.
    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ type: 'Text', text: 'Test failed' })).toBeUndefined()
    expect(await links()).toEqual(['1 warning', 'Log', 'Command'])
  })

  test('an error shows the code it points at; the log opens the whole output Claude Code kept', async ($, on) => {
    const state = fake(on)
    state.files['/tmp/out-2.txt'] = XCODE_RAW
    state.bash = { ...state.bash, stdout: 'Output too large.', isError: true, persisted: '/tmp/out-2.txt' }
    await bash($, 'xcodebuild -scheme Orbit build')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.findAll({ type: 'Code' })).map(code => code.text)).toEqual([
      "1 | struct Login {\n2 |     var user: String { session.user }\n  |                        `- error: cannot find 'session' in scope\n3 | }",
    ])
    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ type: 'Text', text: 'Compiling Trip.swift, Map.swift' })).toBeDefined()
    await ui.press({ key: 'full-log' })
    expect(state.runs).toEqual([['open', '-t', '/tmp/out-2.txt']])
  })

  test('Ask Claude to fix hands Claude the build, its errors and tests; Re-run and Copy', async ($, on) => {
    const state = fake(on)
    const submitted: string[] = []
    let finish = () => {}
    const turn = new Promise<void>(resolve => {
      finish = resolve
    })
    on('prompt.submit', async ($, e) => {
      submitted.push(e.text)
      if (submitted.length === 1) await turn

      return { text: e.text }
    })
    const copied: string[] = []
    on('ui.copy', ($, e) => {
      copied.push(e.text)

      return { value: { isCopied: true as const } }
    })
    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    await bash($, 'cd ios && xcodebuild -scheme Orbit test')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'fix' }))?.props).toMatchObject({ variant: 'secondary' })
    const pressed = ui.press({ key: 'fix' })
    await state.clock.settle()
    await state.clock.advance(600)
    expect((await ui.find({ key: 'fix' }))?.text).toBe('Queued for Claude…')
    expect(state.toasts.at(-1)).toMatch(/^Queued: Claude starts on the fix/)
    finish()
    await pressed
    expect((await ui.find({ key: 'fix' }))?.text).toBe('Claude is on it')
    expect(submitted[0]).toContain('The iOS build "Orbit · test" just failed.')
    expect(submitted[0]).toContain('cd ios && xcodebuild -scheme Orbit test')
    expect(submitted[0]).toContain("/Users/dev/Orbit/Orbit/LoginView.swift:42: error: cannot find 'session' in scope")
    expect(submitted[0]).toContain('- TripTests.testDuration')

    await ui.press({ key: 'fix' })
    expect(submitted).toHaveLength(1)

    await ui.press({ key: 'rerun' })
    expect(submitted[1]).toBe('Run this build again, exactly as before:\n```\ncd ios && xcodebuild -scheme Orbit test\n```')
    await ui.press({ key: 'copy' })
    expect(copied[0]).toContain("LoginView.swift:42: error: cannot find 'session' in scope")
    expect(state.toasts.at(-1)).toBe('Errors copied.')
  })

  test('a failed test says whether it is new or how often it failed', async ($, on) => {
    const state = fake(on)
    state.bash = { ...state.bash, stdout: "Test Case '-[M.T testA]' failed (0.1 seconds).\nExecuted 2 tests, with 1 failure (0 unexpected) in 1 (1) seconds\n** TEST FAILED **", isError: true }
    await bash($, 'xcodebuild -scheme Orbit test')
    await state.clock.advance(60_000)
    state.bash.stdout = "Test Case '-[M.T testA]' failed (0.1 seconds).\nTest Case '-[M.T testB]' failed (0.1 seconds).\nExecuted 2 tests, with 2 failures (0 unexpected) in 1 (1) seconds\n** TEST FAILED **"
    await bash($, 'xcodebuild -scheme Orbit test')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await heroAlt(ui)).toContain('✗ T.testA\nfailed 2 of last 2\n✗ T.testB\nnew')
  })

  test('Details at its largest stays inside what the engine draws', async ($, on) => {
    const state = fake(on)
    const long = (n: number, at: number) => `${'m'.repeat(n - 6)}${String(at).padStart(6, '0')}`
    const output = [
      ...Array.from({ length: 30 }, (_, index) => [
        `/Users/dev/Orbit/Orbit/Feature${index}/View${index}.swift:${index + 1}:3: error: ${long(900, index)}`,
        ...Array.from({ length: 10 }, (_, row) => `${row + 1} | ${'c'.repeat(300)}`),
      ]),
      ...Array.from({ length: 30 }, (_, index) => `/Users/dev/Orbit/Orbit/Model${index}.swift:${index + 1}:3: warning: ${long(900, index)}`),
      ...Array.from({ length: 30 }, (_, index) => `Test Case '-[OrbitTests.Suite${index} test${'Long'.repeat(20)}${index}]' failed (0.100 seconds).`),
      '** TEST FAILED **',
    ].flat().join('\n')
    state.bash = { ...state.bash, stdout: output, isError: true }
    const command = `xcodebuild -scheme Orbit ${Array.from({ length: 200 }, (_, index) => `-flag${index} value${index}`).join(' ')} test`
    for (let index = 0; index < 10; index += 1) await bash($, command)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (const tab of ['none', 'warnings', 'log', 'command']) {
      if (tab !== 'none') await ui.press({ key: `tab:${tab}` })
      const tree = await ui.drawn()
      let nodes = 0
      let depth = 0
      const walk = (node: unknown, level: number) => {
        if (typeof node !== 'object' || node === null) return
        nodes += 1
        depth = Math.max(depth, level)
        for (const child of (node as { children?: unknown[] }).children ?? []) walk(child, level + 1)
      }
      walk(tree, 1)
      expect(JSON.stringify(tree).length).toBeLessThan(90_000)
      expect(nodes).toBeLessThan(20_000)
      expect(depth).toBeLessThan(32)
    }
  })

  test('an earlier build opens in the card when tapped, and Latest goes back', async ($, on) => {
    const state = fake(on)
    state.bash.stdout = GRADLE_SUCCEEDED
    await bash($, './gradlew assembleDebug')
    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    await bash($, "xcodebuild -scheme Orbit -destination 'platform=macOS' build")

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await heroAlt(ui)).toMatch(/^Orbit · build failed in/m)
    const [earlier] = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('show:'))
    expect(earlier?.text).toBe('assembleDebug')
    await ui.press({ key: earlier?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: 'Android · Gradle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Earlier build · / })).toBeDefined()

    await ui.press({ key: 'latest' })
    expect(await heroAlt(ui)).toMatch(/^Orbit · build failed in/m)
    expect(await ui.find({ key: 'latest' })).toBeUndefined()
    expect(state.toasts.at(-1)).toMatch(/^macOS build failed/)
  })

  test('with iOS and Android builds a segmented control filters them; a new build clears the filter', async ($, on) => {
    const state = fake(on)
    state.bash.stdout = GRADLE_SUCCEEDED
    await bash($, './gradlew assembleDebug')
    let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'filter:all' })).toBeUndefined()
    await ui.unmount()

    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    await bash($, 'xcodebuild -scheme Orbit test')
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const filters = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('filter:'))
    expect(filters.map(one => one.text)).toEqual(['All', 'iOS', 'Android'])
    expect((await ui.find({ key: 'filter:all' }))?.props).toMatchObject({ variant: 'primary' })

    await ui.press({ key: 'filter:android' })
    expect((await ui.find({ key: 'filter:android' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ type: 'Text', text: 'Android · Gradle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Earlier' })).toBeUndefined()

    state.bash = { ...state.bash, stdout: '** BUILD SUCCEEDED **', isError: false }
    await bash($, 'xcodebuild -scheme Orbit build')
    expect((await ui.find({ key: 'filter:all' }))?.props).toMatchObject({ variant: 'primary' })
    expect(await ui.find({ type: 'Text', text: 'Orbit · build' })).toBeDefined()
  })

  test('a build seen before shows a progress bar and time left, then how it compares', async ($, on) => {
    const state = fake(on)
    state.bash.stdout = GRADLE_SUCCEEDED
    let release = hold(state)
    let call = bash($, './gradlew assembleDebug')
    await state.clock.settle()
    await state.clock.advance(60_000)
    release()
    await call

    release = hold(state)
    call = bash($, './gradlew assembleDebug')
    await state.clock.settle()
    await state.clock.advance(20_000)
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const timer = await desktop.find({ type: 'Svg' })
    expect(timer?.props.alt).toBe('Building assembleDebug: 0:20 of about 1:00')
    expect(String(timer?.props.source)).toContain('About 40s left')
    expect(String(timer?.props.source)).toContain('of ~1:00')
    await desktop.unmount()
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: /^█+░+$/ })).toBeDefined()
    await terminal.unmount()

    await state.clock.advance(30_000)
    release()
    await call
    const done = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await done.find({ type: 'Text', text: '· 10s faster than last' })).toBeDefined()
    expect(await done.find({ type: 'Text', text: /left$/ })).toBeUndefined()
  })

  test('Xcode opens an error, or a failed test\'s assertion, at its line', async ($, on) => {
    const state = fake(on)
    state.paths.push('/Users/dev/Orbit/Orbit/LoginView.swift')
    state.bash = { ...state.bash, stdout: XCODE_FAILED, isError: true }
    await bash($, 'xcodebuild -scheme Orbit test')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'open:error:0' }))?.text).toBe('Xcode')

    await ui.press({ key: 'open:error:0' })
    expect(state.runs).toEqual([['xed', '--line', '42', '/Users/dev/Orbit/Orbit/LoginView.swift']])

    expect(await ui.find({ key: 'open:error:1' })).toBeUndefined()

    // A failed test's assertion opens the same way.
    expect(await ui.find({ type: 'Text', text: 'TripTests.swift:88' })).toBeDefined()
    await ui.press({ key: 'open:test:0' })
    expect(state.toasts.at(-1)).toBe("Couldn't find /Users/dev/Orbit/OrbitTests/TripTests.swift on this machine.")
  })

  test('a relative path is found under the cd the build ran after; Android opens in Android Studio', async ($, on) => {
    const state = fake(on)
    state.paths.push('/work/ios/Orbit/LoginView.swift', '/work/android/app/src/main/java/A.kt')
    state.bash = { ...state.bash, stdout: "Orbit/LoginView.swift:42:17: error: cannot find 'session' in scope\n** BUILD FAILED **", isError: true }
    await bash($, 'cd ios && xcodebuild -scheme Orbit build | xcpretty')
    let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open:error:0' })
    expect(state.runs.at(-1)).toEqual(['xed', '--line', '42', '/work/ios/Orbit/LoginView.swift'])
    await ui.unmount()

    state.bash = { ...state.bash, stdout: 'e: app/src/main/java/A.kt:3:1 Unresolved reference: x\nBUILD FAILED in 1s', isError: true }
    await bash($, 'cd android && ./gradlew assembleDebug')
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'open:error:0' }))?.text).toBe('Android Studio')
    await ui.press({ key: 'open:error:0' })
    expect(state.runs.at(-1)).toEqual(['open', '-a', 'Android Studio', '/work/android/app/src/main/java/A.kt'])
  })

  test('the pane redraws each second only while a build runs', async ($, on) => {
    const state = fake(on)
    const release = hold(state)
    state.bash.stdout = GRADLE_SUCCEEDED
    const call = bash($, './gradlew assembleDebug')
    await state.clock.settle()
    await state.clock.advance(3_000)
    expect(state.invalidations).toBeGreaterThanOrEqual(3)

    release()
    await call
    const after = state.invalidations
    await state.clock.advance(5_000)
    expect(state.invalidations).toBe(after)
  })

  test('with nothing built yet the pane says what opens it', async ($, on) => {
    fake(on)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(await ui.find({ type: 'Text', text: 'No builds yet' })).toBeDefined()
  })
})

describe('lib', () => {
  test('detectBuild reads Xcode builds through pipes, cd and environment', () => {
    expect(detectBuild('xcodebuild -workspace Orbit.xcworkspace -scheme Orbit -configuration Release archive')).toEqual({
      platform: 'ios',
      tool: 'xcodebuild',
      title: 'Orbit · archive',
      detail: 'Release',
      command: 'xcodebuild -workspace Orbit.xcworkspace -scheme Orbit -configuration Release archive',
    })
    expect(detectBuild("cd app && xcodebuild -scheme Demo -destination 'platform=macOS' build 2>&1 | tail -3")).toMatchObject({
      platform: 'macos',
      detail: 'macOS',
      command: "xcodebuild -scheme Demo -destination 'platform=macOS' build 2>&1",
    })
    expect(detectBuild('cd ios && NSUnbufferedIO=YES xcrun xcodebuild -project Orbit.xcodeproj build')?.title).toBe('Orbit · build')
    expect(detectBuild('xcodebuild -scheme "My App" -sdk iphonesimulator clean build')).toMatchObject({
      title: 'My App · clean + build',
      detail: 'iphonesimulator',
    })
    expect(detectBuild('xcodebuild -showBuildSettings -scheme Orbit')).toBeNull()
    expect(detectBuild('grep xcodebuild notes.txt')).toBeNull()
  })

  test('detectBuild reads Gradle tasks, skipping flag values and info tasks', () => {
    expect(detectBuild('./gradlew -p android :app:testDebugUnitTest --info')).toEqual({
      platform: 'android',
      tool: 'gradle',
      title: ':app:testDebugUnitTest',
      detail: '--info',
      command: './gradlew -p android :app:testDebugUnitTest --info',
    })
    expect(detectBuild('android/gradlew clean assembleDebug bundleRelease lint')?.title).toBe('clean assembleDebug bundleRelease +1')
    expect(detectBuild('gradle --version')).toBeNull()
    expect(detectBuild('./gradlew :app:dependencies')).toBeNull()
  })

  test('parseOutput: Xcode diagnostics, test counts and the final marker', () => {
    const failed = parseOutput('xcodebuild', XCODE_FAILED, true)
    expect(failed).toMatchObject({ status: 'failed', errorCount: 1, warningCount: 1, tests: { total: 12, failed: 1 } })
    expect(failed.testIssues).toEqual([
      { test: 'TripTests.testDuration', severity: 'error', file: '/Users/dev/Orbit/OrbitTests/TripTests.swift', line: 88, message: 'XCTAssertEqual failed: ("3") is not equal to ("4")' },
    ])
    expect(failed.errors[0]).toEqual({
      severity: 'error',
      file: '/Users/dev/Orbit/Orbit/LoginView.swift',
      line: 42,
      message: "cannot find 'session' in scope",
    })
    expect(parseOutput('xcodebuild', '** BUILD SUCCEEDED **', true).status).toBe('succeeded')
    expect(parseOutput('xcodebuild', 'no marker at all', true).status).toBe('failed')
    const setup = parseOutput(
      'xcodebuild',
      'xcodebuild: error: The workspace named "Demo" does not contain a scheme named "Demo".',
      false,
    )
    expect(setup).toMatchObject({ status: 'failed', errorCount: 1 })
    expect(setup.errors[0]?.message).toBe('The workspace named "Demo" does not contain a scheme named "Demo".')
    const relative = parseOutput(
      'xcodebuild',
      "Sources/Demo/Leaderboard.swift:5:19: error: value of type 'Trip' has no member 'pointz'\n** BUILD FAILED **",
      false,
    )
    expect(relative.errors[0]).toEqual({
      severity: 'error',
      file: 'Sources/Demo/Leaderboard.swift',
      line: 5,
      message: "value of type 'Trip' has no member 'pointz'",
    })
  })

  test('parseOutput: Kotlin and Java diagnostics, and Gradle\'s own reason when there are none', () => {
    const kotlin = parseOutput('gradle', GRADLE_FAILED, true)
    expect(kotlin).toMatchObject({ status: 'failed', errorCount: 1, warningCount: 1 })
    expect(kotlin.errors[0]).toMatchObject({ line: 27, message: 'Unresolved reference: bindng' })
    const java = parseOutput('gradle', '/w/app/src/Main.java:12: error: cannot find symbol\nBUILD FAILED in 2s', true)
    expect(parseOutput('gradle', 'e: app/src/main/java/A.kt:3:1 Unresolved reference: x\nBUILD FAILED in 1s', true).errors[0]).toMatchObject({
      file: 'app/src/main/java/A.kt',
      line: 3,
    })
    expect(java.errors[0]).toMatchObject({ file: '/w/app/src/Main.java', line: 12, message: 'cannot find symbol' })
    const reason = parseOutput('gradle', "* What went wrong:\nCould not resolve all files for configuration ':app:debugRuntimeClasspath'.\nBUILD FAILED in 3s", true)
    expect(reason.errors).toEqual([
      { severity: 'error', file: null, line: null, message: "Could not resolve all files for configuration ':app:debugRuntimeClasspath'." },
    ])
    expect(parseOutput('gradle', '42 tests completed, 3 failed\nBUILD FAILED in 1m', true).tests).toEqual({ total: 42, failed: 3 })
  })

  test('failedTestOf reads XCTest, Swift Testing and Gradle', () => {
    expect(failedTestOf("Test Case '-[OrbitTests.TripTests testDuration]' failed (0.012 seconds).")).toBe('TripTests.testDuration')
    expect(failedTestOf("Test case 'TripTests.testDuration()' failed on 'My Mac - Orbit (123)' (0.003 seconds)")).toBe(
      'TripTests.testDuration()',
    )
    expect(failedTestOf('✘ Test "Rounds distance up" failed after 0.002 seconds with 1 issue.')).toBe('Rounds distance up')
    expect(failedTestOf('com.acme.orbit.TripTest > durationIsRounded() FAILED')).toBe('TripTest.durationIsRounded()')
    expect(failedTestOf('> Task :app:testDebugUnitTest FAILED')).toBeNull()
    expect(parseOutput('gradle', 'com.acme.A > b() FAILED\ncom.acme.A > b() FAILED\nBUILD FAILED in 1s', true).failedTests).toEqual(['A.b()'])
  })

  test('workdirOf and joinPath', () => {
    expect(workdirOf('cd ios && xcodebuild build | xcpretty', 'xcodebuild build')).toBe('ios')
    expect(workdirOf('xcodebuild build; cd elsewhere', 'xcodebuild build')).toBeNull()
    expect(joinPath('/work', 'ios', 'Orbit/A.swift')).toBe('/work/ios/Orbit/A.swift')
    expect(joinPath('/work', '../other', './B.kt')).toBe('/other/B.kt')
    expect(joinPath('/work', '/abs/dir', 'C.swift')).toBe('/abs/dir/C.swift')
  })

  test('remaining, delta and progressText', () => {
    expect(remaining(20_000, 60_000)).toEqual({ fraction: 1 / 3, text: 'about 40s left' })
    expect(remaining(70_000, 60_000)).toEqual({ fraction: 1, text: 'taking longer than last time (1m 00s)' })
    expect(delta(50_000, 60_000)).toBe('10s faster than last')
    expect(delta(75_000, 60_000)).toBe('15s slower than last')
    expect(delta(61_000, 60_000)).toBe('')
    expect(progressText(0.5, 10)).toBe('█████░░░░░')
    expect(platformsOf([{ platform: 'android' }, { platform: 'ios' }])).toEqual(['ios', 'android'])
  })

  test('upgrade fills in what older versions did not record', () => {
    const old = {
      id: 'toolu_old', platform: 'ios', tool: 'xcodebuild', title: 'Orbit · build', detail: '', command: 'xcodebuild build',
      startedAt: 0, endedAt: 1, status: 'failed', errors: [], errorCount: 0, warningCount: 0, tests: null,
    } as unknown as BuildRun
    expect(upgrade(old)).toMatchObject({ fullCommand: 'xcodebuild build', warnings: [], log: [], logFile: null })
    const current = upgrade(old)
    expect(upgrade(current)).toEqual(current)
    // The output an older version kept as it was is formatted on the way.
    const tail = { ...old, outputTail: 'note: Building targets in dependency order\n** BUILD FAILED **' } as unknown as BuildRun
    expect(upgrade(tail).log).toEqual([{ kind: 'failed', text: 'Build failed' }])
  })

  test('formatLog: xcodebuild as steps, each error once with its code, the noise left out', () => {
    expect(formatLog('xcodebuild', XCODE_RAW)).toEqual([
      { kind: 'step', text: 'Compiling Trip.swift, Map.swift' },
      { kind: 'error', at: 'Login.swift:2', text: "cannot find 'session' in scope" },
      { kind: 'code', text: '1 | struct Login {' },
      { kind: 'code', text: '2 |     var user: String { session.user }' },
      { kind: 'code', text: "  |                        `- error: cannot find 'session' in scope" },
      { kind: 'code', text: '3 | }' },
      { kind: 'step', text: 'Linking Orbit' },
      { kind: 'failed', text: 'Build failed' },
      { kind: 'heading', text: 'Failed build commands' },
      { kind: 'fail', text: 'Compiling Login.swift' },
      { kind: 'fail', text: 'Building project Orbit with scheme Orbit' },
    ])
  })

  test('formatLog: XCTest and Swift Testing results, and the lists a test run ends with', () => {
    expect(formatLog('xcodebuild', XCODE_TESTS)).toEqual([
      { kind: 'heading', text: 'TripTests' },
      { kind: 'error', at: 'TripTests.swift:10', text: 'XCTAssertEqual failed: ("10") is not equal to ("11")' },
      { kind: 'fail', text: 'testDuration (0.43s)' },
      { kind: 'pass', text: 'testPoints' },
      { kind: 'text', text: '2 tests, 1 failed' },
      { kind: 'heading', text: 'Swift Testing' },
      { kind: 'pass', text: 'Best trip wins' },
      { kind: 'error', at: 'BoardTests.swift:11', text: 'Expectation failed: board.total == 60' },
      { kind: 'code', text: 'board.total == 60 → false' },
      { kind: 'fail', text: 'Total adds up' },
      { kind: 'text', text: '2 tests, 1 failed' },
      { kind: 'heading', text: 'Failing tests' },
      { kind: 'fail', text: 'TripTests.testDuration()' },
      { kind: 'fail', text: 'total()' },
      { kind: 'failed', text: 'Test failed' },
    ])
    const outcome = parseOutput('xcodebuild', XCODE_TESTS, true)
    expect(outcome.tests).toEqual({ total: 4, failed: 2 })
    expect(outcome.failedTests).toEqual(['TripTests.testDuration', 'Total adds up'])
    expect(outcome.errors).toEqual([])
    expect(outcome.testIssues.map(issue => [issue.test, issue.line, issue.message])).toEqual([
      ['TripTests.testDuration', 10, 'XCTAssertEqual failed: ("10") is not equal to ("11")'],
      ['Total adds up', 11, 'Expectation failed: board.total == 60'],
    ])
  })

  test('formatLog: Gradle tasks that ran, its diagnostics, what went wrong and the result', () => {
    expect(formatLog('gradle', `> Task :app:preBuild UP-TO-DATE\n${GRADLE_FAILED}`)).toEqual([
      { kind: 'fail', text: ':app:compileDebugKotlin failed' },
      { kind: 'error', at: 'MainActivity.kt:27', text: 'Unresolved reference: bindng' },
      { kind: 'warning', at: 'TripMap.kt:5', text: "'MapView' is deprecated." },
      { kind: 'heading', text: 'What went wrong' },
      { kind: 'error', text: "Execution failed for task ':app:compileDebugKotlin'." },
      { kind: 'failed', text: 'Build failed in 9s' },
    ])
    expect(formatLog('gradle', GRADLE_SUCCEEDED).map(line => line.text)).toEqual([
      ':app:compileDebugKotlin',
      ':app:assembleDebug',
      'Build successful in 41s',
      '38 actionable tasks: 12 executed, 26 up-to-date',
    ])
    const many = Array.from({ length: 80 }, (_, index) => `> Task :lib${index}:compile`).join('\n')
    const kept = formatLog('gradle', many)
    expect(kept).toHaveLength(60)
    expect(kept[0]).toEqual({ kind: 'text', text: '… 21 earlier lines' })
    expect(kept.at(-1)?.text).toBe(':lib79:compile')
  })

  test('formatCommand lays a build out a flag to a line and leaves the rest as written', () => {
    const line = "cd ios && NSUnbufferedIO=YES xcodebuild -scheme Orbit -destination 'platform=iOS Simulator,name=iPhone 16' -quiet clean build CODE_SIGNING_ALLOWED=NO 2>&1 | xcpretty"
    const build = detectBuild(line)?.command ?? ''
    expect(formatCommand(line, build)).toBe(
      [
        'cd ios &&',
        'NSUnbufferedIO=YES xcodebuild \\',
        '  -scheme Orbit \\',
        "  -destination 'platform=iOS Simulator,name=iPhone 16' \\",
        '  -quiet \\',
        '  clean build CODE_SIGNING_ALLOWED=NO 2>&1 |',
        'xcpretty',
      ].join('\n'),
    )
    expect(formatCommand('./gradlew :app:assembleDebug', './gradlew :app:assembleDebug')).toBe('./gradlew :app:assembleDebug')
    expect(formatCommand('./gradlew -p android :app:assembleDebug :app:testDebugUnitTest --stacktrace', './gradlew -p android :app:assembleDebug :app:testDebugUnitTest --stacktrace')).toBe(
      ['./gradlew \\', '  -p android \\', '  :app:assembleDebug :app:testDebugUnitTest \\', '  --stacktrace'].join('\n'),
    )
    // A heredoc before the build stays exactly as written.
    const heredoc = "cat > A.swift <<'EOF'\n  // don't  touch\nEOF\nxcodebuild build"
    expect(formatCommand(heredoc, 'xcodebuild build')).toBe(heredoc)
    expect(logChunks([
      { kind: 'error', text: 'a' },
      { kind: 'code', text: '1' },
      { kind: 'code', text: '2' },
      { kind: 'pass', text: 'b' },
    ])).toEqual([{ line: { kind: 'error', text: 'a' } }, { code: '1\n2' }, { line: { kind: 'pass', text: 'b' } }])
  })

  test('words and segments respect quotes; duration reads naturally', () => {
    expect(words(`xcodebuild -scheme "My App" -destination 'name=iPhone 16'`)).toEqual([
      'xcodebuild', '-scheme', 'My App', '-destination', 'name=iPhone 16',
    ])
    expect(segments(`cd ios && xcodebuild build | tee "a|b.log"; echo done`)).toEqual([
      'cd ios', 'xcodebuild build', 'tee "a|b.log"', 'echo done',
    ])
    expect(segments('xcodebuild build 2>&1 | tail -5 &> out.log & wait')).toEqual([
      'xcodebuild build 2>&1', 'tail -5 &> out.log', 'wait',
    ])
    expect(duration(8_000)).toBe('8s')
    expect(duration(134_000)).toBe('2m 14s')
    expect(duration(3_780_000)).toBe('1h 3m')
  })
})
