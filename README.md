# LedgerMem for Obsidian

Sync your Obsidian vault to [LedgerMem](https://proofly.dev) — durable, searchable memory for every note and wikilink.

## Features

- **Auto-sync on save** — every modified `.md` file is pushed to LedgerMem with full metadata.
- **Wikilink relations** — `[[wikilinks]]` are parsed and stored in `metadata.relations`.
- **Vault backfill** — one command walks every note in the vault and ingests them.
- **Interval mode** — periodic backfill on a configurable cadence.
- **Settings tab** — API key, workspace ID, and sync mode all configurable in Obsidian settings.

## Install

### Via BRAT (recommended for now)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Add this repo: `ledgermem/ledgermem-obsidian`.
3. Enable "LedgerMem" in Community Plugins.

### Manual

1. Download `main.js` and `manifest.json` from the latest release.
2. Drop them into `<vault>/.obsidian/plugins/ledgermem/`.
3. Enable the plugin under Settings → Community plugins.

## Configure

Open **Settings → LedgerMem** and fill in:

| Setting | Description |
| --- | --- |
| API key | Your LedgerMem API key (`lm_live_…`). |
| Workspace ID | The target workspace for memories. |
| Sync mode | `manual`, `on-save`, or `interval`. |
| Interval (min) | Backfill cadence when sync mode is `interval`. |

## Commands

- `LedgerMem: backfill vault` — walks every `.md` file and pushes it.
- `LedgerMem: sync current note` — pushes the active file.

## Develop

```bash
npm install
npm run build      # produces main.js
npm test           # vitest
```

## License

MIT
