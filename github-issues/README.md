# github-issues

A side pane in Claude Code that lists a repository's GitHub issues as cards.

<p>
  <img src="docs/issues.png" alt="The Issues pane: tabs, search, a label picker, and issue cards with labels, linked pull requests and actions" width="380">
  <img src="docs/picker.png" alt="The repository picker: a filter box and repositories grouped by owner, with open issue counts" width="380">
</p>

<sub>Screenshots show made-up repositories, people and issues.</sub>

**[Watch the demo on X](https://x.com/marcocarne_/status/2107456270873796697)**

- **Tabs:** Open, Assigned (with your count), Created, Closed
- **Search and labels:** a search box (Enter runs a GitHub search) and a label picker. **Clear** resets both.
- **Cards:** title, `#number` (opens the issue on GitHub), assignees, last update, comment count, linked pull request (open, draft, merged or closed), and labels as small pills in GitHub's colors
- **Details:** shows the issue's description inside its card
- **Work on it:** sends Claude a prompt to read the issue and its comments, plan, and implement it. Its card gets an accent border.
- **Assignment alerts:** a toast when an issue is newly assigned to you, and your count on the Assigned tab

The pane shows the 40 most recently updated issues that match. A spinner shows while it loads. The list refreshes when you open the pane, after each of Claude's turns, every two minutes, and when you press **Refresh**. If a repository's issues are too large to fit in the pane at once, the pane shows as many as fit and says how many more there are. Use search or a label to narrow the list. If you leave the pane open, it opens again in your next session.

## Usage

| Command | |
| --- | --- |
| `/issues` | Started in a folder whose repository is on GitHub: that repository's issues. Anywhere else: pick a repository, the 30 you pushed to most recently (yours, collaborations and your organizations'), each with its open issue count. **Switch repo** opens the picker from the issues |
| `/issues owner/name` | Show that repository's issues |
| `/issues .` | Show the session's repository (from the `origin` remote) |

In the picker, repositories are grouped by owner. Type in the filter box to narrow the list. Enter opens the first match, or any `owner/name` you type. **Switch repo** in the pane goes back to the picker. If the session isn't in a GitHub repository, the pane opens on the picker.

## Assignment alerts

While the pane is open, the mod checks every two minutes which open issues are assigned to you in the repository it's watching: the one you picked, or the session's own. With the pane closed it makes no requests. The first check of a repository is silent and only records the current issues. After that, each newly assigned issue raises a toast. The issue numbers already seen are kept in Claude Code's plugin store, so alerts carry over between sessions.

## Requirements

The [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`. The mod runs `gh api graphql` (issues, labels, assigned issues and repositories) and `gh issue view` on your machine. Nothing leaves your machine except those GitHub requests.

## Install

```
/plugin marketplace add MarcoCarnevali/claude-code-mods
/plugin install github-issues@marco-mods
/reload-plugins
```
