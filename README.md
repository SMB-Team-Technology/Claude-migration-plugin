# Claude Migration Plugin

A Claude plugin that exports your Claude data into one file you can import into **AI Workforce Pro** (AIWP). You choose what is included: chats, memories, skills, scheduled tasks and artifacts.

Nothing is uploaded by the plugin. It writes a local `aiwp-migration-bundle.json`, which you then upload in AIWP under **Settings → Data → Import from Claude**, where you review and choose again before anything is imported.

## Install

```
/plugin marketplace add SMB-Team-Technology/Claude-migration-plugin
/plugin install claude-migration@smb-team-technology
```

## Use

Run `/migrate` (or ask Claude to "migrate my Claude data to AI Workforce Pro"). Claude will:

1. Ask what you want to migrate.
2. Collect it. Chats and artifacts come from the claude.ai data export (Settings → Privacy → Export data); skills are read from `~/.claude/skills`; memories and scheduled tasks are read by Claude itself and staged as JSON.
3. Show you what was found and flag anything that looks like it contains a credential, which is left out unless you say otherwise.
4. Write the bundle and tell you how to import it.

## What carries over

| Category | Notes |
|---|---|
| Chats | Text and thinking. Attachments and images are not included. |
| Memories | Imported as separate facts. |
| Skills | `SKILL.md` plus text supporting files in the bundle. AIWP currently imports the `SKILL.md`. |
| Scheduled tasks | Arrive paused in AIWP; connectors they relied on must be reconnected. |
| Artifacts | Final version of each artifact in your chat export. |

## Developing

Requires Node 20+ and has no dependencies.

```
npm test
node scripts/aiwp-migrate.mjs scan --export export.zip
node scripts/aiwp-migrate.mjs build --out bundle.json --categories conversations,skills --export export.zip
```

The bundle contract is in [docs/bundle-format.md](docs/bundle-format.md); the importer lives in AI Workforce Pro (`packages/api/src/migration`).
