import type { BuildIssue, BuildPlatform, BuildRun, BuildStatus, BuildTool, LogLine, TestIssue } from '../types'

/** How many builds the pane keeps, newest first. */
export const HISTORY = 10

/** How many diagnostics a build keeps to show. */
export const ISSUE_LIMIT = 20

/** A shell command as words, quotes removed. Good enough to read a build's arguments, not to run them. */
export function words(command: string): string[] {
  const out: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let hasWord = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < command.length) word += command[++index] ?? ''
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
    } else if (char === '\\' && index + 1 < command.length) {
      word += command[++index] ?? ''
      hasWord = true
    } else if (/\s/.test(char)) {
      if (hasWord) out.push(word)
      word = ''
      hasWord = false
    } else {
      word += char
      hasWord = true
    }
  }
  if (hasWord) out.push(word)

  return out
}

/**
 * The simple commands of a command line: split at `&&`, `||`, `;`, `|`, `&`
 * and newlines outside quotes; the `&` of a redirection (`2>&1`, `&>`) stays.
 */
export function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === '&' && (/[<>]/.test(command[index - 1] ?? '') || command[index + 1] === '>')) {
      current += char
    } else if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if (current.trim() !== '') out.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') out.push(current.trim())

  return out
}

const XCODE_INFO = new Set(['-version', '-list', '-showsdks', '-showBuildSettings', '-showdestinations', '-showTestPlans', '-help', '-usage', '-license', '-checkFirstLaunchStatus', '-runFirstLaunch'])
const XCODE_ACTIONS = new Set(['build', 'build-for-testing', 'analyze', 'archive', 'test', 'test-without-building', 'docbuild', 'installsrc', 'install', 'clean'])
const GRADLE_INFO = new Set(['help', 'tasks', 'properties', 'dependencies', 'projects', 'wrapper'])
const GRADLE_VALUED = new Set(['-p', '--project-dir', '-b', '--build-file', '-c', '--settings-file', '-g', '--gradle-user-home', '-x', '--exclude-task', '-I', '--init-script', '-D', '-P'])

export type BuildCommand = {
  platform: BuildPlatform
  tool: BuildTool
  title: string
  detail: string
  /** The simple command that builds, as written in the line. */
  command: string
}

const base = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

/** The argument after `flag`, if the command has one. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag)

  return at === -1 ? undefined : args[at + 1]
}

function describeXcode(args: readonly string[]): Omit<BuildCommand, 'command'> | null {
  if (args.some(arg => XCODE_INFO.has(arg))) return null
  const actions = args.filter(arg => XCODE_ACTIONS.has(arg))
  const scheme = valueOf(args, '-scheme')
  const container = valueOf(args, '-workspace') ?? valueOf(args, '-project')
  const target = valueOf(args, '-target')
  const name = scheme ?? target ?? (container === undefined ? undefined : base(container).replace(/\.(xcworkspace|xcodeproj)$/, ''))
  const destination = valueOf(args, '-destination')
  const device = destination?.match(/name=([^,]+)/)?.[1] ?? destination?.match(/platform=([^,]+)/)?.[1]
  const sdk = valueOf(args, '-sdk')

  const isMac = /macos|macosx|mac catalyst/i.test(`${destination ?? ''} ${sdk ?? ''}`)

  return {
    platform: isMac ? 'macos' : 'ios',
    tool: 'xcodebuild',
    title: [name ?? 'Xcode project', actions.length === 0 ? 'build' : actions.join(' + ')].join(' · '),
    detail: [valueOf(args, '-configuration'), device ?? sdk].filter(Boolean).join(' · '),
  }
}

function describeGradle(args: readonly string[]): Omit<BuildCommand, 'command'> | null {
  const tasks: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (GRADLE_VALUED.has(arg)) {
      index += 1
      continue
    }
    if (!arg.startsWith('-')) tasks.push(arg)
  }
  if (tasks.length === 0 || tasks.every(task => GRADLE_INFO.has(task.split(':').at(-1) ?? task))) return null
  const flags = args.filter(arg => arg.startsWith('--') && !GRADLE_VALUED.has(arg))

  return {
    platform: 'android',
    tool: 'gradle',
    title: tasks.slice(0, 3).join(' ') + (tasks.length > 3 ? ` +${tasks.length - 3}` : ''),
    detail: flags.slice(0, 3).join(' '),
  }
}

/** Commands that run the command after them: `time xcodebuild …`, `xcrun xcodebuild …`. */
const LEADING_COMMANDS = new Set(['time', 'xcrun', 'nice', 'env', 'command', 'exec'])

/**
 * Whether `command` runs an Xcode or Gradle build, and what it builds. A
 * command's first word decides, after `env`-style assignments, `time`,
 * `xcrun` and `nice`; `xcodebuild -list` and `gradle tasks` are not builds.
 */
export function detectBuild(command: string): BuildCommand | null {
  for (const part of segments(command)) {
    const args = words(part)
    while (args.length > 0) {
      const first = args[0] ?? ''
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || LEADING_COMMANDS.has(first)) {
        args.shift()
      } else {
        break
      }
    }
    const [program = '', ...rest] = args
    const name = base(program)
    if (name === 'xcodebuild') {
      const found = describeXcode(rest)
      if (found !== null) return { ...found, command: part }
    }
    if (name === 'gradlew' || name === 'gradle' || name === 'gradlew.bat') {
      const found = describeGradle(rest)
      if (found !== null) return { ...found, command: part }
    }
  }

  return null
}

export type BuildOutcome = {
  status: Extract<BuildStatus, 'succeeded' | 'failed'>
  errors: BuildIssue[]
  errorCount: number
  warnings: BuildIssue[]
  warningCount: number
  tests: { total: number; failed: number } | null
  failedTests: string[]
  testIssues: TestIssue[]
  log: LogLine[]
}

/**
 * The failed test a line names, in the four ways builds say it: XCTest's
 * `Test Case '-[Module.TripTests testDuration]' failed`, its newer
 * `Test case 'TripTests.testDuration()' failed on …`, Swift Testing's
 * `✘ Test "Rounds up" failed after …` (Xcode prints an SF Symbol for the
 * ✘), and Gradle's `com.acme.TripTest > durationIsRounded() FAILED`.
 */
export function failedTestOf(line: string): string | null {
  const legacy = line.match(/^Test Case '-\[(?:[\w]+\.)?(\w+) (\w+)\]' failed/)
  if (legacy) return `${legacy[1]}.${legacy[2]}`
  const modern = line.match(/^Test case '([^']+)' failed/)
  if (modern) return modern[1] ?? null
  const swiftTesting = line.match(/^(?:✘|\u{100884})\uFE0F? Test (?!run with )(.+?) failed after/u)
  if (swiftTesting) return (swiftTesting[1] ?? '').replace(/^"(.*)"$/, '$1')
  const junit = line.match(/^([\w.$]+) > (.+?) FAILED$/)
  if (junit) return `${(junit[1] ?? '').split('.').at(-1)}.${junit[2]}`

  return null
}

// A source path, absolute or relative (formatters such as xcpretty print relative ones): no
// spaces or colons, ending in a file extension.
const PATH = String.raw`([^\s:][^\s:]*\.[A-Za-z0-9]+)`
const XCODE_DIAGNOSTIC = new RegExp(String.raw`^${PATH}:(\d+)(?::\d+)?: (error|warning): (.+)$`)
const KOTLIN_DIAGNOSTIC = new RegExp(String.raw`^([ew]): (?:file:\/\/)?${PATH}:(\d+)(?::\d+)?:? (.+)$`)
const JAVA_DIAGNOSTIC = new RegExp(String.raw`^([^\s:][^\s:]*\.java):(\d+): (error|warning): (.+)$`)
// `error: …`, and a tool's own `xcodebuild: error: …` (a missing scheme, a bad destination).
const BARE_ERROR = /^(?:[\w.-]+: )?(?:error|ERROR): (.+)$/

/**
 * What a build's output says: whether it succeeded, its errors (the first
 * `ISSUE_LIMIT`, each once) and how many there were, its warnings, and its
 * tests when it ran some. The build tool's own last word decides
 * (`** BUILD SUCCEEDED **`, `BUILD FAILED in 3s`); without one, `isError`.
 */
export function parseOutput(tool: BuildTool, output: string, isError: boolean): BuildOutcome {
  const errors: BuildIssue[] = []
  const warnings: BuildIssue[] = []
  const seen = new Set<string>()
  let errorCount = 0
  let warningCount = 0
  let verdict: boolean | null = null
  let tests: { total: number; failed: number } | null = null
  // Swift Testing reports apart from XCTest: its own total, and a line per failed test.
  let swiftTotal: number | null = null
  let swiftFailed = 0
  let wentWrong: string | null = null
  const failedTests: string[] = []
  const testIssues: TestIssue[] = []
  const lines = output.split('\n')
  // A failed assertion is a test's failure, not the build's error: it goes with its test.
  const addTest = (issue: TestIssue) => {
    if (testIssues.length < ISSUE_LIMIT && !testIssues.some(one => one.test === issue.test && one.message === issue.message)) {
      testIssues.push({ ...issue, message: cleanMessage(issue.message) })
    }
  }

  const add = (found: BuildIssue) => {
    const issue = { ...found, message: cleanMessage(found.message) }
    const key = `${issue.severity}|${issue.file}|${issue.line}|${issue.message}`
    if (seen.has(key)) return
    seen.add(key)
    if (issue.severity === 'warning') {
      warningCount += 1
      if (warnings.length < ISSUE_LIMIT) warnings.push(issue)
      return
    }
    errorCount += 1
    if (errors.length < ISSUE_LIMIT) errors.push(issue)
  }

  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '').trimEnd()
    const failedTest = failedTestOf(line.trimStart())
    if (failedTest !== null && !failedTests.includes(failedTest) && failedTests.length < ISSUE_LIMIT) {
      failedTests.push(failedTest)
    }
    if (tool === 'xcodebuild') {
      const swift = swiftTestingOf(line.trimStart())
      if (swift !== null) {
        const run = swift.text.match(/^Test run with (\d+) tests?\b/)
        if (run) swiftTotal = Number(run[1])
        if (/^Test (?!run with ).+ failed after/.test(swift.text)) swiftFailed += 1
        const issue = swift.text.match(/^Test (.+?) recorded an issue at ([^\s:]+):(\d+)(?::\d+)?: (.+)$/)
        if (issue) {
          addTest({ test: unquote(issue[1] ?? ''), severity: 'error', file: issue[2] ?? null, line: Number(issue[3]), message: issue[4] ?? '' })
        }
        return
      }
      const marker = line.match(/^\*\* [A-Z -]+ (SUCCEEDED|FAILED) \*\*$/)
      if (marker) verdict = marker[1] === 'SUCCEEDED'
      const executed = line.match(/Executed (\d+) tests?, with (\d+) failures?/)
      if (executed) tests = { total: Number(executed[1]), failed: Number(executed[2]) }
      const diagnostic = line.match(XCODE_DIAGNOSTIC)
      // XCTest's `…/TripTests.swift:10: error: -[Module.TripTests testDuration] : XCTAssertEqual failed …`.
      const assertion = diagnostic?.[4]?.match(/^(?:-\[(?:\w+\.)?(\w+) (\w+)\]|((?:\w+\.)*\w+\(\))) : (.+)$/)
      if (diagnostic && assertion) {
        const test = assertion[3] ?? `${assertion[1]}.${assertion[2]}`
        addTest({ test, severity: 'error', file: diagnostic[1] ?? null, line: Number(diagnostic[2]), message: assertion[4] ?? '' })
        return
      }
      if (diagnostic) {
        add({
          severity: diagnostic[3] === 'warning' ? 'warning' : 'error',
          file: diagnostic[1] ?? null,
          line: Number(diagnostic[2]),
          message: diagnostic[4] ?? '',
        })
        return
      }
      const bare = line.match(BARE_ERROR)
      if (bare) add({ severity: 'error', file: null, line: null, message: bare[1] ?? '' })
      return
    }

    const marker = line.match(/^BUILD (SUCCESSFUL|FAILED)\b/)
    if (marker) verdict = marker[1] === 'SUCCESSFUL'
    const counted = line.match(/(\d+) tests? completed, (\d+) failed/)
    if (counted) tests = { total: Number(counted[1]), failed: Number(counted[2]) }
    if (line === '* What went wrong:') wentWrong = (lines[index + 1] ?? '').trim() || null
    const kotlin = line.match(KOTLIN_DIAGNOSTIC)
    if (kotlin) {
      add({ severity: kotlin[1] === 'w' ? 'warning' : 'error', file: kotlin[2] ?? null, line: Number(kotlin[3]), message: kotlin[4] ?? '' })
      return
    }
    const java = line.match(JAVA_DIAGNOSTIC)
    if (java) {
      add({ severity: java[3] === 'warning' ? 'warning' : 'error', file: java[1] ?? null, line: Number(java[2]), message: java[4] ?? '' })
    }
  })

  // No final marker: an error printed means it failed, even when a pipe (`| tail`) hid the exit code.
  const succeeded: boolean = verdict ?? (errorCount > 0 || failedTests.length > 0 ? false : !isError)
  if (!succeeded && errorCount === 0 && wentWrong !== null) {
    add({ severity: 'error', file: null, line: null, message: wentWrong })
  }

  const counted = tests as { total: number; failed: number } | null
  if (swiftTotal !== null) {
    tests = { total: (counted?.total ?? 0) + swiftTotal, failed: (counted?.failed ?? 0) + swiftFailed }
  }

  const full = formatLog(tool, output, Number.POSITIVE_INFINITY)

  return {
    status: succeeded ? 'succeeded' : 'failed',
    errors: withCode(errors, full),
    errorCount,
    warnings: withCode(warnings, full),
    warningCount,
    tests,
    failedTests,
    testIssues,
    log: formatLog(tool, output),
  }
}

/** Each diagnostic with the code the log shows under it, matched by where it points and what it says. */
function withCode(issues: readonly BuildIssue[], log: readonly LogLine[]): BuildIssue[] {
  const code = new Map<string, string>()
  log.forEach((line, index) => {
    if ((line.kind !== 'error' && line.kind !== 'warning') || line.at === undefined) return
    const lines: string[] = []
    for (let next = index + 1; log[next]?.kind === 'code'; next += 1) lines.push(log[next]?.text ?? '')
    if (lines.length > 0) code.set(`${line.at}|${line.text}`, lines.join('\n'))
  })

  return issues.map(issue => {
    const found = code.get(`${where(issue)}|${clip(issue.message, 240)}`)
    return found === undefined ? issue : { ...issue, code: found }
  })
}

/** How many lines of a build's formatted log it keeps, the last ones. */
export const LOG_LINES = 60

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** A line as the pane can draw it: terminal colors and control characters removed, tabs kept. */
function plain(line: string): string {
  return line
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trimEnd()
}

/**
 * A diagnostic's message without what repeats its location: XCTest's
 * `-[Module.TripTests testDuration] : ` before an assertion's message.
 */
export function cleanMessage(message: string): string {
  return clip(message.replace(/^(?:-\[[^\]]+\]|[\w.]+\(\)) : /, ''), 400)
}

// Swift Testing marks each line with a symbol: ◇ ✔ ✘ ↳ in a terminal, an SF Symbol from the
// private use plane in Xcode's output.
const SWIFT_TESTING_MARK = /^([◇✔✘↳]|[\u{100000}-\u{10FFFD}])\uFE0F? (.*)$/u
const DETAIL_MARKS = new Set(['↳', '\u{100135}'])

/** A Swift Testing line's mark and text, or null when the line is not one. */
export function swiftTestingOf(line: string): { mark: string; text: string } | null {
  const hit = line.match(SWIFT_TESTING_MARK)
  if (hit === null) return null
  const text = hit[2] ?? ''
  if (DETAIL_MARKS.has(hit[1] ?? '') || /^Test(?:ing| run| [^ ].* (?:started|passed|failed|skipped|recorded))\b/.test(text)) {
    return { mark: hit[1] ?? '', text }
  }

  return null
}

/** "0.43s", or nothing below a hundredth of a second. */
function took(seconds: string | undefined): string {
  const value = Number(seconds)

  return Number.isFinite(value) && value >= 0.01 ? ` (${value.toFixed(2)}s)` : ''
}

/** `"Rounds up"` → `Rounds up`. */
const unquote = (name: string) => name.replace(/^"(.*)"$/, '$1')

/** "BUILD" → "Build", "TEST BUILD" → "Test build". */
const sentence = (words: string) => words.charAt(0) + words.slice(1).toLowerCase()

type Draft = LogLine & { verb?: string; items?: string[] }

/** Collects a log's lines: repeats dropped, steps of one kind in a row folded into one line. */
class LogWriter {
  readonly lines: Draft[] = []
  private readonly seen = new Set<string>()

  push(line: LogLine): void {
    const last = this.lines.at(-1)
    if (line.kind !== 'code' && last?.kind === line.kind && last.text === line.text && last.at === line.at) return
    this.lines.push({ ...line, text: clip(line.text, line.kind === 'code' ? 160 : 240) })
  }

  /** Whether `key` is new; remembers it. */
  once(key: string): boolean {
    if (this.seen.has(key)) return false
    this.seen.add(key)

    return true
  }

  step(verb: string, item: string): void {
    if (!this.once(`step|${verb}|${item}`)) return
    const last = this.lines.at(-1)
    if (last?.verb === verb && last.items !== undefined) {
      last.items.push(item)
      return
    }
    this.lines.push({ kind: 'step', text: '', verb, items: [item] })
  }

  /** The log, its last `limit` lines when longer. */
  finish(limit: number): LogLine[] {
    const lines: LogLine[] = this.lines.map(({ verb, items, ...line }) =>
      verb === undefined || items === undefined
        ? line
        : {
            ...line,
            text:
              items.length <= 3
                ? `${verb} ${items.join(', ')}`
                : `${verb} ${items.slice(0, 2).join(', ')} and ${items.length - 2} more`,
          },
    )
    if (lines.length <= limit) return lines

    return [{ kind: 'text', text: `… ${lines.length - limit + 1} earlier lines` }, ...lines.slice(-(limit - 1))]
  }
}

/** A step's arguments, `\ ` read as a space within one. */
function stepArgs(rest: string): string[] {
  return rest
    .replace(/\\ /g, '\u0000')
    .split(' ')
    .filter(Boolean)
    .map(arg => arg.replace(/\u0000/g, ' ').replace(/\\(.)/g, '$1'))
}

// An xcodebuild step's header: `CompileSwift normal arm64 /…/Trip.swift (in target 'Demo' from project 'Demo')`,
// its command lines indented under it.
const STEP_HEADER = /^([A-Z][A-Za-z0-9]*)((?:\\ [A-Za-z0-9]+)*)(?: (.*))?$/
const ONE_WORD_STEPS = new Set(['Ld', 'Libtool', 'Copy', 'Touch', 'Validate', 'Ditto', 'Strip', 'Lipo'])
const IN_TARGET = /(?:^| )\(in target '[^']+' from project '[^']+'\)$/

function isStep(name: string, rest: string | undefined): boolean {
  const isName = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(name) || ONE_WORD_STEPS.has(name)

  return isName && (rest === undefined || rest.includes('/') || IN_TARGET.test(rest))
}

/** What a step does, as a verb and its object ("Compiling", "Trip.swift"); null for the ones not worth a line. */
export function xcodeStep(name: string, rest: string): [string, string] | null {
  const args = stepArgs(rest.replace(IN_TARGET, ''))
  // The path, last: `SwiftCompile normal arm64 Compiling\ Trip.swift /…/Trip.swift` names the file twice.
  const named = (pattern: RegExp) => {
    const hit = args.findLast(arg => pattern.test(arg))
    return hit === undefined ? null : base(hit)
  }
  const first = args[0] === undefined ? null : base(args[0])
  const as = (verb: string, item: string | null): [string, string] | null => (item === null ? null : [verb, item])

  switch (name) {
    case 'SwiftCompile':
    case 'CompileSwift':
      return as('Compiling', named(/\.swift$/))
    case 'CompileC':
      return as('Compiling', args[1] === undefined ? null : base(args[1]))
    case 'CompileAssetCatalog':
    case 'CompileAssetCatalogVariant':
      return as('Compiling', named(/\.xcassets$/))
    case 'CompileStoryboard':
    case 'CompileXIB':
    case 'CompileXCStrings':
      return as('Compiling', first)
    case 'Ld':
    case 'Libtool':
      return as('Linking', first)
    case 'LinkStoryboards':
      return ['Linking', 'storyboards']
    case 'CodeSign':
      return as('Signing', first)
    case 'ProcessInfoPlistFile':
    case 'ProcessXCFramework':
      return as('Processing', first)
    case 'PhaseScriptExecution':
      return as('Running script', args[0] ?? null)
    case 'CopySwiftLibs':
      return as('Copying Swift libraries into', first)
    case 'GenerateDSYMFile':
      return as('Generating', first)
    case 'Validate':
      return as('Validating', first)
    default:
      return null
  }
}

// Lines that say nothing about the build, and blocks that start with one (their indented lines go too).
const XCODE_NOISE = new Set([
  'Command line invocation:',
  'Resolve Package Graph',
  'Resolved source packages:',
  'Prepare packages',
  'Testing started',
  'Test session results, code coverage, and logs:',
  'Ignoring --strip-bitcode because --sign was not passed',
  'note: Building targets in dependency order',
])
const XCODE_NOISE_PREFIXES = [
  'Build description signature:',
  'Build description path:',
  'Writing result bundle at path:',
  'note: Target dependency graph',
  'note: Using codesigning identity override',
  '--- xcodebuild: WARNING: Using the first of multiple matching destinations',
  '{ platform:',
  'Details:  ',
  'Object:   ',
  'Method:   ',
  'Thread:   ',
  'Please file a bug at https://feedbackassistant.apple.com',
]
// `2026-10-06 12:19:51.322 xcodebuild[91243:17663762] …`: the tools' own debug logging.
const TIMESTAMPED = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [\w.-]+\[\d+:\d+\] /
const LOG_DIAGNOSTIC = new RegExp(String.raw`^${PATH}:(\d+)(?::\d+)?: (error|warning|note): (.+)$`)
// A diagnostic as xcpretty and xcbeautify print it: `❌  /…/Trip.swift:2:29: cannot find …`.
const PRETTY_DIAGNOSTIC = new RegExp(String.raw`^(?:${PATH}:(\d+)(?::\d+)?: )?(.+)$`)
const CARET = /^\s*[\^~][\^~ ]*$/
const GUTTER = /^\s*\d*\s*\|(?: |$)/

// The lists xcodebuild ends a run with, their items indented under them.
const LISTS = {
  'Failing tests:': ['Failing tests', 'tests'],
  'Testing failed:': ['Testing failed', 'failures'],
  'The following build commands failed:': ['Failed build commands', 'commands'],
} as const

/** Where a diagnostic points, as the log shows it: the file's name and the line. */
const at = (file: string, line: string | undefined) => `${base(file)}${line === undefined ? '' : `:${line}`}`

function formatXcode(lines: readonly string[], limit: number): LogLine[] {
  const log = new LogWriter()
  // What indented lines mean here: a step's commands (skip), a diagnostic's code (context), a list's items.
  let mode: 'none' | 'skip' | 'skipNext' | 'context' | 'list' = 'none'
  let keepContext = true
  let contextLines = 0
  let list: 'tests' | 'commands' | 'failures' = 'tests'
  let swiftFailed = 0

  // Logs a diagnostic once (an error repeats for each architecture); the lines after it are its code.
  const diagnostic = (kind: 'error' | 'warning' | 'note', where: string | undefined, message: string) => {
    const text = cleanMessage(message)
    keepContext = log.once(`${kind}|${where}|${text}`)
    if (keepContext) log.push({ kind, ...(where === undefined ? {} : { at: where }), text })
    contextLines = 0

    return 'context' as const
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = plain(lines[index] ?? '')
    const line = raw.trim()
    const isIndented = /^\s/.test(raw)
    if (mode === 'skipNext') {
      if (line !== '') mode = 'skip'
      continue
    }
    if (line === '') {
      mode = 'none'
      continue
    }
    if (mode === 'skip' && isIndented) continue
    if (mode === 'context') {
      const swift = swiftTestingOf(line)
      const isContext =
        GUTTER.test(raw) ||
        CARET.test(raw) ||
        (swift !== null && DETAIL_MARKS.has(swift.mark)) ||
        (contextLines === 0 && CARET.test(plain(lines[index + 1] ?? '')))
      if (isContext) {
        if (keepContext && contextLines < 8) log.push({ kind: 'code', text: swift === null ? raw : swift.text })
        contextLines += 1
        continue
      }
    }
    if (mode === 'list' && isIndented) {
      if (list === 'commands') {
        const header = line.match(STEP_HEADER)
        const step = header === null ? null : xcodeStep(header[1] ?? '', header[3] ?? '')
        if (step !== null) log.push({ kind: 'fail', text: step.join(' ') })
        else if (header === null || !isStep(header[1] ?? '', header[3])) log.push({ kind: 'fail', text: line })
      } else {
        log.push({ kind: 'fail', text: line })
      }
      continue
    }
    mode = 'none'

    if (line === 'Failed frontend command:') {
      mode = 'skipNext'
      continue
    }
    if (XCODE_NOISE.has(line) || XCODE_NOISE_PREFIXES.some(prefix => line.startsWith(prefix)) || TIMESTAMPED.test(line)) {
      mode = 'skip'
      continue
    }
    if (/^\(\d+ failures?\)$/.test(line)) continue

    const marker = line.match(/^\*\* ([A-Z -]+) (SUCCEEDED|FAILED) \*\*$/)
    if (marker) {
      const isOk = marker[2] === 'SUCCEEDED'
      log.push({ kind: isOk ? 'succeeded' : 'failed', text: `${sentence(marker[1] ?? 'BUILD')} ${isOk ? 'succeeded' : 'failed'}` })
      continue
    }
    const found = line.match(LOG_DIAGNOSTIC)
    if (found) {
      mode = diagnostic(found[3] as 'error' | 'warning' | 'note', at(found[1] ?? '', found[2]), found[4] ?? '')
      continue
    }
    const bare = line.match(/^(?:[\w.-]+: )?(error|warning|note|ERROR|WARNING): (.+)$/)
    if (bare) {
      mode = diagnostic((bare[1] ?? 'error').toLowerCase() as 'error' | 'warning' | 'note', undefined, bare[2] ?? '')
      continue
    }

    // Lists at the end of a run.
    const heading: (typeof LISTS)[keyof typeof LISTS] | undefined = LISTS[line as keyof typeof LISTS]
    if (heading !== undefined) {
      log.push({ kind: 'heading', text: heading[0] })
      list = heading[1]
      mode = 'list'
      continue
    }

    // XCTest.
    const suite = line.match(/^Test Suite '(.+)' started at/)
    if (suite) {
      const name = suite[1] ?? ''
      if (name !== 'All tests' && name !== 'Selected tests' && !name.endsWith('.xctest')) log.push({ kind: 'heading', text: name })
      continue
    }
    if (/^Test Suite '.+' (?:passed|failed) at/.test(line) || /^Test [Cc]ase '.+' started/.test(line)) continue
    const legacy = line.match(/^Test Case '-\[(?:\w+\.)?\w+ (\w+)\]' (passed|failed|skipped) \((\d+\.\d+) seconds\)/)
    const modern = line.match(/^Test case '([^']+)' (passed|failed|skipped) on .* \((\d+\.\d+) seconds\)/)
    const testCase = legacy ?? modern
    if (testCase) {
      const kind = testCase[2] === 'passed' ? 'pass' : testCase[2] === 'failed' ? 'fail' : 'note'
      log.push({ kind, text: `${testCase[1]}${testCase[2] === 'skipped' ? ' skipped' : ''}${took(testCase[3])}` })
      continue
    }
    const executed = line.match(/^Executed (\d+) tests?, with (\d+) failures?/)
    if (executed) {
      log.push({ kind: 'text', text: `${executed[1]} tests, ${executed[2]} failed` })
      continue
    }

    // Swift Testing.
    const swift = swiftTestingOf(line)
    if (swift !== null) {
      const text = swift.text
      const passed = text.match(/^Test (?!run with )(.+?) passed after ([\d.]+) seconds/)
      const failed = text.match(/^Test (?!run with )(.+?) failed after ([\d.]+) seconds/)
      const issue = text.match(/^Test .+? recorded an issue at ([^\s:]+):(\d+)(?::\d+)?: (.+)$/)
      const skipped = text.match(/^Test (.+?) skipped/)
      const run = text.match(/^Test run with (\d+) tests?\b/)
      if (/^Test run started/.test(text)) {
        log.push({ kind: 'heading', text: 'Swift Testing' })
      } else if (run) {
        log.push({ kind: 'text', text: `${run[1]} tests, ${swiftFailed} failed` })
      } else if (passed) {
        log.push({ kind: 'pass', text: `${unquote(passed[1] ?? '')}${took(passed[2])}` })
      } else if (failed) {
        swiftFailed += 1
        log.push({ kind: 'fail', text: `${unquote(failed[1] ?? '')}${took(failed[2])}` })
      } else if (issue) {
        mode = diagnostic('error', at(issue[1] ?? '', issue[2]), issue[3] ?? '')
      } else if (skipped) {
        log.push({ kind: 'note', text: `${unquote(skipped[1] ?? '')} skipped` })
      }
      continue
    }

    // What xcpretty and xcbeautify print in xcodebuild's place.
    const pretty = line.match(/^(▸|❌|⚠️?|✓|✔|✗|✖)\s+(.*)$/u)
    if (pretty) {
      const [, mark = '', text = ''] = pretty
      if (mark === '▸') {
        const done = text.match(/^(\w+(?: \w+)?) (Succeeded|Failed)$/i)
        if (done) log.push({ kind: /succeeded/i.test(done[2] ?? '') ? 'succeeded' : 'failed', text })
        else log.step(text.split(' ')[0] ?? '', text.split(' ').slice(1).join(' '))
      } else if (mark === '❌' || mark.startsWith('⚠')) {
        const parts = text.match(PRETTY_DIAGNOSTIC)
        mode = diagnostic(
          mark === '❌' ? 'error' : 'warning',
          parts?.[1] === undefined ? undefined : at(parts[1], parts[2]),
          parts?.[3] ?? text,
        )
      } else {
        log.push({ kind: mark === '✓' || mark === '✔' ? 'pass' : 'fail', text: text.replace(/ \((\d+\.\d+) seconds\)$/, (_, s) => took(s)) })
      }
      continue
    }
    const beautified = line.match(/^\[[^\]]+\] (Compiling|Linking|Signing|Processing|Copying|Running script) (.+)$/)
    if (beautified) {
      log.step(beautified[1] ?? '', beautified[2] ?? '')
      continue
    }

    const header = line.match(STEP_HEADER)
    if (header && isStep(header[1] ?? '', header[3])) {
      mode = 'skip'
      const step = xcodeStep(header[1] ?? '', header[3] ?? '')
      if (step !== null) log.step(...step)
      continue
    }

    log.push({ kind: 'text', text: line })
  }

  return log.finish(limit)
}

const GRADLE_NOISE_PREFIXES = [
  'FAILURE: Build ',
  'Deprecated Gradle features were used',
  "You can use '--warning-mode all'",
  'For more on this, please refer to',
  'See https://docs.gradle.org/',
  '> Configure project',
  '> Transform ',
  'Reusing configuration cache',
  'Configuration cache entry',
]

function formatGradle(lines: readonly string[], limit: number): LogLine[] {
  const log = new LogWriter()
  // What follows a line: the `* What went wrong:` section (kept), `* Try:` and the like (dropped), a failed test's trace.
  let mode: 'none' | 'wrong' | 'drop' | 'context' = 'none'
  let contextLines = 0

  for (let index = 0; index < lines.length; index += 1) {
    const raw = plain(lines[index] ?? '')
    const line = raw.trim()
    if (line === '') {
      if (mode !== 'drop') mode = 'none'
      continue
    }
    if (line.startsWith('* ')) {
      if (line === '* What went wrong:') {
        log.push({ kind: 'heading', text: 'What went wrong' })
        mode = 'wrong'
      } else {
        mode = 'drop'
      }
      continue
    }
    if (/^BUILD (SUCCESSFUL|FAILED)\b/.test(line)) {
      mode = 'none'
      const isOk = line.startsWith('BUILD SUCCESSFUL')
      log.push({ kind: isOk ? 'succeeded' : 'failed', text: sentence(line.replace(/^BUILD (SUCCESSFUL|FAILED)/, isOk ? 'BUILD SUCCESSFUL' : 'BUILD FAILED')) })
      continue
    }
    if (mode === 'drop') continue
    if (mode === 'wrong') {
      log.push({ kind: 'error', text: line.replace(/^> /, '') })
      continue
    }
    if (mode === 'context') {
      if (/^\s/.test(raw) || CARET.test(raw)) {
        if (contextLines < 3) log.push({ kind: 'code', text: raw.replace(/^ {4}/, '') })
        contextLines += 1
        continue
      }
      mode = 'none'
    }
    if (GRADLE_NOISE_PREFIXES.some(prefix => line.startsWith(prefix)) || /^<[=\-]*>/.test(line)) continue

    const task = line.match(/^> Task (:\S+)(?: (UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE|FAILED))?$/)
    if (task) {
      if (task[2] === 'FAILED') log.push({ kind: 'fail', text: `${task[1]} failed` })
      else if (task[2] === undefined) log.push({ kind: 'step', text: task[1] ?? '' })
      continue
    }
    const kotlin = line.match(KOTLIN_DIAGNOSTIC)
    if (kotlin) {
      log.push({ kind: kotlin[1] === 'w' ? 'warning' : 'error', at: at(kotlin[2] ?? '', kotlin[3]), text: cleanMessage(kotlin[4] ?? '') })
      continue
    }
    const java = line.match(JAVA_DIAGNOSTIC)
    if (java) {
      log.push({ kind: java[3] === 'warning' ? 'warning' : 'error', at: at(java[1] ?? '', java[2]), text: cleanMessage(java[4] ?? '') })
      // javac prints the line and a caret under it.
      if (CARET.test(plain(lines[index + 2] ?? ''))) {
        log.push({ kind: 'code', text: plain(lines[index + 1] ?? '') })
        log.push({ kind: 'code', text: plain(lines[index + 2] ?? '') })
        index += 2
      }
      continue
    }
    const test = line.match(/^([\w.$]+) > (.+?) (PASSED|FAILED|SKIPPED)$/)
    if (test) {
      const name = `${(test[1] ?? '').split('.').at(-1)}.${test[2]}`
      log.push({ kind: test[3] === 'PASSED' ? 'pass' : test[3] === 'FAILED' ? 'fail' : 'note', text: test[3] === 'SKIPPED' ? `${name} skipped` : name })
      if (test[3] === 'FAILED') {
        mode = 'context'
        contextLines = 0
      }
      continue
    }
    const actionable = line.match(/^\d+ actionable tasks?:/)
    if (actionable) {
      log.push({ kind: 'note', text: line })
      continue
    }

    log.push({ kind: 'text', text: line })
  }

  return log.finish(limit)
}

/**
 * A build's output as a log a person reads: each step one short line (a run
 * of compiles folded into one), errors and warnings with the code they point
 * at, tests passed and failed, and the result. The compiler's own command
 * lines, the tools' debug logging and the like are left out; a line the
 * formatter does not know stays as it is.
 */
export function formatLog(tool: BuildTool, output: string, limit = LOG_LINES): LogLine[] {
  const lines = output.split('\n')

  return tool === 'xcodebuild' ? formatXcode(lines, limit) : formatGradle(lines, limit)
}

/** A log as the pane draws it: lines, each run of code lines one block. */
export function logChunks(log: readonly LogLine[]): Array<{ code: string } | { line: LogLine }> {
  const chunks: Array<{ code: string } | { line: LogLine }> = []
  for (const line of log) {
    const last = chunks.at(-1)
    if (line.kind !== 'code') chunks.push({ line })
    else if (last !== undefined && 'code' in last) last.code += `\n${line.text}`
    else chunks.push({ code: line.text })
  }

  return chunks
}

const XCODE_FLAGS_ALONE = new Set([
  '-quiet',
  '-verbose',
  '-json',
  '-allowProvisioningUpdates',
  '-allowProvisioningDeviceRegistration',
  '-showBuildTimingSummary',
  '-skipPackagePluginValidation',
  '-skipMacroValidation',
  '-skipPackageUpdates',
  '-disableAutomaticPackageResolution',
  '-onlyUsePackageVersionsFromResolvedFile',
  '-hideShellScriptEnvironment',
  '-skipUnavailableActions',
  '-alltargets',
  '-dry-run',
  '-n',
])

/** A simple command's words as written, quotes and escapes kept. */
function rawWords(command: string): string[] {
  const out: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote !== null) {
      word += char
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < command.length) word += command[++index] ?? ''
    } else if (char === '"' || char === "'") {
      quote = char
      word += char
    } else if (char === '\\' && index + 1 < command.length) {
      word += char + (command[++index] ?? '')
    } else if (/\s/.test(char)) {
      if (word !== '') out.push(word)
      word = ''
    } else {
      word += char
    }
  }
  if (word !== '') out.push(word)

  return out
}

/** A build's command, one flag and its value to a line; any other command as it is. */
function formatSegment(words: readonly string[]): string {
  const line = words.join(' ')
  let at = 0
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || LEADING_COMMANDS.has(words[at] ?? ''))) at += 1
  const program = base(words[at] ?? '')
  const isXcode = program === 'xcodebuild'
  const isGradle = program === 'gradlew' || program === 'gradle' || program === 'gradlew.bat'
  if (line.length <= 60 || (!isXcode && !isGradle)) return line

  const rows: string[] = []
  let positional: string[] = []
  for (let index = at + 1; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (!word.startsWith('-')) {
      positional.push(word)
      continue
    }
    if (positional.length > 0) rows.push(positional.join(' '))
    positional = []
    const value = words[index + 1]
    const takesValue =
      value !== undefined &&
      !value.startsWith('-') &&
      (isXcode
        ? !XCODE_FLAGS_ALONE.has(word) && !XCODE_ACTIONS.has(value) && !/^[A-Z_][A-Z0-9_]*=/.test(value)
        : GRADLE_VALUED.has(word))
    rows.push(takesValue ? `${word} ${value}` : word)
    if (takesValue) index += 1
  }
  if (positional.length > 0) rows.push(positional.join(' '))

  return [words.slice(0, at + 1).join(' '), ...rows.map(row => `  ${row}`)].join(' \\\n')
}

/**
 * The line Claude ran as the pane shows it: the build's command a flag and
 * its value to a line, starting a line of its own, and what pipes it on (`|
 * xcpretty`) on the next. The rest stays as written, heredocs and all, and the
 * whole still runs as it is.
 */
export function formatCommand(fullCommand: string, command: string): string {
  const at = fullCommand.indexOf(command)
  if (at === -1) return fullCommand
  const breakAfter = (_: string, op: string) => (op === ';' ? '\n' : ` ${op}\n`)
  const before = fullCommand.slice(0, at).replace(/[ \t]*(&&|\|\||\||;)[ \t]*$/, breakAfter)
  const after = fullCommand.slice(at + command.length).replace(/^[ \t]*(&&|\|\||\||;)[ \t]*/, breakAfter)

  return before + formatSegment(rawWords(command)) + after
}

/**
 * A recorded build with the fields added since older versions recorded it
 * filled in, so a build kept across a reload always draws.
 */
export function upgrade(run: BuildRun): BuildRun {
  // Before the log, a build kept its output's last lines as they were.
  const old: Partial<BuildRun> & { outputTail?: string } = run

  return {
    ...run,
    fullCommand: old.fullCommand ?? run.command,
    warnings: old.warnings ?? [],
    failedTests: old.failedTests ?? [],
    testIssues: old.testIssues ?? [],
    log: old.log ?? (old.outputTail === undefined ? [] : formatLog(run.tool, old.outputTail)),
    logFile: old.logFile ?? null,
  }
}

/** The folder a build ran in, relative to the session's: the last `cd` before the build in its line. */
export function workdirOf(fullCommand: string, command: string): string | null {
  let dir: string | null = null
  for (const part of segments(fullCommand)) {
    if (part === command) break
    const [first, target] = words(part)
    if (first === 'cd' && target !== undefined) dir = target
  }

  return dir
}

/** Joins path parts, the way a shell resolves `cd` then a relative path: an absolute part starts over. */
export function joinPath(...parts: readonly string[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.startsWith('/')) out.length = 0
    for (const piece of part.split('/')) {
      if (piece === '' || piece === '.') continue
      if (piece === '..') out.pop()
      else out.push(piece)
    }
  }

  return `/${out.join('/')}`
}

/** "8s", "2m 14s", "1h 3m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "14:02", local time. */
export function clockTime(at: number): string {
  const date = new Date(at)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** "14:02" for a time today, else "6 Oct 14:02": earlier sessions' builds show their day. */
export function whenLabel(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return clockTime(at)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()] ?? ''

  return `${date.getDate()} ${month} ${clockTime(at)}`
}

/** How many projects' build histories are kept across sessions: the least recently built go first. */
export const PROJECTS_KEPT = 10

/** A build as the history keeps it across sessions: everything but its log, the bulk of it. */
export function forHistory(run: BuildRun): BuildRun {
  return { ...run, log: [] }
}

/** Whether `value`, read back from the store, has the shape of a recorded build. */
export function isStoredRun(value: unknown): value is BuildRun {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Partial<BuildRun>

  return (
    typeof run.id === 'string' &&
    typeof run.title === 'string' &&
    typeof run.command === 'string' &&
    typeof run.startedAt === 'number' &&
    (run.platform === 'ios' || run.platform === 'macos' || run.platform === 'android') &&
    (run.tool === 'xcodebuild' || run.tool === 'gradle') &&
    Array.isArray(run.errors)
  )
}

/**
 * The projects with a stored history, most recently built first, after a
 * build in `key`'s project; and the keys that fall past `PROJECTS_KEPT`.
 */
export function touchProject(stored: unknown, key: string): { projects: string[]; dropped: string[] } {
  const known = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string' && one !== key) : []
  const projects = [key, ...known]

  return { projects: projects.slice(0, PROJECTS_KEPT), dropped: projects.slice(PROJECTS_KEPT) }
}

/** `path:line` as a person scans it: the file's name and the line. */
export function where(issue: BuildIssue): string {
  if (issue.file === null) return ''
  const name = issue.file.split('/').at(-1) ?? issue.file

  return issue.line === null ? name : `${name}:${issue.line}`
}

/** "3 errors", "1 warning", "no errors". */
export function count(n: number, noun: string): string {
  return `${n === 0 ? 'no' : n} ${noun}${n === 1 ? '' : 's'}`
}

/** The line a finished build reports, in the pane and in its toast. */
export function summary(run: {
  status: BuildStatus
  errorCount: number
  warningCount: number
  tests: { total: number; failed: number } | null
}): string {
  const parts: string[] = []
  if (run.status === 'failed') parts.push(count(run.errorCount, 'error'))
  if (run.tests !== null) {
    parts.push(run.tests.failed > 0 ? `${run.tests.failed} of ${run.tests.total} tests failed` : `${run.tests.total} tests passed`)
  }
  if (run.warningCount > 0) parts.push(count(run.warningCount, 'warning'))

  return parts.join(' · ')
}

export const PLATFORM_NAME: Record<BuildPlatform, string> = { ios: 'iOS', macos: 'macOS', android: 'Android' }

/** The platforms `runs` holds, in the order the filter lists them. */
export function platformsOf(runs: readonly Pick<BuildRun, 'platform'>[]): BuildPlatform[] {
  return (['ios', 'macos', 'android'] as const).filter(platform => runs.some(run => run.platform === platform))
}

/**
 * The last run of the same build that succeeded before `run` started: same
 * platform, title and detail. `runs` is newest first.
 */
export function previousOf(run: BuildRun, runs: readonly BuildRun[]): BuildRun | undefined {
  return runs.find(
    other =>
      other.id !== run.id &&
      other.startedAt < run.startedAt &&
      other.status === 'succeeded' &&
      other.endedAt !== null &&
      other.platform === run.platform &&
      other.title === run.title &&
      other.detail === run.detail,
  )
}

/** How far along a build is against the last run's time, and what to say about it. */
export function remaining(elapsed: number, expected: number): { fraction: number; text: string } {
  if (elapsed < expected) return { fraction: elapsed / expected, text: `about ${duration(expected - elapsed)} left` }

  return { fraction: 1, text: `taking longer than last time (${duration(expected)})` }
}

/** "12s faster than last", "8s slower than last"; nothing within two seconds. */
export function delta(took: number, before: number): string {
  const diff = took - before
  if (Math.abs(diff) < 2_000) return ''

  return diff < 0 ? `${duration(-diff)} faster than last` : `${duration(diff)} slower than last`
}

/** A progress bar as SVG, `fraction` of `width` pixels filled, its track following the color scheme. */
export function progressSvg(fraction: number, width: number): string {
  const filled = Math.max(6, Math.round(width * Math.min(1, Math.max(0, fraction))))

  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='6'>` +
    '<style>.t{fill:#d0d7de}@media(prefers-color-scheme:dark){.t{fill:#3d444d}}</style>' +
    `<rect class='t' width='${width}' height='6' rx='3'/><rect width='${filled}' height='6' rx='3' fill='#d97757'/></svg>`
  )
}

/** The same bar in `cells` terminal cells. */
export function progressText(fraction: number, cells: number): string {
  const filled = Math.round(cells * Math.min(1, Math.max(0, fraction)))

  return '█'.repeat(filled) + '░'.repeat(Math.max(0, cells - filled))
}

/** The terminal's spinner, one frame per redraw. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length] ?? '⠋'
}

/** The spinner surfaces that draw SVG show: it turns by itself. */
export const SPINNER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'>" +
  '<style>circle{fill:none;stroke-width:2}.t{stroke:#d0d7de}.a{stroke:#57606a;stroke-linecap:round;' +
  'stroke-dasharray:9 26;transform-origin:7px 7px;animation:s .8s linear infinite}' +
  '@media(prefers-color-scheme:dark){.t{stroke:#3d444d}.a{stroke:#9198a1}}' +
  '@keyframes s{to{transform:rotate(360deg)}}</style>' +
  "<circle class='t' cx='7' cy='7' r='5.5'/><circle class='a' cx='7' cy='7' r='5.5'/></svg>"

/**
 * What to say about a failed test: "new" when the build's last run with
 * tests did not fail it; else how often it failed in the runs kept ("failed
 * 3 of last 4").
 */
export function testBadge(name: string, run: BuildRun, runs: readonly BuildRun[]): string {
  const same = runs.filter(
    other =>
      other.startedAt <= run.startedAt &&
      other.tests !== null &&
      other.platform === run.platform &&
      other.title === run.title &&
      other.detail === run.detail,
  )
  const earlier = same.filter(other => other.id !== run.id)
  if (earlier[0] === undefined || !earlier[0].failedTests.includes(name)) return 'new'
  const failed = same.filter(other => other.failedTests.includes(name)).length

  return `failed ${failed} of last ${same.length}`
}

/** A build's errors and failed tests as plain text: what Copy puts on the clipboard, and what Claude reads. */
export function problemsText(run: BuildRun): string {
  const lines = run.errors.map(issue => `${issue.file === null ? '' : `${issue.file}${issue.line === null ? '' : `:${issue.line}`}: `}error: ${issue.message}`)
  if (run.errorCount > run.errors.length) lines.push(`(${run.errorCount - run.errors.length} more errors)`)
  if (run.failedTests.length > 0) {
    lines.push(
      '',
      'Failed tests:',
      ...run.failedTests.map(name => {
        const issue = issueOfTest(run, name)
        return issue === undefined ? `- ${name}` : `- ${name}: ${issue.message}${issue.file === null ? '' : ` (${where(issue)})`}`
      }),
    )
  }

  return lines.join('\n')
}

/** What Ask Claude to fix sends: the build, how it failed, and to run it again once fixed. */
export function fixPrompt(run: BuildRun): string {
  const what = `${PLATFORM_NAME[run.platform]} build "${run.title}"${run.detail === '' ? '' : ` (${run.detail})`}`

  return [
    `The ${what} just failed. Fix it, then run the same build again to confirm it passes.`,
    '',
    'The command:',
    '```',
    run.fullCommand,
    '```',
    '',
    problemsText(run) || 'It printed no errors I could read; look at its output.',
  ].join('\n')
}

/** What Re-run sends: the same command, as it was run. */
export function rerunPrompt(run: BuildRun): string {
  return ['Run this build again, exactly as before:', '```', run.fullCommand, '```'].join('\n')
}

/** About how wide `text` draws at `size` px in the system sans-serif. */
export function textWidth(text: string, size: number): number {
  let ems = 0
  for (const char of text) {
    if ('il.,:;|!\''.includes(char)) ems += 0.27
    else if ('fjrt -/()[]·'.includes(char)) ems += 0.36
    else if ('mwMW'.includes(char)) ems += 0.86
    else if (char >= 'A' && char <= 'Z') ems += 0.66
    else ems += 0.56
  }

  return Math.ceil(ems * size)
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')

/** `text` cut with an ellipsis to draw within `width` px at `size` px. */
function fit(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text
  let cut = text
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width) cut = cut.slice(0, -1)

  return `${cut}…`
}

/** "1:24", minutes and seconds, as the timer shows them. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * A running build's header as the desktop draws it, inside the card's border: a ring timer (the time
 * so far, against the last green run's when there is one; a turning arc when
 * not), what is building, and under it a progress bar and the time left.
 * Redrawn each second; its colors follow the light or dark scheme. Answers
 * the markup and its height.
 */
export function runningHero(
  args: { label: string; title: string; detail: string; elapsed: number; expected: number | null; width: number },
): { svg: string; height: number } {
  const { label, title, detail, elapsed, expected, width } = args
  const ring = 76
  const r = 31
  const around = 2 * Math.PI * r
  const fraction = expected === null ? null : Math.min(1, elapsed / expected)
  const left = 16 + ring + 16
  const textWidth = width - left - 12
  const status =
    expected === null
      ? 'No earlier run to time it against'
      : elapsed < expected
        ? `About ${duration(expected - elapsed)} left`
        : `Taking longer than last time (${duration(expected)})`
  const barTop = 16 + ring + 18
  const height = fraction === null ? 16 + ring + 16 : barTop + 8 + 16
  const arc =
    fraction === null
      ? `<circle class='a spin' cx='${16 + ring / 2}' cy='${16 + ring / 2}' r='${r}' stroke-dasharray='${around * 0.22} ${around}'/>`
      : `<circle class='a' cx='${16 + ring / 2}' cy='${16 + ring / 2}' r='${r}' stroke-dasharray='${Math.max(0.5, around * fraction).toFixed(1)} ${around.toFixed(1)}' transform='rotate(-90 ${16 + ring / 2} ${16 + ring / 2})'/>`
  const bar =
    fraction === null
      ? ''
      : `<rect class='tr' x='16' y='${barTop}' width='${width - 32}' height='8' rx='4'/>` +
        `<rect class='fl' x='16' y='${barTop}' width='${Math.max(8, Math.round((width - 32) * fraction))}' height='8' rx='4'/>`

  return {
    height,
    svg:
      `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
      '<style>text{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}' +
      '.tk{fill:none;stroke:#eeece6;stroke-width:7}.a{fill:none;stroke:#d97757;stroke-width:7;stroke-linecap:round}' +
      ".spin{transform-origin:center;transform-box:fill-box;animation:s 1.1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}" +
      '.tm{fill:#1c1c1a;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}.of{fill:#6b6a64;font-size:10.5px}' +
      '.lb{fill:#6b6a64;font-size:10.5px;font-weight:600;letter-spacing:.06em}.dot{fill:#d97757}' +
      '.ti{fill:#1c1c1a;font-size:16px;font-weight:600}.de{fill:#4a4943;font-size:12.5px}.st{fill:#6b6a64;font-size:12px}' +
      '.tr{fill:#e6e4dd}.fl{fill:#d97757}' +
      '@media(prefers-color-scheme:dark){.tk{stroke:#3a3934}.tm,.ti{fill:#f2efe8}' +
      '.of,.lb,.st{fill:#a3a19a}.de{fill:#cfccc4}.tr{fill:#3a3934}}</style>' +
      `<circle class='tk' cx='${16 + ring / 2}' cy='${16 + ring / 2}' r='${r}'/>` +
      arc +
      `<text class='tm' x='${16 + ring / 2}' y='${16 + ring / 2 + (expected === null ? 6 : 2)}' text-anchor='middle'>${clock(elapsed)}</text>` +
      (expected === null ? '' : `<text class='of' x='${16 + ring / 2}' y='${16 + ring / 2 + 17}' text-anchor='middle'>of ~${clock(expected)}</text>`) +
      `<circle class='dot' cx='${left + 3}' cy='26' r='3.5'/>` +
      `<text class='lb' x='${left + 12}' y='30'>${escapeXml(fit(label.toUpperCase(), textWidth - 12, 11.5))}</text>` +
      `<text class='ti' x='${left}' y='54'>${escapeXml(fit(title, textWidth, 16))}</text>` +
      (detail === '' ? '' : `<text class='de' x='${left}' y='73'>${escapeXml(fit(detail, textWidth, 12.5))}</text>`) +
      `<text class='st' x='${left}' y='${detail === '' ? 73 : 90}'>${escapeXml(fit(status, textWidth, 12))}</text>` +
      bar +
      '</svg>',
  }
}

/**
 * Where a failed test failed: its assertion, matched by name; XCTest's
 * `TripTests.testDuration` also matches the `TripTests.testDuration()` of
 * newer Xcodes.
 */
export function issueOfTest(run: Pick<BuildRun, 'testIssues'>, name: string): TestIssue | undefined {
  const bare = (test: string) => test.replace(/\(\)$/, '')

  return run.testIssues.find(issue => bare(issue.test) === bare(name))
}

/** What the card says under a build's title: the platform and the detail, once each, and when it started. */
export function metaLine(run: Pick<BuildRun, 'platform' | 'detail' | 'startedAt'>): string {
  const platform = PLATFORM_NAME[run.platform]
  const detail = run.detail === platform ? '' : run.detail

  return [platform, detail, clockTime(run.startedAt)].filter(Boolean).join(' · ')
}
