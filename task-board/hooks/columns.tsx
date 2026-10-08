import type { ClientModule, ClientPointerEvent } from 'claude-code'

/** A card as the columns draw it: plain data, handed over by the board's render hook. */
export type ColumnCard = { id: string; title: string; column: number; tag: string; isDone: boolean; isOpen: boolean; isBusy: boolean }

export type ColumnsProps = { cards: ColumnCard[]; names: string[]; counts: number[]; dots: Array<string | null> }

/** What the module sends the board: a card dropped on another column, or a card clicked. */
export type ColumnsMessage = { type: 'move'; id: string; column: number } | { type: 'open'; id: string }

/**
 * A card being dragged: where the press was, where the pointer is now, and
 * where on the card it was grabbed, so the ghost stays under the pointer as it was picked up.
 */
type Drag = { id: string; from: number; x: number; y: number; moved: boolean; over: number; atX: number; atY: number; grabX: number; grabY: number }
type State = { drag: Drag | null }

const ACCENT = 'claude'
/** The dragged card's fill and text. */
const GHOST_FILL = '#ffffff'
const GHOST_INK = '#1f1f1f'
/** Lines a card's title may take before it is cut. */
const TITLE_LINES = 4

/** `text` broken into lines of at most `width` characters, at spaces where it can; cut with an ellipsis past `max`. */
export function wrap(text: string, width: number, max = TITLE_LINES): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > width) {
      if (line !== '') {
        lines.push(line)
        line = ''
      }
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (line === '') line = rest
    else if (line.length + 1 + rest.length <= width) line = `${line} ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  if (line !== '') lines.push(line)
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[max - 1] ?? ''
  kept[max - 1] = `${last.slice(0, Math.max(0, width - 1))}…`

  return kept
}

/** Where each card sits, in the region's cells: what the pointer is checked against. */
export type Layout = {
  columnWidth: number
  cards: Array<{ id: string; column: number; top: number; bottom: number; lines: string[] }>
}

/**
 * The columns' layout: three columns a cell apart, a header row, then each
 * column's cards one under another, each its border, its title's lines and
 * a footer row.
 */
export function layout(cards: readonly ColumnCard[], regionColumns: number): Layout {
  const columnWidth = Math.max(12, Math.floor((Math.max(regionColumns, 38) - 2) / 3))
  const inner = columnWidth - 4
  const tops = [1, 1, 1]
  const placed: Layout['cards'] = []
  for (const card of cards) {
    const lines = wrap(card.isDone ? `✓ ${card.title}` : card.title, inner)
    const top = tops[card.column] ?? 1
    const bottom = top + lines.length + 2 // the border's two rows and the footer, the title between
    placed.push({ id: card.id, column: card.column, top, bottom, lines })
    tops[card.column] = bottom + 2 // the blank row between cards
  }

  return { columnWidth, cards: placed }
}

/**
 * How many rows the columns take as laid out: the header row, then the
 * tallest column's cards, a blank row after each, or its one placeholder.
 */
export function columnsHeightFor(cards: readonly ColumnCard[], regionColumns: number): number {
  const at = layout(cards, regionColumns)
  const bottoms = [0, 1, 2].map(column => {
    const last = at.cards.filter(card => card.column === column).at(-1)
    return last === undefined ? 4 : last.bottom + 2
  })

  return Math.max(...bottoms)
}

/** The column under the pointer's column `x`. */
export function columnAt(x: number, columnWidth: number): number {
  return Math.max(0, Math.min(2, Math.floor(x / (columnWidth + 1))))
}

/** The card under the pointer, if any. */
export function cardAt(at: Layout, x: number, y: number): Layout['cards'][number] | undefined {
  const column = columnAt(x, at.columnWidth)

  return at.cards.find(card => card.column === column && y >= card.top && y <= card.bottom)
}

/**
 * The board's three columns as a `Client`: drawn here so the pointer can be
 * read against where each card sits. Press a card and drag it onto another
 * column to move it there; press and release without moving to open it.
 */
const Columns: ClientModule<ColumnsProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const drag = surface.state?.drag ?? null
  const at = layout(props.cards, surface.columns)

  surface.onPointer((event: ClientPointerEvent) => {
    const current = surface.state?.drag ?? null
    if (event.type === 'down' && event.button === 'left') {
      const card = cardAt(at, event.x, event.y)
      if (card !== undefined) {
        const left = card.column * (at.columnWidth + 1)
        surface.setState({
          drag: {
            id: card.id,
            from: card.column,
            x: event.x,
            y: event.y,
            moved: false,
            over: card.column,
            atX: event.x,
            atY: event.y,
            grabX: event.x - left,
            grabY: event.y - card.top,
          },
        })
      }
      return
    }
    if (current === null) return
    if (event.type === 'move') {
      const moved = current.moved || Math.abs(event.x - current.x) + Math.abs(event.y - current.y) >= 2
      const over = columnAt(event.x, at.columnWidth)
      // Every move redraws while dragging: the ghost follows the pointer.
      if (moved || moved !== current.moved) surface.setState({ drag: { ...current, moved, over, atX: event.x, atY: event.y } })
      return
    }
    if (event.type === 'up') {
      if (!current.moved) surface.post({ type: 'open', id: current.id })
      else if (current.over !== current.from) surface.post({ type: 'move', id: current.id, column: current.over })
      surface.setState({ drag: null })
      return
    }
    if (event.type === 'leave' && current.moved) {
      // Released outside the region: the card stays where it was.
      surface.setState({ drag: null })
    }
  })

  const isDragging = drag !== null && drag.moved
  const carried = isDragging ? at.cards.find(card => card.id === drag.id) : undefined
  const carriedCard = carried === undefined ? undefined : props.cards.find(card => card.id === carried.id)
  return (
    <Box flexDirection="row" columnGap={1}>
      {isDragging && carried !== undefined && carriedCard !== undefined && (
        // The ghost: the card under the pointer, held where it was grabbed. A white card with dark
        // text in either theme: a mod's colors are fixed, so the text's is set as well as the fill.
        <Box
          key="ghost"
          position="absolute"
          // Kept inside the region, which clips what it draws: at its bottom edge, not cut.
          top={Math.max(0, Math.min(drag.atY - drag.grabY, surface.rows - carried.lines.length - 3))}
          left={Math.max(0, drag.atX - drag.grabX)}
          width={at.columnWidth}
          flexDirection="column"
          borderStyle="bold"
          borderColor={ACCENT}
          backgroundColor={GHOST_FILL}
          paddingX={1}
        >
          {carried.lines.map(line => (
            <Text bold color={GHOST_INK} wrap="truncate-end">
              {line}
            </Text>
          ))}
          <Text color={ACCENT} wrap="truncate-end">
            {carriedCard.tag === '' ? ' ' : carriedCard.tag}
          </Text>
        </Box>
      )}
      {[0, 1, 2].map(column => {
        const isTarget = isDragging && drag.over === column && drag.from !== column
        const dot = props.dots[column] ?? null
        return (
          <Box key={`column:${column}`} flexDirection="column" width={at.columnWidth}>
            <Box flexDirection="row" columnGap={1}>
              <Text {...(dot === null ? { dimColor: true } : { color: dot })}>●</Text>
              <Text bold {...(isTarget ? { color: ACCENT } : {})}>
                {props.names[column] ?? ''}
              </Text>
              <Text dimColor>{String(props.counts[column] ?? 0)}</Text>
            </Box>
            {at.cards
              .filter(placed => placed.column === column)
              .map(placed => {
                const card = props.cards.find(one => one.id === placed.id)
                if (card === undefined) return null
                // The card picked up stays in place, dimmed; its ghost is what moves.
                const isCarried = isDragging && drag.id === card.id
                const isLit = !isCarried && (card.isOpen || card.isBusy)
                return (
                  <Box
                    key={`card:${card.id}`}
                    flexDirection="column"
                    borderStyle="round"
                    {...(isLit ? { borderColor: ACCENT } : { borderDimColor: true })}
                    paddingX={1}
                    marginBottom={1}
                  >
                    {placed.lines.map(line => (
                      <Text wrap="truncate-end" dimColor={card.isDone || isCarried}>
                        {line}
                      </Text>
                    ))}
                    <Text dimColor wrap="truncate-end">
                      {card.tag === '' ? ' ' : card.tag}
                    </Text>
                  </Box>
                )
              })}
            {isTarget && (
              <Box borderStyle="round" borderColor={ACCENT} paddingX={1}>
                <Text color={ACCENT}>Drop here</Text>
              </Box>
            )}
            {(props.counts[column] ?? 0) === 0 && !isTarget && (
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text dimColor>No cards</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Columns
