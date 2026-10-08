export type Column = 'todo' | 'doing' | 'done'

/** Who put a card on the board: you, Claude's to-do list, an approved plan, or Claude through the board tool. */
export type CardSource = 'you' | 'todo' | 'plan' | 'claude'

export type Card = {
  id: string
  title: string
  /** More about it, when whoever added it said more; else empty. */
  note: string
  column: Column
  source: CardSource
  /** What ties a card to Claude's to-do list: the item's text (TodoWrite) or its task id (TaskCreate). */
  ref: string | null
  createdAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-board': {
      /** The session's cards, in the order they were added. */
      cards: Card[]
      /** The card whose details are open under the board. */
      selected: string | null
      /** The card being written: a new one (id null) or one being edited; null when the composer is closed. */
      composer: { id: string | null; title: string; note: string; hasNote: boolean } | null
      /** The card handed to Claude with Work on it, until Claude's turn on it ends. */
      working: string | null
    }
  }
}
