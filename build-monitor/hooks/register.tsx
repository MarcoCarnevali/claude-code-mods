import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { BuildFilter, BuildIssue, BuildRun, BuildStatus, DetailTab, LogKind } from '../types'
import {
  HISTORY,
  PLATFORM_NAME,
  SPINNER_SVG,
  clock,
  clockTime,
  count,
  delta,
  detectBuild,
  duration,
  editorOf,
  fixPrompt,
  forHistory,
  formatCommand,
  isStoredRun,
  issueOfTest,
  joinPath,
  logChunks,
  metaLine,
  parseOutput,
  platformsOf,
  previousOf,
  problemsText,
  progressSvg,
  progressText,
  remaining,
  rerunPrompt,
  runningHero,
  spinnerFrame,
  summary,
  TOOL_NAME,
  testBadge,
  trendBlocks,
  trendOf,
  trendSummary,
  trendSvg,
  touchProject,
  upgrade,
  whenLabel,
  where,
  workdirOf,
} from './lib'
import type { BuildCommand } from './lib'

const PANE = 'build-monitor'
const TITLE = 'Build'
const builds = atom({ plugin: 'build-monitor', key: 'builds' } as const, [])
const shown = atom({ plugin: 'build-monitor', key: 'shown' } as const, null)
const opened = atom({ plugin: 'build-monitor', key: 'opened' } as const, null)
const asked = atom({ plugin: 'build-monitor', key: 'asked' } as const, null)
const filter = atom({ plugin: 'build-monitor', key: 'filter' } as const, 'all')

const STATUS_WORD: Record<BuildStatus, string> = {
  running: 'Building…',
  background: 'Running in the background',
  succeeded: 'Succeeded',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Not run',
}
const STATUS_COLOR: Partial<Record<BuildStatus, string>> = { succeeded: '#1a7f37', failed: '#cf222e' }
const WARNING = '#9a6700'
/** How many earlier builds the list shows. */
const EARLIER_SHOWN = 5
/** How many errors show the code they point at. */
const CODE_SHOWN = 5
/** How each kind of log line starts, and in what color; dim lines are the ones to read past. */
const LOG_STYLE: Record<Exclude<LogKind, 'code' | 'heading'>, { mark: string; color?: string; isDim?: boolean; isBold?: boolean }> = {
  step: { mark: '›', isDim: true },
  error: { mark: '✗', color: '#cf222e' },
  warning: { mark: '!', color: WARNING },
  note: { mark: '·', isDim: true },
  pass: { mark: '✓', color: '#1a7f37', isDim: true },
  fail: { mark: '✗', color: '#cf222e' },
  succeeded: { mark: '✓', color: '#1a7f37', isBold: true },
  failed: { mark: '✗', color: '#cf222e', isBold: true },
  text: { mark: ' ', isDim: true },
}
const EDGE: Record<BuildStatus, string> = {
  running: '#8c959f',
  background: '#8c959f',
  succeeded: '#1a7f37',
  failed: '#cf222e',
  stopped: '#8c959f',
  cancelled: '#8c959f',
}

let ticker: Timer | undefined

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Redraws the pane while a build runs, for its elapsed time: every second, or
 * every tenth of a second when a terminal draws it, for the spinner's frames.
 */
async function syncTicker($: EngineInterface): Promise<void> {
  const isRunning = (await read($, builds)).some(run => run.status === 'running')
  if (isRunning && ticker === undefined) {
    const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
    ticker = $.clock.every(surfaces.includes('terminal') ? 100 : 1_000, () => $.ui.invalidate('ui.render'))
  } else if (!isRunning && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

/** Records a build as it starts, shows it in the card and opens the pane on it. */
async function start($: EngineInterface, id: string, found: BuildCommand, line: string): Promise<void> {
  const startedAt = await $.clock.now()
  const run: BuildRun = {
    id,
    ...found,
    command: clip(found.command, 400),
    fullCommand: clip(line, 4_000),
    startedAt,
    endedAt: null,
    status: 'running',
    errors: [],
    errorCount: 0,
    warnings: [],
    warningCount: 0,
    tests: null,
    failedTests: [],
    testIssues: [],
    log: [],
    logFile: null,
  }
  await update($, builds, list => [run, ...list.filter(one => one.id !== id)].slice(0, HISTORY))
  if ((await read($, shown)) !== null) await update($, shown, () => null)
  // A new build always shows: a filter on another platform makes way for it.
  const current = await read($, filter)
  if (current !== 'all' && current !== found.platform) await update($, filter, () => 'all' as const)
  await syncTicker($)
  await $.ui.open({ id: PANE, title: TITLE })
}

/** The store key of this project's build history: the repository's root, else the session's folder. */
async function historyKey($: EngineInterface): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  const root = repo?.root ?? (await $.session.cwd().catch(() => ''))

  return `history:${root}`
}

/**
 * Keeps the project's finished builds across sessions (the last `HISTORY`,
 * without their logs), so the timer and the test badges know them tomorrow.
 * A store that cannot be written keeps nothing; the pane works the same.
 */
async function saveHistory($: EngineInterface): Promise<void> {
  try {
    const key = await historyKey($)
    const finished = (await read($, builds)).filter(run => run.status !== 'running' && run.status !== 'background')
    await $.store.set(key, finished.slice(0, HISTORY).map(forHistory))
    const touched = touchProject(await $.store.get('projects'), key)
    await $.store.set('projects', touched.projects)
    for (const dropped of touched.dropped) await $.store.delete(dropped)
  } catch {
    // no store here: the history lasts the session
  }
}

/** A new session starts with the project's builds from earlier ones. */
async function loadHistory($: EngineInterface): Promise<void> {
  if ((await read($, builds)).length > 0) return
  try {
    const stored = await $.store.get(await historyKey($))
    const runs = Array.isArray(stored) ? stored.filter(isStoredRun).map(upgrade).slice(0, HISTORY) : []
    if (runs.length > 0) await update($, builds, () => runs)
  } catch {
    // no store here: nothing to load
  }
}

/** Records how a build ended; answers the run as recorded. */
async function finish($: EngineInterface, id: string, change: Partial<BuildRun>): Promise<BuildRun | undefined> {
  const endedAt = change.status === 'background' ? null : await $.clock.now()
  const list = await update($, builds, current =>
    current.map(run => (run.id === id ? { ...run, ...change, endedAt } : run)),
  )
  await syncTicker($)
  await saveHistory($)

  return list.find(run => run.id === id)
}

type BashRecord = {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  backgroundTaskId?: string
  persistedOutputPath?: string
  rawOutputPath?: string
}

/** A build's whole output: the file Claude Code kept when it was long, else what the tool returned. */
async function outputOf($: EngineInterface, record: BashRecord | undefined, text: string | undefined): Promise<string> {
  const path = record?.persistedOutputPath ?? record?.rawOutputPath
  if (path !== undefined) {
    try {
      return await $.fs.read(path)
    } catch {
      // too large or gone: what the tool returned will do
    }
  }
  const streams = [record?.stdout ?? '', record?.stderr ?? ''].join('\n')

  return streams.trim() === '' ? (text ?? '') : streams
}

/** Clears the earlier builds: the latest stays, and so does any still running. */
async function clear($: EngineInterface): Promise<void> {
  const list = await update($, builds, current => current.filter((run, index) => index === 0 || run.status === 'running'))
  const kept = new Set(list.map(run => run.id))
  const selected = await read($, shown)
  if (selected !== null && !kept.has(selected)) await update($, shown, () => null)
  const tab = await read($, opened)
  if (tab !== null && !kept.has(tab.id)) await update($, opened, () => null)
  await saveHistory($)
}

/** Shows `id` in the card; the latest build when `id` is null. */
async function show($: EngineInterface, id: string | null): Promise<void> {
  await update($, shown, () => id)
}

const STUDIO_LAUNCHERS = ['/usr/local/bin/studio', '/opt/homebrew/bin/studio']

/**
 * Opens an error's file at its line: Xcode through `xed` for Apple builds;
 * Android Studio through its `studio` launcher when installed, else `open -a`
 * (the file, not the line); `open` when neither answers. A relative path is
 * looked up under the `cd` the build ran after, then the session's folder.
 */
async function openIssue($: EngineInterface, run: BuildRun, issue: BuildIssue): Promise<void> {
  if (issue.file === null) return
  const cwd = await $.session.cwd()
  const dir = workdirOf(run.fullCommand, run.command)
  const candidates = issue.file.startsWith('/')
    ? [issue.file]
    : [...(dir === null ? [] : [joinPath(cwd, dir, issue.file)]), joinPath(cwd, issue.file)]
  let path: string | undefined
  for (const candidate of candidates) {
    if (await $.fs.exists(candidate)) {
      path = candidate
      break
    }
  }
  if (path === undefined) {
    $.ui.toast(`Couldn't find ${issue.file} on this machine.`)
    return
  }

  const line = String(issue.line ?? 1)
  const attempts: string[][] = []
  const editor = editorOf(path, run.platform)
  if (editor === 'Android Studio') {
    for (const launcher of STUDIO_LAUNCHERS) {
      if (await $.fs.exists(launcher)) attempts.push([launcher, '--line', line, path])
    }
    attempts.push(['open', '-a', 'Android Studio', path])
  } else if (editor === 'Xcode') {
    attempts.push(['xed', '--line', line, path])
  }
  attempts.push(['open', path])
  for (const argv of attempts) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 15_000 })).exitCode === 0) return
    } catch {
      // not installed, or no answer: the next way
    }
  }
  $.ui.toast(`Couldn't open ${where(issue)}.`)
}

/** Opens the whole output Claude Code kept in the default text editor. */
async function openLog($: EngineInterface, path: string): Promise<void> {
  try {
    if ((await $.process.run(['open', '-t', path], { timeoutMs: 15_000 })).exitCode === 0) return
  } catch {
    // no answer: say so below
  }
  $.ui.toast("Couldn't open the full log.")
}

async function setFilter($: EngineInterface, next: BuildFilter): Promise<void> {
  await update($, filter, () => next)
  await update($, shown, () => null)
}

/** Opens `tab` under build `id`; the tab already open (`current`) closes instead. */
async function setTab($: EngineInterface, id: string, tab: DetailTab, current: DetailTab | null): Promise<void> {
  await update($, opened, () => ({ id, tab: tab === current ? null : tab }))
}

/**
 * Hands Claude the failed build to fix: a prompt with the command, the errors
 * and the failed tests. Claude Code holds a prompt a mod sends until Claude is
 * idle, so the button says Queued until the turn starts.
 */
async function askFix($: EngineInterface, run: BuildRun): Promise<void> {
  const current = await read($, asked)
  if (current?.id === run.id) {
    $.ui.toast(current.state === 'queued' ? 'Already queued for Claude.' : 'Claude is already on it.')
    return
  }
  await update($, asked, () => ({ id: run.id, state: 'queued' as const }))
  let outcome: 'started' | 'dropped' | undefined
  const submitted = $.prompt.submit({ text: fixPrompt(run) }).then(
    result => {
      outcome = result.drop === undefined ? 'started' : 'dropped'
    },
    () => {
      outcome = 'dropped'
    },
  )
  await Promise.race([submitted, $.clock.sleep(500)])
  if (outcome === undefined) $.ui.toast('Queued: Claude starts on the fix once it finishes the current task.', { timeoutMs: 8_000 })
  await submitted
  if ((await read($, asked))?.id !== run.id) return
  if (outcome === 'dropped') {
    await update($, asked, () => null)
    $.ui.toast('The fix was not handed to Claude.')
    return
  }
  await update($, asked, () => ({ id: run.id, state: 'working' as const }))
}

/** Asks Claude to run the build again, as it was run. */
async function rerun($: EngineInterface, run: BuildRun): Promise<void> {
  let isDone = false
  const submitted = $.prompt.submit({ text: rerunPrompt(run) }).then(
    () => {
      isDone = true
    },
    () => {
      isDone = true
    },
  )
  await Promise.race([submitted, $.clock.sleep(500)])
  if (!isDone) $.ui.toast('Queued: Claude runs it again once it finishes the current task.', { timeoutMs: 8_000 })
}

/** Puts the build's errors and failed tests on the clipboard. */
async function copyProblems($: EngineInterface, run: BuildRun, surface: RenderSurface | undefined): Promise<void> {
  const copied = await $.ui.copy({ text: problemsText(run), ...(surface === undefined ? {} : { surface }) }).catch(() => undefined)
  $.ui.toast(copied?.isCopied === true ? 'Errors copied.' : "Couldn't copy the errors.")
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'builds', description: 'Show the builds Claude ran in this project: Xcode, Gradle, SwiftPM, fastlane, Flutter, React Native' })
    const started = await next(e)
    // A reload drops the hook that was waiting on a build: its result never arrives here.
    // Builds an older version recorded lack the fields added since: fill them in.
    const list = await read($, builds)
    if (list.some(run => run.status === 'running' || JSON.stringify(upgrade(run)) !== JSON.stringify(run))) {
      await update($, builds, current =>
        current.map(run => {
          const filled = upgrade(run)
          return filled.status === 'running' ? { ...filled, status: 'stopped' as const, endedAt: filled.startedAt } : filled
        }),
      )
    }
    await loadHistory($)

    return started
  })

  on('command.run', { command: 'builds' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Build pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = detectBuild(e.command)
    if (found === null) return next(e)

    await start($, e.tool_use_id, found, e.command)
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      await finish($, e.tool_use_id, { status: 'stopped' })
      throw error
    }

    if (ran.deny !== undefined) {
      await finish($, e.tool_use_id, { status: 'cancelled' })
      return ran
    }
    const record = ran.result as BashRecord | undefined
    if (e.run_in_background === true || record?.backgroundTaskId !== undefined) {
      await finish($, e.tool_use_id, { status: 'background' })
      return ran
    }
    if (record?.interrupted === true) {
      await finish($, e.tool_use_id, { status: 'stopped' })
      return ran
    }

    const outcome = parseOutput(found.tool, await outputOf($, record, ran.text), ran.isError === true, found.platform)
    const done = await finish($, e.tool_use_id, { ...outcome, logFile: record?.persistedOutputPath ?? null })
    if (done !== undefined && done.endedAt !== null) {
      const tail = summary(done)
      $.ui.toast(
        `${PLATFORM_NAME[done.platform]} build ${done.status} in ${duration(done.endedAt - done.startedAt)}${tail === '' ? '' : ` · ${tail}`}`,
        { timeoutMs: 8_000 },
      )
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The turn Ask Claude to fix started has ended: the button is free again.
    if ((await read($, asked))?.state === 'working') await update($, asked, () => null)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Code, Text } = table
    // The terminal's table answers Svg with an element that draws nothing, so ask the surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const list = (await read($, builds)).map(upgrade)
    const selected = await read($, shown)
    const tabs = await read($, opened)
    const fixing = await read($, asked)
    const now = await $.clock.now()
    const [latest] = list

    if (latest === undefined) {
      return (
        <Box flexDirection="column">
          <Text bold>No builds yet</Text>
          <Text dimColor wrap="wrap">
            This pane opens by itself when Claude runs xcodebuild or Gradle.
          </Text>
        </Box>
      )
    }

    const choice = await read($, filter)
    const platforms = platformsOf(list)
    const active: BuildFilter = platforms.length > 1 && choice !== 'all' && platforms.includes(choice) ? choice : 'all'
    const visible = active === 'all' ? list : list.filter(one => one.platform === active)
    const newest = visible[0] ?? latest
    const run = visible.find(one => one.id === selected) ?? newest
    const isLatest = run.id === newest.id
    const others = visible.filter(one => one.id !== run.id)
    const isAnyRunning = list.some(one => one.status === 'running')
    const filters: BuildFilter[] = ['all', ...platforms]
    const isFinished = run.status !== 'running'
    const isFailed = run.status === 'failed'

    // The same build's last successful run: what the progress bar and the comparison measure against.
    const previous = previousOf(run, list)
    const expected = previous?.endedAt == null ? null : previous.endedAt - previous.startedAt
    const progress = run.status === 'running' && expected !== null ? remaining(now - run.startedAt, expected) : null
    const compared =
      run.status === 'succeeded' && run.endedAt !== null && expected !== null ? delta(run.endedAt - run.startedAt, expected) : ''
    const barWidth = Math.max(120, Math.min(360, Math.floor((e.props.bodyColumns - 4) * 7.5)))

    const icon = (one: BuildRun) => {
      switch (one.status) {
        case 'running':
          return Svg === undefined ? (
            <Text color="claude">{spinnerFrame(now)}</Text>
          ) : (
            <Svg source={SPINNER_SVG} alt="Building" width={14} height={14} isInteractive />
          )
        case 'succeeded':
          return <Text color={EDGE.succeeded}>✓</Text>
        case 'failed':
          return <Text color={EDGE.failed}>✗</Text>
        case 'background':
          return <Text dimColor>◐</Text>
        default:
          return <Text dimColor>■</Text>
      }
    }
    const took = (one: BuildRun) => duration((one.endedAt ?? now) - one.startedAt)
    const tail = summary(run)

    // What opens under a finished build, one at a time: its warnings, its log, its command.
    const extras: Array<{ tab: DetailTab; label: string }> = [
      ...(run.warnings.length > 0 ? [{ tab: 'warnings' as const, label: count(run.warningCount, 'warning') }] : []),
      ...(run.log.length > 0 || run.logFile !== null ? [{ tab: 'log' as const, label: 'log' }] : []),
      { tab: 'command' as const, label: 'command' },
    ]
    const picked = tabs?.id === run.id ? tabs.tab : null
    const tab = extras.some(one => one.tab === picked) ? picked : null

    // What a failed build's header says broke, in one line.
    const verdict = [
      run.tests !== null && run.tests.failed > 0
        ? `${run.tests.failed} of ${run.tests.total} tests failed`
        : run.failedTests.length > 0
          ? count(run.failedTests.length, 'failed test')
          : '',
      run.errorCount > 0 ? count(run.errorCount, 'error') : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const heroWidth = Math.max(240, Math.min(640, Math.floor((e.props.bodyColumns - 4) * 7.5)))
    // The same build's recent runs, once there are a few to compare: under a finished build.
    const trend = trendOf(run, list)
    const trendView =
      trend.length < 3 || run.status === 'running' ? null : (
        <Box flexDirection="column" marginTop={1}>
          {Svg !== undefined ? (
            <Svg
              source={trendSvg(trend, Math.min(heroWidth, trend.length * 28))}
              alt={`Last ${trend.length} runs: ${trend.map(point => duration(point.ms)).join(', ')}`}
              width={Math.min(heroWidth, trend.length * 28)}
              height={40}
            />
          ) : (
            <Box flexDirection="row">
              {trendBlocks(trend).map((block, index) => {
                const point = trend[index]
                return (
                  <Text {...(point?.isFailed === true ? { color: EDGE.failed } : point?.isCurrent === true ? { color: 'claude' } : { dimColor: true })}>
                    {block}
                  </Text>
                )
              })}
            </Box>
          )}
          <Text dimColor>{[`Last ${trend.length} runs`, trendSummary(trend)].filter(Boolean).join(' · ')}</Text>
        </Box>
      )
    const live = runningHero({
      label: `Building · ${PLATFORM_NAME[run.platform]} · ${TOOL_NAME[run.tool]}`,
      title: run.title,
      detail: run.detail,
      elapsed: now - run.startedAt,
      expected,
      width: heroWidth,
    })
    const isAsked = fixing?.id === run.id
    const askLabel = !isAsked ? 'Ask Claude to fix' : fixing.state === 'queued' ? 'Queued for Claude…' : 'Claude is on it'

    // An error: where, with the editor to open it in; what it says; the code it points at (the
    // first errors only: each block is up to eight lines, and the pane has a size limit).
    const issueBlock = (one: BuildIssue, color: string, key: string, hasCode: boolean) => (
      <Box key={`issue:${key}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text bold color={color} wrap="truncate-end">
            {where(one) === '' ? 'Build' : where(one)}
          </Text>
          {one.file !== null && <Button key={key} label={editorOf(one.file, run.platform)} plain dimColor onPress={() => void openIssue($, run, one)} />}
        </Box>
        <Text wrap="wrap">{one.message}</Text>
        {hasCode && one.code !== undefined && (
          <Box marginTop={1}>
            <Code source={one.code} language="text" wrap="truncate-end" />
          </Box>
        )}
      </Box>
    )
    // A failed test: its name and how often it failed; where its assertion failed and what it said.
    const testBlock = (name: string, index: number) => {
      const found = issueOfTest(run, name)
      return (
        <Box key={`test:${index}`} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Text bold color={EDGE.failed} wrap="truncate-end">{`✗ ${name}`}</Text>
            <Text dimColor>{testBadge(name, run, list)}</Text>
          </Box>
          {found !== undefined && (
            <Box flexDirection="column" paddingLeft={2}>
              <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                <Text dimColor wrap="truncate-end">
                  {where(found)}
                </Text>
                {found.file !== null && (
                  <Button
                    key={`open:test:${index}`}
                    label={editorOf(found.file, run.platform)}
                    plain
                    dimColor
                    onPress={() => void openIssue($, run, found)}
                  />
                )}
              </Box>
              <Text wrap="wrap">{found.message}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const tabContent = (() => {
      switch (tab) {
        case 'warnings':
          return (
            <Box flexDirection="column" rowGap={1}>
              {run.warnings.map((one, index) => issueBlock(one, WARNING, `open:warning:${index}`, false))}
              {run.warningCount > run.warnings.length && <Text dimColor>{`+${run.warningCount - run.warnings.length} more in the log`}</Text>}
            </Box>
          )
        case 'log':
          return (
            <Box flexDirection="column">
              {run.logFile !== null && (
                <Box flexDirection="row" justifyContent="flex-end">
                  <Button key="full-log" label="Open full log" plain dimColor onPress={() => void openLog($, run.logFile ?? '')} />
                </Box>
              )}
              {logChunks(run.log).map((chunk, index) => {
                if ('code' in chunk) {
                  return (
                    <Box key={`log:${index}`} paddingLeft={2} marginBottom={1}>
                      <Code source={chunk.code} language="text" wrap="truncate-end" />
                    </Box>
                  )
                }
                const { line } = chunk
                if (line.kind === 'heading') {
                  return (
                    <Box key={`log:${index}`} marginTop={index === 0 ? 0 : 1}>
                      <Text bold>{line.text}</Text>
                    </Box>
                  )
                }
                const style = LOG_STYLE[line.kind === 'code' ? 'text' : line.kind]
                const ink = style.color === undefined ? {} : { color: style.color }
                return (
                  <Box key={`log:${index}`} flexDirection="row" columnGap={1}>
                    <Text {...ink} dimColor={style.color === undefined}>
                      {style.mark}
                    </Text>
                    {line.at !== undefined && (
                      <Text bold {...ink}>
                        {line.at}
                      </Text>
                    )}
                    <Text wrap="wrap" dimColor={style.isDim === true} bold={style.isBold === true} {...(style.isBold === true ? ink : {})}>
                      {line.text}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )
        case 'command':
          return <Code source={formatCommand(run.fullCommand, run.command)} language="bash" wrap="wrap" />
        default:
          return null
      }
    })()

    return (
      <Box flexDirection="column">
        {platforms.length > 1 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginBottom={1}>
            {filters.map(one => (
              <Button
                key={`filter:${one}`}
                label={one === 'all' ? 'All' : PLATFORM_NAME[one]}
                variant={one === active ? 'primary' : 'secondary'}
                onPress={() => void setFilter($, one)}
              />
            ))}
          </Box>
        )}
        {!isLatest && (
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
            <Text dimColor>{`Earlier build · ${whenLabel(run.startedAt, now)}`}</Text>
            <Button key="latest" label="Latest" plain onPress={() => void show($, null)} />
          </Box>
        )}
        <Box key={`build:${run.id}`} flexDirection="column" paddingX={1} borderStyle="round" borderColor={EDGE[run.status]}>
          {isFailed ? (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                {icon(run)}
                <Text bold color={EDGE.failed} wrap="wrap">
                  {`${run.title} failed in ${took(run)}`}
                </Text>
              </Box>
              <Text dimColor wrap="wrap">
                {metaLine(run)}
              </Text>
              {verdict !== '' && (
                <Text color={EDGE.failed} wrap="wrap">
                  {verdict}
                </Text>
              )}
              {trendView}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center" marginTop={1}>
                <Button
                  key="fix"
                  label={askLabel}
                  // Outlined like Re-run: the desktop fills a primary button black, which reads as selected.
                  variant="secondary"
                  onPress={() => void askFix($, run)}
                />
                <Button key="rerun" label="↻ Re-run" variant="secondary" onPress={() => void rerun($, run)} />
              </Box>
            </Box>
          ) : run.status === 'running' && Svg !== undefined ? (
            <Box flexDirection="column" marginTop={1}>
              <Svg
                source={live.svg}
                alt={`Building ${run.title}: ${clock(now - run.startedAt)}${expected === null ? '' : ` of about ${clock(expected)}`}`}
                width={heroWidth}
                height={live.height}
                isInteractive
              />
              <Box marginTop={1}>
                <Text dimColor wrap="truncate-end">
                  {`$ ${run.command}`}
                </Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1} alignItems="center">
                {icon(run)}
                <Text dimColor>{`${PLATFORM_NAME[run.platform]} · ${TOOL_NAME[run.tool]}`}</Text>
              </Box>
              <Text bold wrap="wrap">
                {run.title}
              </Text>
              {run.detail !== '' && (
                <Text dimColor wrap="wrap">
                  {run.detail}
                </Text>
              )}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
                <Text bold {...(STATUS_COLOR[run.status] === undefined ? {} : { color: STATUS_COLOR[run.status] })}>
                  {STATUS_WORD[run.status]}
                </Text>
                <Text dimColor>{`· ${run.status === 'background' ? `started ${clockTime(run.startedAt)}` : took(run)}`}</Text>
                {tail !== '' && <Text dimColor>{`· ${tail}`}</Text>}
                {compared !== '' && <Text dimColor>{`· ${compared}`}</Text>}
              </Box>
              {trendView}
              {progress !== null && (
                <Box flexDirection="column" marginTop={1}>
                  {Svg === undefined ? (
                    <Text color="claude">{progressText(progress.fraction, Math.max(10, e.props.bodyColumns - 6))}</Text>
                  ) : (
                    <Svg
                      source={progressSvg(progress.fraction, barWidth)}
                      alt={`${Math.round(progress.fraction * 100)}% of the last run's time`}
                      width={barWidth}
                      height={6}
                    />
                  )}
                  <Text dimColor>{progress.text}</Text>
                </Box>
              )}
              <Box marginTop={1}>
                <Text dimColor wrap="truncate-end">
                  {`$ ${run.command}`}
                </Text>
              </Box>
            </Box>
          )}
          {isFailed && run.failedTests.length > 0 && (
            <Box flexDirection="column" marginTop={1} rowGap={1}>
              <Text bold dimColor>
                Failed tests
              </Text>
              {run.failedTests.map(testBlock)}
            </Box>
          )}
          {isFailed && run.errors.length > 0 && (
            <Box flexDirection="column" marginTop={1} rowGap={1}>
              <Text bold dimColor>
                Errors
              </Text>
              {run.errors.map((one, index) => issueBlock(one, EDGE.failed, `open:error:${index}`, index < CODE_SHOWN))}
              {run.errorCount > run.errors.length && <Text dimColor>{`+${run.errorCount - run.errors.length} more in the log`}</Text>}
            </Box>
          )}
          {isFinished && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} marginBottom={tab === null ? 0 : 1}>
              {extras.map(one => (
                <Button
                  key={`tab:${one.tab}`}
                  label={one.tab === tab ? `Hide ${one.label}` : one.label.charAt(0).toUpperCase() + one.label.slice(1)}
                  plain
                  dimColor={one.tab !== tab}
                  onPress={() => void setTab($, run.id, one.tab, tab)}
                />
              ))}
              {isFailed && (
                <Button key="copy" label="Copy errors" plain dimColor onPress={press => void copyProblems($, run, press.surface)} />
              )}
            </Box>
          )}
          {tabContent !== null && <Box flexDirection="column">{tabContent}</Box>}
        </Box>
        {others.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor bold>
                {isLatest ? 'Earlier' : 'Other builds'}
              </Text>
              {!isAnyRunning && list.length > 1 && <Button key="clear" label="Clear" plain onPress={() => void clear($)} />}
            </Box>
            {others.slice(0, EARLIER_SHOWN).map(one => (
              <Box key={`run:${one.id}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
                <Box flexDirection="row" columnGap={1} flexShrink={1}>
                  {icon(one)}
                  <Button key={`show:${one.id}`} label={one.title} plain onPress={() => void show($, one.id === latest.id ? null : one.id)} />
                </Box>
                <Text dimColor>{`${one.status === 'background' ? 'background' : took(one)} · ${whenLabel(one.startedAt, now)}`}</Text>
              </Box>
            ))}
            {others.length > EARLIER_SHOWN && <Text dimColor>{`${others.length - EARLIER_SHOWN} more`}</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
