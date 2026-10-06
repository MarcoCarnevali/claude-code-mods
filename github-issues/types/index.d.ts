export type IssueFilter = 'open' | 'assigned' | 'created' | 'closed'

export type IssueLabel = { name: string; color: string }

export type LinkedPr = {
  number: number
  url: string
  state: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED'
}

export type Issue = {
  number: number
  title: string
  url: string
  state: string
  labels: IssueLabel[]
  assignees: string[]
  author: string
  updatedAt: string
  comments: number
  pr: LinkedPr | null
}

export type IssueDetail = {
  number: number
  body: string
  comments: number
}

export type IssueLoad =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export type IssueView = 'issues' | 'repos'

export type RepoChoice = {
  name: string
  isPrivate: boolean
  openIssues: number
  pushedAt: string
}

/** What narrows the list: the tab, the search typed, the label picked. */
export type IssueScope = { filter: IssueFilter; search: string; label: string }

/**
 * Everything the issue list draws, as one value: a change of tab and its
 * results are one write each, so one redraw each.
 */
export type IssuesPane = {
  repo: string | null
  scope: IssueScope
  load: IssueLoad
  issues: Issue[]
  total: number
  labels: IssueLabel[]
  assigned: number
}

/** Everything the repository picker draws, as one value. */
export type RepoPicker = {
  load: IssueLoad
  repos: RepoChoice[]
  here: string | null
}

/** The issue handed to Claude: queued until Claude's turn on it starts, then working. */
export type ActiveIssue = { number: number; state: 'queued' | 'working' }

/** The issue whose details are open, and its details once loaded. */
export type OpenIssue = { number: number; detail: IssueDetail | null }

declare module 'claude-code' {
  interface PluginState {
    'github-issues': {
      view: IssueView
      query: string
      picker: RepoPicker
      pinned: string | null
      page: IssuesPane
      searchDraft: string
      open: OpenIssue | null
      active: ActiveIssue | null
    }
  }
}
