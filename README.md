# Claude Migration Plugin

A Claude plugin that exports your Claude data into one file you can import into **AI Workforce Pro** (AIWP). You choose what is included: projects, chats, memories, skills, scheduled tasks and artifacts.

Nothing is uploaded by the plugin. It writes a local `aiwp-migration-bundle.json`, which you then upload in AIWP under **Settings → Data → Import from Claude**, where you review and choose again before anything is imported.

## Install

```
/plugin marketplace add SMB-Team-Technology/Claude-migration-plugin
/plugin install claude-migration@smb-team-technology
```

## Use

Run `/migrate` (or ask Claude to "migrate my Claude data to AI Workforce Pro"). Claude will:

1. Ask what you want to migrate.
2. Collect it. Chats come from Claude's own chat-history tools when it has them, otherwise from the claude.ai data export (Settings → Privacy → Export data), which is also where artifacts are recovered from; skills are read from `~/.claude/skills`; memories and scheduled tasks are read by Claude itself and staged as JSON.
3. Show you what was found and flag anything that looks like it contains a credential, which is left out unless you say otherwise.
4. Write the bundle and tell you how to import it.

## What carries over

| Category | Notes |
|---|---|
| Projects | Names, instructions and text context from explicit export/staged records. Requires the updated AIWP importer. Original project files are not migrated. |
| Chats | Text and thinking. Attachments and images are not included. |
| Memories | Imported as separate facts. |
| Skills | `SKILL.md` plus text supporting files in the bundle. AIWP currently imports the `SKILL.md`. |
| Scheduled tasks | Arrive paused in AIWP; connectors they relied on must be reconnected. |
| Artifacts | Final version of each artifact in your chat export. |

## Coverage and local Cowork data

The cloud export does **not** establish coverage of desktop-local Cowork projects or sessions. This release does not auto-discover desktop storage. Stage verified local records using the shapes in [docs/bundle-format.md](docs/bundle-format.md), or report that source as unavailable. Never use snippets as full conversations.

Export indexes are not payloads. Download the actual archives. For separate archives, extract `projects.json`, `conversations.json` and `memories.json` into one source folder, avoiding overwrites, and pass that folder with `--export`. `scan` returns `categories` plus coverage warnings; `build` embeds those warnings for review in AIWP. A valid bundle is not proof of complete migration.

Keep originals until destination contents are verified. Existing projects/chats are not updated on retry; unrelated same-name projects are not merged. Add original files and reconnect integrations manually.

## Developing

Requires Node 20+ and has no dependencies.

```
npm test
node scripts/aiwp-migrate.mjs scan --export export.zip
node scripts/aiwp-migrate.mjs build --out bundle.json --categories conversations,skills --export export.zip
```

The bundle contract is in [docs/bundle-format.md](docs/bundle-format.md); the importer lives in AI Workforce Pro (`packages/api/src/migration`).
