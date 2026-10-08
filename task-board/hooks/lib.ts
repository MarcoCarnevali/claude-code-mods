import type { Card, CardSource, Column } from '../types'

export const COLUMNS: readonly Column[] = ['todo', 'doing', 'done']

export const COLUMN_NAME: Record<Column, string> = { todo: 'To do', doing: 'Doing', done: 'Done' }

/** How many Done cards the column shows; the rest are counted. */
export const DONE_SHOWN = 5

/** The most cards a board keeps: the oldest Done ones go first. */
export const CARD_LIMIT = 80

const SOURCE_NAME: Record<CardSource, string> = {
  you: 'Added by you',
  todo: "From Claude's to-do list",
  plan: 'From the approved plan',
  claude: 'Added by Claude',
}

export function sourceName(source: CardSource): string {
  return SOURCE_NAME[source]
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A card's title as it is kept: one line, trimmed, at most 160 characters. */
export function cleanTitle(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), 160)
}

/** A new card's id, unique within the board. */
export function newId(cards: readonly Card[], at: number): string {
  let n = cards.length
  let id = `c${at.toString(36)}${n.toString(36)}`
  while (cards.some(card => card.id === id)) {
    n += 1
    id = `c${at.toString(36)}${n.toString(36)}`
  }

  return id
}

/** The board with a card added at the end of `column`, and the card; a card already there by that title is kept as is. */
export function addCard(
  cards: readonly Card[],
  fields: { title: string; note?: string; column?: Column; source: CardSource; ref?: string | null },
  at: number,
): { cards: Card[]; card: Card } {
  const title = cleanTitle(fields.title)
  const same = cards.find(card => card.title.toLowerCase() === title.toLowerCase() && card.column !== 'done')
  if (same !== undefined) return { cards: [...cards], card: same }
  const card: Card = {
    id: newId(cards, at),
    title,
    note: clip((fields.note ?? '').trim(), 1_000),
    column: fields.column ?? 'todo',
    source: fields.source,
    ref: fields.ref ?? null,
    createdAt: at,
  }

  return { cards: trim([...cards, card]), card }
}

/** At most `CARD_LIMIT` cards: the oldest Done ones go first. */
function trim(cards: Card[]): Card[] {
  const out = [...cards]
  while (out.length > CARD_LIMIT) {
    const at = out.findIndex(card => card.column === 'done')
    out.splice(at === -1 ? 0 : at, 1)
  }

  return out
}

/** The board with card `id` in `column`, moved to the end of it. */
export function moveCard(cards: readonly Card[], id: string, column: Column): Card[] {
  const card = cards.find(one => one.id === id)
  if (card === undefined || card.column === column) return [...cards]

  return [...cards.filter(one => one.id !== id), { ...card, column }]
}

/** The board with card `id` retitled and its description replaced. */
export function editCard(cards: readonly Card[], id: string, fields: { title: string; note: string }): Card[] {
  return cards.map(card => (card.id === id ? { ...card, title: cleanTitle(fields.title), note: clip(fields.note.trim(), 1_000) } : card))
}

export function removeCard(cards: readonly Card[], id: string): Card[] {
  return cards.filter(card => card.id !== id)
}

/** The column left or right of `column`, if any. */
export function neighbour(column: Column, step: -1 | 1): Column | null {
  return COLUMNS[COLUMNS.indexOf(column) + step] ?? null
}

const STATUS_COLUMN: Record<string, Column> = { pending: 'todo', in_progress: 'doing', completed: 'done' }

/**
 * The board after Claude wrote its to-do list (TodoWrite): each item a card
 * in the column its status says, matched to the card it made before by its
 * text; the cards of items it dropped go. Claude's list is the truth for its
 * own cards.
 */
export function syncTodos(
  cards: readonly Card[],
  todos: ReadonlyArray<{ content: string; status: string }>,
  at: number,
): Card[] {
  const kept = new Set(todos.map(todo => cleanTitle(todo.content)))
  let out = cards.filter(card => card.source !== 'todo' || card.ref === null || kept.has(card.ref) || card.ref.startsWith('task:'))
  for (const todo of todos) {
    const title = cleanTitle(todo.content)
    const column = STATUS_COLUMN[todo.status] ?? 'todo'
    const mine = out.find(card => card.source === 'todo' && card.ref === title)
    if (mine === undefined) {
      out = addCard(out, { title, column, source: 'todo', ref: title }, at).cards
    } else if (mine.column !== column) {
      out = moveCard(out, mine.id, column)
    }
  }

  return out
}

/** The board after Claude created a task in its to-do list (TaskCreate). */
export function taskCreated(cards: readonly Card[], task: { id: string; subject: string; description?: string }, at: number): Card[] {
  return addCard(cards, { title: task.subject, note: task.description ?? '', source: 'todo', ref: `task:${task.id}` }, at).cards
}

/** The board after Claude updated a task in its to-do list (TaskUpdate): its status, title or note; deleted, it goes. */
export function taskUpdated(
  cards: readonly Card[],
  update: { taskId: string; status?: string; subject?: string; description?: string },
): Card[] {
  const card = cards.find(one => one.ref === `task:${update.taskId}`)
  if (card === undefined) return [...cards]
  if (update.status === 'deleted') return removeCard(cards, card.id)
  const changed: Card = {
    ...card,
    ...(update.subject === undefined ? {} : { title: cleanTitle(update.subject) }),
    ...(update.description === undefined ? {} : { note: clip(update.description.trim(), 1_000) }),
  }
  const column = update.status === undefined ? card.column : (STATUS_COLUMN[update.status] ?? card.column)
  const replaced = cards.map(one => (one.id === card.id ? changed : one))

  return column === card.column ? replaced : moveCard(replaced, card.id, column)
}

/** Markdown as plain text: emphasis, code marks and links reduced to their words. */
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[:：]\s*$/, '')
    .trim()
}

// Headings that frame a plan rather than name a step in it.
const FRAMING = /^(context|overview|summary|background|goal|goals|plan|approach|verification|testing|test plan|risks|notes|open questions|files|critical files)\b/i

/**
 * The steps of an approved plan, as cards: its numbered items, else its
 * top-level bullets, else its section headings (not the ones that frame it,
 * such as Context or Verification). At most 20.
 */
export function planSteps(plan: string): string[] {
  const lines = plan.split('\n')
  const pick = (pattern: RegExp) =>
    lines
      .map(line => line.match(pattern)?.[1])
      .filter((step): step is string => step !== undefined)
      .map(plainText)
      .filter(step => step !== '')
  const numbered = pick(/^ {0,3}\d+[.)]\s+(.+)$/)
  const bullets = pick(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/)
  const headings = pick(/^#{2,4}\s+(?:(?:step|phase)\s*\d+\s*[:.\-–]\s*)?(.+)$/i).filter(step => !FRAMING.test(step))
  const steps = numbered.length >= 2 ? numbered : bullets.length >= 2 ? bullets : headings

  return steps.slice(0, 20).map(cleanTitle)
}

/** What Work on it sends Claude. */
export function workPrompt(card: Card): string {
  return [`Work on this card from the task board: "${card.title}"`, ...(card.note === '' ? [] : ['', card.note])].join('\n')
}

/** The board as text, for the board tool's `list`: each column, each card with its id. */
export function boardText(cards: readonly Card[]): string {
  if (cards.length === 0) return 'The board is empty.'

  return COLUMNS.map(column => {
    const inColumn = cards.filter(card => card.column === column)
    return [`${COLUMN_NAME[column]} (${inColumn.length})`, ...inColumn.map(card => `- [${card.id}] ${card.title}`)].join('\n')
  }).join('\n\n')
}

/** What the board tool takes, as the model sends it: checked here, never trusted. */
export type BoardToolInput = { action?: unknown; title?: unknown; note?: unknown; card?: unknown; column?: unknown }

export const BOARD_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'add', 'move', 'remove'], description: 'What to do.' },
    title: { type: 'string', description: 'add: the card, a short imperative ("Add an offline banner").' },
    note: { type: 'string', description: 'add: optional detail: why, where, what done means.' },
    card: { type: 'string', description: 'move, remove: the card id from list, or its exact title.' },
    column: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'add (default todo), move: the column.' },
  },
  required: ['action'],
} as const

export const BOARD_TOOL_DESCRIPTION = [
  "The task board in the person's side pane: To do, Doing and Done columns of cards.",
  'Use it when the person asks to put something on the board, move a card or mark one done, and to note follow-up work you notice but are not doing now.',
  'Your own to-do list and approved plans already appear on the board by themselves: do not add their items again.',
  'Actions: list (the cards and their ids), add (title, optional note and column), move (card, column), remove (card).',
].join(' ')

const isColumn = (value: unknown): value is Column => value === 'todo' || value === 'doing' || value === 'done'

/** Finds a card by its id, else by its title (exact, ignoring case). */
function findCard(cards: readonly Card[], key: string): Card | undefined {
  const wanted = key.trim().toLowerCase()

  return cards.find(card => card.id === key.trim()) ?? cards.find(card => card.title.toLowerCase() === wanted)
}

/** Runs one board tool call: the board after it, and what the model reads back. */
export function runBoardTool(
  cards: readonly Card[],
  input: BoardToolInput,
  at: number,
): { cards: Card[]; text: string; isError?: true } {
  const fail = (text: string) => ({ cards: [...cards], text, isError: true as const })
  switch (input.action) {
    case 'list':
      return { cards: [...cards], text: boardText(cards) }
    case 'add': {
      if (typeof input.title !== 'string' || input.title.trim() === '') return fail('add needs a title.')
      if (input.column !== undefined && !isColumn(input.column)) return fail('column is todo, doing or done.')
      const before = cards.length
      const added = addCard(
        cards,
        { title: input.title, note: typeof input.note === 'string' ? input.note : '', column: input.column ?? 'todo', source: 'claude' },
        at,
      )
      return {
        cards: added.cards,
        text:
          added.cards.length === before
            ? `"${added.card.title}" is already on the board (${COLUMN_NAME[added.card.column]}, ${added.card.id}).`
            : `Added "${added.card.title}" to ${COLUMN_NAME[added.card.column]} (${added.card.id}).`,
      }
    }
    case 'move': {
      if (typeof input.card !== 'string') return fail('move needs a card: its id or title.')
      if (!isColumn(input.column)) return fail('move needs a column: todo, doing or done.')
      const card = findCard(cards, input.card)
      if (card === undefined) return fail(`No card "${input.card}". Use list to see the cards and their ids.`)
      return { cards: moveCard(cards, card.id, input.column), text: `Moved "${card.title}" to ${COLUMN_NAME[input.column]}.` }
    }
    case 'remove': {
      if (typeof input.card !== 'string') return fail('remove needs a card: its id or title.')
      const card = findCard(cards, input.card)
      if (card === undefined) return fail(`No card "${input.card}". Use list to see the cards and their ids.`)
      return { cards: removeCard(cards, card.id), text: `Removed "${card.title}".` }
    }
    default:
      return fail('action is list, add, move or remove.')
  }
}
