# task-board

A To do / Doing / Done board in a side pane, filled as Claude works, and by you.

- **Claude's to-do list:** the list Claude keeps while it works becomes cards, which move to Doing and Done as Claude goes. The first cards open the pane.
- **Approved plans:** when you approve a plan, its steps (its numbered items, else its bullets or step headings) go to To do.
- **A board tool for Claude:** in any chat, Claude can add, move and remove cards: ask it to "put that on the board", or let it note follow-ups it is not doing now.
- **Your own cards:** **+ New card** opens a composer on the title; Enter or **Add card** adds the card to To do. **+ Description** swaps the title field for a description field (the title stays above it, **‹ Title** goes back), whose Enter or **Add card** adds it too. ✕ cancels.
- **A card's details:** **Open** shows its full text, where it came from, and buttons to move it a column left or right, **Edit** (its title and description), **▶ Work on it** (hands it to Claude and moves it to Doing; Claude Code holds the prompt until Claude finishes what it is doing) and **Delete**.

- **Drag and drop:** in the desktop app and the terminal, press a card and drag it onto another column: a white copy of it follows the pointer, the card stays dimmed where it was, and the column under the pointer shows **Drop here**. A click (press and release without moving) opens the card. The columns fill the pane, so there is room to drag below the cards. In VS Code and the mobile app, which cannot draw this, each card has **Open** and **›** (move it a column on) instead.

✦ marks Claude's cards, ◆ a plan's, ≡ one with a description. `/board` opens the pane at any time. The board belongs to the session: a new session starts with an empty one. Done shows its latest five cards; a board keeps at most 80, dropping the oldest done ones first.

Claude's to-do list is the truth for its own cards: when Claude updates the list, its cards follow, even ones you moved. Cards you or the board tool added are yours to move.

## Install

```
/plugin marketplace add MarcoCarnevali/claude-code-mods
/plugin install task-board@marco-mods
/reload-plugins
```
