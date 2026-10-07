import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  ActiveIssue,
  Issue,
  IssueDetail,
  IssueFilter,
  IssueLabel,
  IssueView,
  IssuesPane,
  OpenIssue,
  RepoChoice,
  RepoPicker,
} from '../types'
import {
  FILTERS,
  SPINNER_MS,
  SPINNER_SVG,
  assignedToast,
  byOwner,
  chips,
  excerpt,
  fitCards,
  isRepoName,
  isSameRepo,
  issuesArgs,
  labelDot,
  labelOptions,
  labelPills,
  matchesQuery,
  meta,
  mineArgs,
  newlyAssigned,
  parseAssigned,
  parseDetail,
  parseIssuesPage,
  parseRemote,
  parseRepos,
  pickKey,
  prBadge,
  repoMeta,
  reposArgs,
  spinnerFrame,
  viewArgs,
  workPrompt,
} from './lib'
import type { Assigned, IssuesPage } from './lib'

const PANE = 'github-issues'
const TITLE = 'Issues'
const REFRESH_MS = 2 * 60_000
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
// Mid-gray: a card's edge that reads on a light pane and on a dark one.
const CARD_BORDER = '#8c959f'

const EMPTY_PAGE: IssuesPane = {
  repo: null,
  scope: { filter: 'open', search: '', label: '' },
  load: { kind: 'empty' },
  issues: [],
  total: 0,
  labels: [],
  assigned: 0,
}

const view = atom({ plugin: 'github-issues', key: 'view' } as const, 'issues')
const query = atom({ plugin: 'github-issues', key: 'query' } as const, '')
const picker = atom({ plugin: 'github-issues', key: 'picker' } as const, {
  load: { kind: 'empty' },
  repos: [],
  here: null,
})
const pinned = atom({ plugin: 'github-issues', key: 'pinned' } as const, null)
const page = atom({ plugin: 'github-issues', key: 'page' } as const, EMPTY_PAGE)
const searchDraft = atom({ plugin: 'github-issues', key: 'searchDraft' } as const, '')
const open = atom({ plugin: 'github-issues', key: 'open' } as const, null)
const active = atom({ plugin: 'github-issues', key: 'active' } as const, null)

type Gh = { ok: true; stdout: string } | { ok: false; message: string }

let ghPath: string | undefined
let generation = 0
let repoGeneration = 0
let spinner: Timer | undefined
const details = new Map<string, IssueDetail>()

/**
 * The setters write a value only when it changed. Every write redraws the
 * pane, and a redraw gives every Button a new handle, so a press already on
 * its way with the old one is dropped: the fewer redraws, the fewer lost taps.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function setView($: EngineInterface, value: IssueView): Promise<void> {
  if (!same(await read($, view), value)) await update($, view, () => value)
}

async function setQuery($: EngineInterface, value: string): Promise<void> {
  if (!same(await read($, query), value)) await update($, query, () => value)
}

async function setPicker($: EngineInterface, value: RepoPicker): Promise<void> {
  if (!same(await read($, picker), value)) await update($, picker, () => value)
}

async function setPinned($: EngineInterface, value: string | null): Promise<void> {
  if (!same(await read($, pinned), value)) await update($, pinned, () => value)
}

async function setPage($: EngineInterface, value: IssuesPane): Promise<void> {
  if (!same(await read($, page), value)) await update($, page, () => value)
}

async function setSearchDraft($: EngineInterface, value: string): Promise<void> {
  if (!same(await read($, searchDraft), value)) await update($, searchDraft, () => value)
}

async function setOpen($: EngineInterface, value: OpenIssue | null): Promise<void> {
  if (!same(await read($, open), value)) await update($, open, () => value)
}

async function setActive($: EngineInterface, value: ActiveIssue | null): Promise<void> {
  if (!same(await read($, active), value)) await update($, active, () => value)
}

async function gh($: EngineInterface, args: string[]): Promise<Gh> {
  if (ghPath === undefined) {
    for (const candidate of GH_PATHS) {
      try {
        const probe = await $.process.run([candidate, '--version'], { timeoutMs: 5_000 })
        if (probe.exitCode === 0) {
          ghPath = candidate
          break
        }
      } catch {
        // not installed at this path
      }
    }
  }
  if (ghPath === undefined) {
    return { ok: false, message: 'The GitHub CLI (gh) was not found. Install it, then run `gh auth login`.' }
  }

  try {
    const ran = await $.process.run([ghPath, ...args], { timeoutMs: 30_000 })
    if (ran.exitCode === 0) return { ok: true, stdout: ran.stdout }
    const reason = ran.stderr.trim().split('\n')[0] ?? ''

    return { ok: false, message: reason || `gh exited with code ${ran.exitCode}` }
  } catch {
    return { ok: false, message: 'gh did not answer in time.' }
  }
}

async function detectRepo($: EngineInterface): Promise<string | null> {
  const found = await $.session.repo()
  const fromRemote = found?.remote ? parseRemote(found.remote) : null
  if (fromRemote !== null || found === null) return fromRemote

  const viewed = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

  return viewed.ok && isRepoName(viewed.stdout.trim()) ? viewed.stdout.trim() : null
}

/**
 * Reloads the issues shown; with no repository to show, opens the picker.
 * `isQuiet` (the timer, a finished turn): no spinner, the list kept on a
 * failure, and no redraw at all unless something changed.
 */
async function refresh($: EngineInterface, isQuiet = false): Promise<void> {
  if ((await read($, view)) !== 'issues') return
  try {
    await loadIssues($, isQuiet)
  } finally {
    await syncSpinner($)
  }
}

async function loadIssues($: EngineInterface, isQuiet: boolean): Promise<void> {
  const mine = ++generation
  const target = (await read($, pinned)) ?? (await detectRepo($))
  if (mine !== generation) return
  if (target === null) {
    await setPage($, EMPTY_PAGE)
    await showRepos($)
    return
  }

  const before = await read($, page)
  const isNewRepo = before.repo !== target
  let current: IssuesPane = isNewRepo
    ? { ...EMPTY_PAGE, repo: target, scope: { ...EMPTY_PAGE.scope, filter: before.scope.filter } }
    : before
  if (isNewRepo) {
    await setOpen($, null)
    await setActive($, null)
    await setSearchDraft($, '')
  }
  if (isNewRepo || !isQuiet || current.load.kind !== 'ready') {
    current = { ...current, load: { kind: 'loading' } }
    await setPage($, current)
    void syncSpinner($)
  }

  const { filter, search, label } = current.scope
  const listed = await gh($, issuesArgs(target, filter, search, label))
  if (mine !== generation) return
  const keepsList = isQuiet && current.load.kind === 'ready'
  if (!listed.ok) {
    if (!keepsList) await setPage($, { ...current, load: { kind: 'error', message: listed.message } })
    return
  }

  let parsed: IssuesPage
  try {
    parsed = parseIssuesPage(listed.stdout)
  } catch {
    const message = 'gh answered with something that is not JSON.'
    if (!keepsList) await setPage($, { ...current, load: { kind: 'error', message } })
    return
  }
  await noteAssigned($, target, parsed.assigned)
  await setPage($, {
    ...current,
    load: { kind: 'ready' },
    issues: parsed.issues,
    total: parsed.total,
    labels: parsed.labels,
    assigned: parsed.assigned.total,
  })
}

/** A toast for issues assigned since the last look at `target`, which the store keeps across sessions. */
async function noteAssigned($: EngineInterface, target: string, mine: Assigned): Promise<void> {
  const key = `seen:${target}`
  const toast = assignedToast(target, newlyAssigned(mine, await $.store.get(key)))
  if (toast !== undefined) $.ui.toast(toast, { timeoutMs: 8_000 })
  await $.store.set(
    key,
    mine.issues.map(issue => issue.number),
  )
}

/** The check while the picker shows instead of the list: only the person's assigned issues. */
async function checkAssigned($: EngineInterface): Promise<void> {
  const target = (await read($, pinned)) ?? (await detectRepo($))
  if (target === null) return
  const listed = await gh($, mineArgs(target))
  if (!listed.ok) return
  let mine: Assigned
  try {
    mine = parseAssigned(listed.stdout)
  } catch {
    return
  }
  await noteAssigned($, target, mine)
  const current = await read($, page)
  if (current.repo === target) await setPage($, { ...current, assigned: mine.total })
}

/** The timer: nothing while the pane is closed; the list, or the assigned check alone in the picker. */
async function tick($: EngineInterface): Promise<void> {
  if (!(await isOpen($))) return
  if ((await read($, view)) === 'issues') await refresh($, true)
  else await checkAssigned($)
}

/** Narrows the list: the new scope and the spinner in one write, the results in the next. */
async function rescope($: EngineInterface, change: Partial<IssuesPane['scope']>): Promise<void> {
  await setOpen($, null)
  const current = await read($, page)
  await setPage($, { ...current, scope: { ...current.scope, ...change }, load: { kind: 'loading' } })
  await refresh($)
}

async function submitSearch($: EngineInterface, text: string): Promise<void> {
  await setSearchDraft($, text)
  await rescope($, { search: text.trim() })
}

async function clearSearch($: EngineInterface): Promise<void> {
  await setSearchDraft($, '')
  await rescope($, { search: '', label: '' })
}

/** Switches the pane to the repository picker and loads its choices. */
async function showRepos($: EngineInterface): Promise<void> {
  try {
    await loadRepos($)
  } finally {
    await syncSpinner($)
  }
}

async function loadRepos($: EngineInterface): Promise<void> {
  const mine = ++repoGeneration
  // The list doesn't read these, so they redraw nothing until the view switches.
  const before = await read($, picker)
  await setPicker($, { ...before, load: { kind: 'loading' } })
  await setQuery($, '')
  await setView($, 'repos')
  void syncSpinner($)

  const session = await detectRepo($)
  const listed = await gh($, reposArgs())
  if (mine !== repoGeneration) return
  if (!listed.ok) {
    await setPicker($, { ...before, here: session, load: { kind: 'error', message: listed.message } })
    return
  }

  let parsed: RepoChoice[]
  try {
    parsed = parseRepos(listed.stdout)
  } catch {
    const message = 'gh answered with something that is not JSON.'
    await setPicker($, { ...before, here: session, load: { kind: 'error', message } })
    return
  }
  await setPicker($, { load: { kind: 'ready' }, repos: parsed, here: session })
}

/** Shows `name`'s issues: pinned, unless it is the session's own repository. */
async function chooseRepo($: EngineInterface, name: string): Promise<void> {
  const session = (await read($, picker)).here
  await setPinned($, name === session ? null : name)
  await backToIssues($)
}

/** Enter in the picker's filter: the name typed, else the first match. */
async function submitQuery($: EngineInterface, text: string): Promise<void> {
  const typed = text.trim()
  if (isRepoName(typed)) {
    await chooseRepo($, typed)
    return
  }
  const { here, repos } = await read($, picker)
  const names = [...(here === null ? [] : [here]), ...repos.map(one => one.name)]
  const first = names.find(name => matchesQuery(name, typed))
  if (first !== undefined) await chooseRepo($, first)
}

/** Back to the list: its spinner set while the picker still shows, so the switch is one redraw. */
async function backToIssues($: EngineInterface): Promise<void> {
  const current = await read($, page)
  await setPage($, { ...current, load: { kind: 'loading' } })
  await setView($, 'issues')
  await refresh($)
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  await $.store.set('isOpen', true)
}

async function toggleDetail($: EngineInterface, number: number): Promise<void> {
  try {
    await loadDetail($, number)
  } finally {
    await syncSpinner($)
  }
}

/**
 * Keeps the terminal's spinner turning while anything loads: a redraw per
 * frame, and only then. Surfaces that draw SVG show one that turns by itself.
 */
async function syncSpinner($: EngineInterface): Promise<void> {
  const shown = await read($, open)
  const isBusy =
    (await read($, page)).load.kind === 'loading' ||
    (await read($, picker)).load.kind === 'loading' ||
    (shown !== null && shown.detail === null)
  const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
  const isTicking = isBusy && surfaces.includes('terminal')
  if (isTicking && spinner === undefined) {
    spinner = $.clock.every(SPINNER_MS, () => $.ui.invalidate('ui.render'))
  } else if (!isTicking && spinner !== undefined) {
    spinner.cancel()
    spinner = undefined
  }
}

async function loadDetail($: EngineInterface, number: number): Promise<void> {
  if ((await read($, open))?.number === number) {
    await setOpen($, null)
    return
  }
  const target = (await read($, page)).repo
  if (target === null) return
  const key = `${target}#${number}`
  const known = details.get(key) ?? null
  await setOpen($, { number, detail: known })
  if (known !== null) return
  void syncSpinner($)

  const viewed = await gh($, viewArgs(target, number))
  if ((await read($, open))?.number !== number) return
  let loaded: IssueDetail
  if (!viewed.ok) {
    loaded = { number, body: `Could not load this issue: ${viewed.message}`, comments: 0 }
  } else {
    try {
      loaded = parseDetail(viewed.stdout)
      details.set(key, loaded)
    } catch {
      loaded = { number, body: 'gh answered with something that is not JSON.', comments: 0 }
    }
  }
  await setOpen($, { number, detail: loaded })
}

/**
 * Hands `issue` to Claude as a prompt of its own. Claude Code starts a mod's
 * prompt once the session is idle, so while a turn runs it waits, and the
 * card says Queued until Claude's turn on it begins. Not sent, with a toast
 * saying why, when the session works in another repository, or when the
 * issue was already handed over.
 */
async function workOn($: EngineInterface, issue: Issue): Promise<void> {
  const target = (await read($, page)).repo
  if (target === null) return
  const current = await read($, active)
  if (current?.number === issue.number) {
    $.ui.toast(current.state === 'queued' ? `#${issue.number} is already queued for Claude.` : `Claude is already on #${issue.number}.`)
    return
  }
  const session = await detectRepo($)
  if (!isSameRepo(session, target)) {
    $.ui.toast(
      `This session works in ${session ?? 'a folder with no GitHub repository'}, not ${target}. Open Claude Code in ${target}'s folder to hand Claude its issues.`,
      { timeoutMs: 10_000 },
    )
    return
  }

  await setActive($, { number: issue.number, state: 'queued' })
  let outcome: 'started' | 'dropped' | undefined
  const submitted = $.prompt.submit({ text: workPrompt(target, issue) }).then(
    result => {
      outcome = result.drop === undefined ? 'started' : 'dropped'
    },
    () => {
      outcome = 'dropped'
    },
  )
  await Promise.race([submitted, $.clock.sleep(500)])
  if (outcome === undefined) {
    $.ui.toast(`#${issue.number} is queued: Claude starts on it once it finishes the current task.`, { timeoutMs: 8_000 })
  }
  await submitted
  if ((await read($, active))?.number !== issue.number) return
  if (outcome === 'dropped') {
    await setActive($, null)
    $.ui.toast(`#${issue.number} was not handed to Claude.`)
    return
  }
  await setActive($, { number: issue.number, state: 'working' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: "Show GitHub issues in a side pane: this folder's repository, or pick or name one",
      argumentHint: '[owner/name | .]',
    })
    const started = await next(e)
    // Versions before 0.1.0's release pinned a status line; take down any left from them.
    $.ui.status(undefined)

    $.clock.every(REFRESH_MS, () => tick($))
    if ((await $.store.get('isOpen')) === true) {
      void (async () => {
        await openPane($)
        await refresh($)
      })()
    }

    return started
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    let arg = e.args.trim()
    // Started in a folder whose repository is on GitHub, /issues alone shows its issues; elsewhere, the picker.
    if (arg === '' && (await detectRepo($)) !== null) arg = '.'
    if (arg === '') {
      await openPane($)
      await showRepos($)

      return { text: 'Choose a repository in the Issues pane.' }
    }
    if (arg !== '.' && !isRepoName(arg)) {
      return { text: `"${arg}" is not a repository. Use /issues owner/name, /issues . for this session's repository, or /issues to pick one.` }
    }

    await setPinned($, arg === '.' ? null : arg)
    await setView($, 'issues')
    await openPane($)
    await refresh($)

    const shown = (await read($, page)).repo

    return { text: shown === null ? 'Choose a repository in the Issues pane.' : `Showing ${shown} issues.` }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await isOpen($))) void refresh($, true)

    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('isOpen', false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined
    // The terminal's table answers Svg with an element that draws nothing, so ask the surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const now = await $.clock.now()
    const busy = (text: string) => (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {Svg === undefined ? (
          <Text color="claude">{spinnerFrame(now)}</Text>
        ) : (
          <Svg source={SPINNER_SVG} alt="Loading" width={14} height={14} isInteractive />
        )}
        <Text dimColor>{text}</Text>
      </Box>
    )

    if ((await read($, view)) === 'repos') {
      const { here, repos: choices, load: status } = await read($, picker)
      const shown = (await read($, page)).repo
      const typed = await read($, query)
      const sections = byOwner(choices, here, typed)
      const isSessionShown = here !== null && matchesQuery(here, typed)
      const isEmpty = sections.length === 0 && !isSessionShown

      const row = (name: string, label: string) => (
        <Box key={`repo:${name}`} flexDirection="row" columnGap={2}>
          <Button
            key={pickKey(name)}
            label={name === shown ? `● ${label}` : label}
            plain
            onPress={() => void chooseRepo($, name)}
          />
          <Text dimColor wrap="truncate-end">
            {repoMeta(
              choices.find(one => one.name === name),
              now,
            )}
          </Text>
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>Choose a repository</Text>
            {shown !== null && <Button key="back" label="Back" plain onPress={() => void backToIssues($)} />}
          </Box>
          {Input !== undefined && (
            <Box marginTop={1}>
              <Input
                key="repo-filter"
                placeholder="Filter, or type owner/name"
                value={typed}
                submitLabel="open"
                onInput={text => void setQuery($, text)}
                onSubmit={text => void submitQuery($, text)}
              />
            </Box>
          )}
          {status.kind !== 'ready' && (
            <Box marginTop={1}>
              {status.kind === 'error' ? (
                <Text dimColor wrap="wrap">
                  {status.message}
                </Text>
              ) : (
                busy(choices.length > 0 ? 'Refreshing…' : 'Loading repositories…')
              )}
            </Box>
          )}
          {isSessionShown && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                This session
              </Text>
              {row(here, here)}
            </Box>
          )}
          {sections.map(section => (
            <Box key={`owner:${section.owner}`} flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                {section.owner}
              </Text>
              {section.repos.map(choice => row(choice.name, choice.name.slice(section.owner.length + 1)))}
            </Box>
          ))}
          {status.kind === 'ready' && isEmpty && (
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">
                {isRepoName(typed.trim())
                  ? `Press Enter to open ${typed.trim()}.`
                  : typed === ''
                    ? 'No repositories found. Run /issues owner/name.'
                    : 'No match. Type owner/name and press Enter to open any repository.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const { repo: shown, scope, load: status, issues: list, total, labels, assigned } = await read($, page)
    const opened = await read($, open)
    const working = await read($, active)
    const draft = await read($, searchDraft)
    const noun = FILTERS.find(one => one.id === scope.filter)?.noun ?? scope.filter
    const counted = `${total > list.length ? `${list.length} of ${total}` : list.length} ${noun}`
    const narrowing = [
      scope.search === '' ? '' : `matching "${scope.search}"`,
      scope.label === '' ? '' : `label ${scope.label}`,
    ].filter(Boolean)
    const labelChoices = labelOptions(labels, list, scope.label)
    // A card's inside: the pane's width less its border and padding.
    const rule = Math.max(1, e.props.bodyColumns - 4)
    const [owner, name] = shown === null ? [null, null] : (shown.split('/') as [string, string])
    // Labels are pills in one SVG where the surface draws SVG; on the terminal, dots and names.
    // A cell is about 7.5 CSS pixels wide on the surfaces that draw SVG.
    const pillsWidth = Math.max(160, Math.min(360, Math.floor(rule * 7.5)))
    const chipsOf = (shownLabels: readonly IssueLabel[]) => {
      if (Svg === undefined) {
        return shownLabels.map(one => (
          <Box flexDirection="row">
            <Text color={labelDot(one.color)}>●</Text>
            <Text>{` ${one.name}`}</Text>
          </Box>
        ))
      }
      const pills = labelPills(shownLabels, pillsWidth)

      return [
        <Svg
          source={pills.source}
          alt={`Labels: ${shownLabels.map(one => one.name).join(', ')}`}
          width={pills.width}
          height={pills.height}
        />,
      ]
    }

    const top = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" flexShrink={1}>
            {owner === null ? (
              <Text bold>No repository</Text>
            ) : (
              <Text dimColor wrap="truncate-end">{`${owner} / `}</Text>
            )}
            {name !== null && (
              <Text bold wrap="truncate-end">
                {name}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            <Button key="switch" label="Switch repo" plain onPress={() => void showRepos($)} />
            <Button key="refresh" label="Refresh" plain onPress={() => void rescope($, {})} />
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {FILTERS.map(one => (
            <Button
              key={`filter:${one.id}`}
              label={one.id === 'assigned' && assigned > 0 ? `${one.label} · ${assigned}` : one.label}
              variant={one.id === scope.filter ? 'primary' : 'secondary'}
              onPress={() => void rescope($, { filter: one.id as IssueFilter })}
            />
          ))}
        </Box>
        {(Input !== undefined || Select !== undefined) && (
          <Box flexDirection="column" marginTop={1} rowGap={1}>
            {Input !== undefined && (
              <Input
                key="issue-search"
                placeholder="Search issues"
                value={draft}
                submitLabel="Search"
                onInput={text => void setSearchDraft($, text)}
                onSubmit={text => void submitSearch($, text)}
              />
            )}
            {Select !== undefined && labelChoices.length > 1 && (
              <Select
                key="label-filter"
                label="Label"
                value={scope.label}
                options={labelChoices}
                onSelect={value => void rescope($, { label: value })}
              />
            )}
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {status.kind === 'loading' || status.kind === 'empty' ? (
            busy(list.length > 0 ? `${counted} · refreshing…` : 'Loading issues…')
          ) : (
            <Text dimColor wrap="wrap">
              {status.kind === 'error' ? status.message : list.length > 0 ? counted : `No issues ${noun}.`}
            </Text>
          )}
          {narrowing.length > 0 && (
            <Box flexDirection="row" columnGap={2}>
              <Text dimColor wrap="truncate-end">
                {narrowing.join(', ')}
              </Text>
              <Button key="clear-filters" label="Clear" plain onPress={() => void clearSearch($)} />
            </Box>
          )}
        </Box>
      </Box>
    )

    const cards = list.map(issue => {
      const isOpenHere = opened?.number === issue.number
      const handed = working?.number === issue.number ? working.state : null
      const isWorking = handed !== null
      const shownLabels = chips(issue.labels)
      const about = meta(issue, now)
      const pr = issue.pr === null ? null : { ...issue.pr, ...prBadge(issue.pr) }

      return (
        <Box
          key={`issue:${issue.number}`}
          flexDirection="column"
          marginTop={1}
          paddingX={1}
          borderStyle="bold"
          borderColor={isWorking ? 'claude' : CARD_BORDER}
        >
          <Text bold wrap="wrap" {...(isWorking ? { color: 'claude' } : {})}>
            {issue.title}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Link href={issue.url} label={`#${issue.number}`} />
            {about !== '' && <Text dimColor>{`· ${about}`}</Text>}
            {pr !== null && (
              <Box key={`pr:${issue.number}`} flexDirection="row" columnGap={1}>
                <Text dimColor>·</Text>
                <Link href={pr.url} label={`PR #${pr.number}`} />
                <Text color={pr.color}>{pr.text}</Text>
              </Box>
            )}
          </Box>
          {shownLabels.shown.length > 0 && (
            <Box
              key={`labels:${issue.number}`}
              flexDirection="row"
              flexWrap="wrap"
              alignItems="center"
              columnGap={1}
              marginTop={1}
            >
              {chipsOf(shownLabels.shown)}
              {shownLabels.more > 0 && <Text dimColor>{`+${shownLabels.more}`}</Text>}
            </Box>
          )}
          <Box flexDirection="row" columnGap={3} marginTop={1}>
            <Button
              key={`work:${issue.number}`}
              label={handed === 'queued' ? '◷ Queued' : handed === 'working' ? '● Working on it' : 'Work on it'}
              plain
              onPress={() => void workOn($, issue)}
            />
            <Button
              key={`details:${issue.number}`}
              label={isOpenHere ? 'Hide details' : 'Details'}
              plain
              onPress={() => void toggleDetail($, issue.number)}
            />
          </Box>
          {isOpenHere && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {'─'.repeat(rule)}
              </Text>
              {opened.detail !== null ? (
                <Box flexDirection="column">
                  <Markdown key={`body:${issue.number}`} text={excerpt(opened.detail.body)} />
                  <Box flexDirection="row" columnGap={1} marginTop={1}>
                    <Text dimColor>
                      {opened.detail.comments === 1 ? '1 comment' : `${opened.detail.comments} comments`}
                    </Text>
                    <Text dimColor>·</Text>
                    <Link href={issue.url} label="View on GitHub" />
                  </Box>
                </Box>
              ) : (
                busy('Loading…')
              )}
            </Box>
          )}
        </Box>
      )
    })
    // The engine refuses a whole tree past its size bound, so cards stop short of it.
    const fitted = fitCards(top, cards)

    return (
      <Box flexDirection="column">
        {top}
        {fitted.kept}
        {fitted.cut > 0 && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {`${fitted.cut} more didn't fit in the pane. Narrow the list with a search or a label.`}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
