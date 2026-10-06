import type { Issue, IssueDetail, IssueFilter, IssueLabel, LinkedPr, RepoChoice } from '../types'

export const LIMIT = 40
export const REPO_LIMIT = 30

export const FILTERS: readonly { id: IssueFilter; label: string; noun: string }[] = [
  { id: 'open', label: 'Open', noun: 'open' },
  { id: 'assigned', label: 'Assigned', noun: 'assigned to you' },
  { id: 'created', label: 'Created', noun: 'created by you' },
  { id: 'closed', label: 'Closed', noun: 'closed' },
]

const REMOTE = /github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/
const NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/** `owner/name` from a git remote URL, or null when it is not GitHub's. */
export function parseRemote(remote: string): string | null {
  const match = REMOTE.exec(remote.trim())

  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * The picker Button key for `name`: letters, digits and `-` as they are, any
 * other character as `_` and its hex code. The desktop rewrites a key's `/`,
 * and the engine answers a press whose key differs from the drawn one with
 * nothing, so a key holding `/` could never be pressed there.
 */
export function pickKey(name: string): string {
  return `pick:${name.replace(/[^A-Za-z0-9-]/g, char => `_${char.charCodeAt(0).toString(16)}`)}`
}

/** Whether `text` spells a repository as `owner/name`. */
export function isRepoName(text: string): boolean {
  return NAME.test(text)
}

const ISSUE_FIELDS =
  'number title url state updatedAt author { login } ' +
  'assignees(first: 5) { nodes { login } } ' +
  'labels(first: 10) { nodes { name color } } ' +
  'comments { totalCount } ' +
  'closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url state isDraft } }'

const MINE_FIELD =
  'mine: search(query: $mine, type: ISSUE, first: 100) { issueCount nodes { ... on Issue { number title url } } }'

const ISSUES_QUERY =
  'query($q: String!, $mine: String!, $owner: String!, $name: String!) { ' +
  `list: search(query: $q, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on Issue { ${ISSUE_FIELDS} } } } ` +
  `${MINE_FIELD} ` +
  'repository(owner: $owner, name: $name) { labels(first: 100, orderBy: {field: NAME, direction: ASC}) { nodes { name color } } } }'

const MINE_QUERY = `query($mine: String!) { ${MINE_FIELD} }`

/** The search that lists `repo`'s issues under `filter`, a label and typed text. */
export function searchQuery(repo: string, filter: IssueFilter, text = '', label = ''): string {
  const state = {
    open: 'is:open',
    assigned: 'is:open assignee:@me',
    created: 'is:open author:@me',
    closed: 'is:closed',
  }[filter]
  const parts = [`repo:${repo}`, 'is:issue', state]
  if (label !== '') parts.push(`label:"${label.replace(/"/g, '')}"`)
  if (text.trim() !== '') parts.push(text.trim())
  parts.push('sort:updated-desc')

  return parts.join(' ')
}

/** The search for `repo`'s open issues assigned to the person. */
export function mineQuery(repo: string): string {
  return `repo:${repo} is:issue is:open assignee:@me`
}

/** The `gh` arguments for one request: the list, the person's assigned issues, the labels. */
export function issuesArgs(repo: string, filter: IssueFilter, text = '', label = ''): string[] {
  const [owner = '', name = ''] = repo.split('/')

  return [
    'api', 'graphql',
    '-f', `query=${ISSUES_QUERY}`,
    '-f', `q=${searchQuery(repo, filter, text, label)}`,
    '-f', `mine=${mineQuery(repo)}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ]
}

/** The `gh` arguments that read only the person's assigned issues, for the background check. */
export function mineArgs(repo: string): string[] {
  return ['api', 'graphql', '-f', `query=${MINE_QUERY}`, '-f', `mine=${mineQuery(repo)}`]
}

/**
 * The `gh` arguments that list the repositories the person can reach, most
 * recently pushed first: their own, ones they collaborate on, and their orgs'.
 */
export function reposArgs(): string[] {
  const affiliations = '[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]'
  const query =
    `query { viewer { repositories(first: ${REPO_LIMIT}, ` +
    'orderBy: {field: PUSHED_AT, direction: DESC}, ' +
    `affiliations: ${affiliations}, ownerAffiliations: ${affiliations}) ` +
    '{ nodes { nameWithOwner isPrivate isArchived hasIssuesEnabled pushedAt ' +
    'issues(states: OPEN) { totalCount } } } } }'

  return ['api', 'graphql', '-f', `query=${query}`]
}

type RawRepo = {
  nameWithOwner: string
  isPrivate?: boolean
  isArchived?: boolean
  hasIssuesEnabled?: boolean
  pushedAt?: string
  issues?: { totalCount?: number }
}

/** The repositories worth picking: not archived, with issues turned on. */
export function parseRepos(stdout: string): RepoChoice[] {
  const raw = JSON.parse(stdout) as { data?: { viewer?: { repositories?: { nodes?: RawRepo[] } } } }
  const nodes = raw.data?.viewer?.repositories?.nodes ?? []

  return nodes
    .filter(node => node.isArchived !== true && node.hasIssuesEnabled !== false)
    .map(node => ({
      name: node.nameWithOwner,
      isPrivate: node.isPrivate === true,
      openIssues: node.issues?.totalCount ?? 0,
      pushedAt: node.pushedAt ?? '',
    }))
}

/** The dim text beside a repository in the picker: open issues, private, last push. */
export function repoMeta(choice: RepoChoice | undefined, now: number): string {
  if (choice === undefined) return ''

  return [
    `${choice.openIssues} open`,
    choice.isPrivate ? 'private' : '',
    choice.pushedAt === '' ? '' : age(choice.pushedAt, now),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Whether `name` matches what was typed in the picker's filter. */
export function matchesQuery(name: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return words.every(word => name.toLowerCase().includes(word))
}

/**
 * The picker's sections: one per owner, owners in the order their newest push
 * comes, leaving out `exclude` (the session's repository, listed on its own).
 */
export function byOwner(
  choices: readonly RepoChoice[],
  exclude: string | null,
  query: string,
): { owner: string; repos: RepoChoice[] }[] {
  const sections = new Map<string, RepoChoice[]>()
  for (const choice of choices) {
    if (choice.name === exclude || !matchesQuery(choice.name, query)) continue
    const owner = choice.name.split('/')[0] ?? choice.name
    sections.set(owner, [...(sections.get(owner) ?? []), choice])
  }

  return [...sections].map(([owner, repos]) => ({ owner, repos }))
}

/** The labels drawn as chips, and how many more there are. */
export function chips(labels: readonly IssueLabel[], max = 3): { shown: IssueLabel[]; more: number } {
  return { shown: labels.slice(0, max), more: Math.max(0, labels.length - max) }
}

type Rgb = [number, number, number]

function rgbOf(color: string): Rgb | null {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return null
  const value = Number.parseInt(color, 16)

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function hexOf([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** `rgb` with its HSL lightness moved into [min, max], hue and saturation kept. */
function withLightness([red, green, blue]: Rgb, min: number, max: number): string {
  const [r, g, b] = [red / 255, green / 255, blue / 255]
  const high = Math.max(r, g, b)
  const low = Math.min(r, g, b)
  const lightness = (high + low) / 2
  const target = Math.min(max, Math.max(min, lightness))
  if (target === lightness) return hexOf([red, green, blue])
  const delta = high - low
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (delta !== 0) {
    if (high === r) hue = ((g - b) / delta + 6) % 6
    else if (high === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
  }
  const chroma = (1 - Math.abs(2 * target - 1)) * saturation
  const second = chroma * (1 - Math.abs((hue % 2) - 1))
  const base = target - chroma / 2
  const [p, q, t] =
    hue < 1 ? [chroma, second, 0]
    : hue < 2 ? [second, chroma, 0]
    : hue < 3 ? [0, chroma, second]
    : hue < 4 ? [0, second, chroma]
    : hue < 5 ? [second, 0, chroma]
    : [chroma, 0, second]

  return hexOf([(p + base) * 255, (q + base) * 255, (t + base) * 255])
}

/** A label's text color on its tinted pill: dark enough on a light pane, light enough on a dark one. */
export function labelInk(color: string): { light: string; dark: string } {
  const rgb = rgbOf(color) ?? [128, 128, 128]

  return { light: withLightness(rgb, 0, 0.32), dark: withLightness(rgb, 0.75, 1) }
}

/** About how wide `text` sets at 11px in a system sans-serif, in CSS pixels. */
export function textWidth(text: string): number {
  let ems = 0
  for (const char of text) {
    if ('il.,:;|!\''.includes(char)) ems += 0.27
    else if ('fjrt -/()[]'.includes(char)) ems += 0.36
    else if ('mwMW'.includes(char)) ems += 0.86
    else if (char >= 'A' && char <= 'Z') ems += 0.66
    else ems += 0.56
  }

  return Math.ceil(ems * 11)
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')

/**
 * A card's labels as GitHub draws them, in one small SVG: 11px text on pills
 * tinted with each label's color, wrapped to rows no wider than `maxWidth`
 * pixels, the ink switching with the light or dark color scheme. One SVG per
 * card, not per label: the engine bounds a pane's whole tree, and the shared
 * markup is most of a pill's cost.
 */
export function labelPills(
  labels: readonly IssueLabel[],
  maxWidth: number,
): { source: string; width: number; height: number } {
  const pillHeight = 20
  const gap = 6
  const light: string[] = []
  const dark: string[] = []
  const shapes: string[] = []
  let x = 0
  let y = 0
  let width = 0
  labels.forEach((label, index) => {
    const text = textWidth(label.name)
    const pill = text + 16
    if (x > 0 && x + pill > maxWidth) {
      x = 0
      y += pillHeight + 4
    }
    const fill = rgbOf(label.color) === null ? '#808080' : `#${label.color.toLowerCase()}`
    const ink = labelInk(label.color)
    light.push(`.c${index}{fill:${ink.light}}`)
    dark.push(`.c${index}{fill:${ink.dark}}`)
    shapes.push(
      `<rect x='${x + 0.5}' y='${y + 0.5}' width='${pill - 1}' height='${pillHeight - 1}' rx='9.5' fill='${fill}' stroke='${fill}'/>` +
        `<text class='c${index}' x='${x + 8}' y='${y + 14}' textLength='${text}' lengthAdjust='spacingAndGlyphs'>${escapeXml(label.name)}</text>`,
    )
    width = Math.max(width, x + pill)
    x += pill + gap
  })
  const height = y + pillHeight
  // Single quotes: the source crosses as JSON, where each double quote costs an escape.
  const source =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>` +
    `<style>rect{fill-opacity:.18;stroke-opacity:.55}text{font:500 11px system-ui}${light.join('')}` +
    `@media(prefers-color-scheme:dark){${dark.join('')}}</style>${shapes.join('')}</svg>`

  return { source, width, height }
}

/** The terminal's spinner, one frame per redraw. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** How often the terminal's spinner moves, in milliseconds. */
export const SPINNER_MS = 100

export function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length] ?? '⠋'
}

/** The spinner surfaces that draw SVG show: it turns by itself, so the pane never redraws for it. */
export const SPINNER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
  '<style>circle{fill:none;stroke-width:2}.t{stroke:#d0d7de}.a{stroke:#57606a;stroke-linecap:round;' +
  'stroke-dasharray:9 26;transform-origin:7px 7px;animation:s .8s linear infinite}' +
  '@media(prefers-color-scheme:dark){.t{stroke:#3d444d}.a{stroke:#9198a1}}' +
  '@keyframes s{to{transform:rotate(360deg)}}</style>' +
  '<circle class="t" cx="7" cy="7" r="5.5"/><circle class="a" cx="7" cy="7" r="5.5"/></svg>'

/** How many options a `Select` may hold: the engine refuses the whole tree past this. */
export const SELECT_LIMIT = 64

/**
 * The label picker's options: "Any label", the chosen label, then the labels
 * the loaded issues use most, then the rest by name, `SELECT_LIMIT` in all.
 */
export function labelOptions(
  labels: readonly IssueLabel[],
  issues: readonly Pick<Issue, 'labels'>[],
  current: string,
): { key: string; value: string; label: string }[] {
  const uses = new Map<string, number>()
  for (const issue of issues) {
    for (const label of issue.labels) uses.set(label.name, (uses.get(label.name) ?? 0) + 1)
  }
  const names = [...new Set([...labels.map(label => label.name), ...uses.keys()])]
  const ranked = names
    .filter(name => name !== current)
    .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || a.localeCompare(b))
  const picked = [...(current === '' ? [] : [current]), ...ranked].slice(0, SELECT_LIMIT - 1)

  return [
    { key: 'label:any', value: '', label: 'Any label' },
    ...picked.map(name => ({ key: `label:${name}`, value: name, label: name })),
  ]
}

/**
 * A label's color for its dot: GitHub's `rrggbb`, darkened when it is so pale
 * (a light cyan, a yellow) that it would vanish on a light pane; gray when unset.
 */
export function labelDot(color: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return '#808080'
  const value = Number.parseInt(color, 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  const [red = 0, green = 0, blue = 0] = channels
  if (0.299 * red + 0.587 * green + 0.114 * blue <= 186) return `#${color.toLowerCase()}`

  return `#${channels.map(channel => Math.round(channel * 0.7).toString(16).padStart(2, '0')).join('')}`
}

/** The `gh` arguments that read one issue's body and comments. */
export function viewArgs(repo: string, number: number): string[] {
  return ['issue', 'view', String(number), '-R', repo, '--json', 'number,body,comments']
}

type Nodes<T> = { nodes?: (T | null)[] }

type RawPr = { number: number; url: string; state: string; isDraft?: boolean }

type RawIssue = {
  number?: number
  title?: string
  url?: string
  state?: string
  updatedAt?: string
  author?: { login?: string } | null
  assignees?: Nodes<{ login?: string }>
  labels?: Nodes<{ name?: string; color?: string }>
  comments?: { totalCount?: number }
  closedByPullRequestsReferences?: Nodes<RawPr>
}

type RawSearch = { issueCount?: number; nodes?: (RawIssue | null)[] }

export type Assigned = { total: number; issues: { number: number; title: string; url: string }[] }

export type IssuesPage = {
  issues: Issue[]
  total: number
  assigned: Assigned
  labels: IssueLabel[]
}

function nodes<T>(list: Nodes<T> | undefined): T[] {
  return (list?.nodes ?? []).filter((node): node is T => node !== null && node !== undefined)
}

/** The linked pull request worth showing: open, then draft, then merged, then closed. */
export function pickPr(prs: readonly RawPr[]): LinkedPr | null {
  const linked = prs.map(pr => ({
    number: pr.number,
    url: pr.url,
    state: (pr.state === 'OPEN' && pr.isDraft === true ? 'DRAFT' : pr.state) as LinkedPr['state'],
  }))
  for (const state of ['OPEN', 'DRAFT', 'MERGED', 'CLOSED'] as const) {
    const found = linked.find(pr => pr.state === state)
    if (found !== undefined) return found
  }

  return null
}

/** A linked pull request's state, as words and a color. */
export function prBadge(pr: LinkedPr): { text: string; color: string } {
  switch (pr.state) {
    case 'OPEN':
      return { text: 'open', color: 'success' }
    case 'DRAFT':
      return { text: 'draft', color: '#808080' }
    case 'MERGED':
      return { text: 'merged', color: '#8250df' }
    case 'CLOSED':
      return { text: 'closed', color: '#cf222e' }
  }
}

function toIssue(raw: RawIssue): Issue | null {
  if (raw.number === undefined || raw.title === undefined || raw.url === undefined) return null

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state ?? 'OPEN',
    labels: nodes(raw.labels)
      .filter(label => label.name)
      .map(label => ({ name: label.name ?? '', color: label.color ?? '' })),
    assignees: nodes(raw.assignees).map(person => person.login ?? '').filter(Boolean),
    author: raw.author?.login ?? 'ghost',
    updatedAt: raw.updatedAt ?? '',
    comments: raw.comments?.totalCount ?? 0,
    pr: pickPr(nodes(raw.closedByPullRequestsReferences)),
  }
}

function toAssigned(raw: RawSearch | undefined): Assigned {
  return {
    total: raw?.issueCount ?? 0,
    issues: (raw?.nodes ?? []).flatMap(node =>
      node?.number !== undefined && node.title !== undefined && node.url !== undefined
        ? [{ number: node.number, title: node.title, url: node.url }]
        : [],
    ),
  }
}

/** What the issues request answered: the page, how many match, the person's assigned issues, the labels. */
export function parseIssuesPage(stdout: string): IssuesPage {
  const raw = JSON.parse(stdout) as {
    data?: { list?: RawSearch; mine?: RawSearch; repository?: { labels?: Nodes<{ name?: string; color?: string }> } | null }
  }
  const list = raw.data?.list

  return {
    issues: (list?.nodes ?? []).flatMap(node => {
      const issue = node === null ? null : toIssue(node)

      return issue === null ? [] : [issue]
    }),
    total: list?.issueCount ?? 0,
    assigned: toAssigned(raw.data?.mine),
    labels: nodes(raw.data?.repository?.labels ?? undefined)
      .filter(label => label.name)
      .map(label => ({ name: label.name ?? '', color: label.color ?? '' })),
  }
}

/** What the background check answered: the person's assigned issues. */
export function parseAssigned(stdout: string): Assigned {
  const raw = JSON.parse(stdout) as { data?: { mine?: RawSearch } }

  return toAssigned(raw.data?.mine)
}

/** Issues assigned since `seen` was recorded; none on the first look at a repository. */
export function newlyAssigned(assigned: Assigned, seen: unknown): Assigned['issues'] {
  if (!Array.isArray(seen)) return []

  return assigned.issues.filter(issue => !seen.includes(issue.number))
}

/** The toast for newly assigned issues. */
export function assignedToast(repo: string, fresh: Assigned['issues']): string | undefined {
  const [first] = fresh
  if (first === undefined) return undefined
  if (fresh.length === 1) return `Assigned to you: #${first.number} ${first.title}`

  return `${fresh.length} issues newly assigned to you in ${repo}`
}

export function parseDetail(stdout: string): IssueDetail {
  const raw = JSON.parse(stdout) as { number: number; body?: string; comments?: unknown[] }

  return { number: raw.number, body: raw.body ?? '', comments: raw.comments?.length ?? 0 }
}

/** "just now", "5m", "3h", "2d", "4w", "8mo" or "2y" between `iso` and `now`. */
export function age(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''

  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`

  return `${Math.floor(days / 365)}y`
}

/** The dim text after an issue's number: assignees, when it last changed, comments. */
export function meta(issue: Issue, now: number): string {
  const parts = [
    issue.assignees.map(login => `@${login}`).join(' '),
    age(issue.updatedAt, now),
    issue.comments === 0 ? '' : issue.comments === 1 ? '1 comment' : `${issue.comments} comments`,
  ]

  return parts.filter(Boolean).join(' · ')
}

/**
 * What the pane may spend of the engine's bound on a drawn tree (100,000
 * characters serialized, past which it refuses the whole tree and draws nothing).
 */
export const TREE_BUDGET = 90_000

function sizeOf(node: unknown): number {
  try {
    return JSON.stringify(node)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The cards that fit beside `top` within `TREE_BUDGET`, in order, and how many were cut. */
export function fitCards<T>(top: unknown, cards: readonly T[], budget = TREE_BUDGET): { kept: T[]; cut: number } {
  let used = sizeOf(top)
  const kept: T[] = []
  for (const card of cards) {
    used += sizeOf(card) + 1
    if (used > budget) break
    kept.push(card)
  }

  return { kept, cut: cards.length - kept.length }
}

/** The issue body as the pane shows it: trimmed, and cut when long. */
export function excerpt(body: string, max = 1500): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (text === '') return '_No description._'
  if (text.length <= max) return text

  return `${text.slice(0, max).trimEnd()}…`
}

/**
 * Whether a session in `session` may take on `target`'s issues: the same
 * repository, or a fork of it (same name, another owner).
 */
export function isSameRepo(session: string | null, target: string): boolean {
  if (session === null) return false
  if (session.toLowerCase() === target.toLowerCase()) return true

  return (session.split('/')[1] ?? '').toLowerCase() === (target.split('/')[1] ?? '').toLowerCase()
}

/** The prompt "Work on it" submits. */
export function workPrompt(repo: string, issue: Pick<Issue, 'number' | 'title' | 'url'>): string {
  return [
    `Work on GitHub issue #${issue.number} in ${repo}: "${issue.title}"`,
    issue.url,
    '',
    `Read the issue and its comments first (\`gh issue view ${issue.number} -R ${repo} --comments\`), ` +
      'then outline your plan and implement it. ' +
      `Reference #${issue.number} in the commit message and in the pull request.`,
  ].join('\n')
}
