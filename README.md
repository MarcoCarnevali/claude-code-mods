# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins of function hooks that add panes, bands, status lines and behaviour to Claude Code, in the terminal and in the desktop app.

## Install

Add this repository as a marketplace, once:

```
/plugin marketplace add MarcoCarnevali/claude-code-mods
```

Then install any mod from the list below by its name, and reload:

```
/plugin install <mod>@marco-mods
/reload-plugins
```

To get new mods and updates later:

```
/plugin marketplace update marco-mods
```

A mod is code that runs inside Claude Code on your machine, with the same access Claude Code has. Read a mod's source before you install it.

## Mods

| Mod | What it does |
| --- | --- |
| [github-issues](#github-issues) | A side pane listing a repository's GitHub issues. Filter and search them, read one, and press **Work on it** to hand it to Claude. |

### github-issues

<img src="github-issues/docs/issues.png" alt="The github-issues pane in Claude Code" width="380">

A side pane listing a repository's GitHub issues as cards, with tabs, search, a label filter and linked pull requests. `/issues` opens it with a picker of your repositories. **Work on it** sends Claude a prompt to take on an issue. Needs the [GitHub CLI](https://cli.github.com), signed in.

```
/plugin install github-issues@marco-mods
```

[Read more](./github-issues/README.md)

## Developing

Each mod is a folder at the root of this repository:

```
<mod>/
├── .claude-plugin/plugin.json   manifest
├── hooks/hooks.json             { "modules": ["./register.tsx"] }
├── hooks/register.tsx           the hooks module: export const register: Register = on => { ... }
├── types/index.d.ts             the $.state values the mod keeps
├── tests/*.test.ts              run by `claude plugin test`
└── README.md
```

Check and test a mod:

```bash
claude plugin validate ./<mod>
claude plugin test ./<mod>
```

Run Claude Code with a mod loaded from this folder. It reloads whenever you save:

```bash
claude --plugin-dir ./<mod>
```

Claude Code writes the API's type declarations into `<mod>/.claude-plugin/types/` when it loads a mod from disk. That folder is ignored by git. After a load, the mod's `tsconfig.json` picks those declarations up, so your editor and `tsc -p <mod>` can type-check it.

### Adding a mod

1. Create its folder at the root, laid out as above.
2. Add an entry to [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json): its `name`, `source` (`./<mod>`), `description` and `version`.
3. Add it to the [Mods](#mods) table and give it a section of its own, with a screenshot and its install line.
4. Check the marketplace still validates: `claude plugin validate .`

## License

[MIT](./LICENSE)
