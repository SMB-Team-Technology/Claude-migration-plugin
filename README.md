# Claude Migration Plugin

A Claude plugin that exports your Claude data into one file you can import into **AI Workforce Pro** (AIWP). You choose what is included: projects, chats, memories, skills, scheduled tasks and artifacts.

Nothing is uploaded by the plugin. It writes a local `aiwp-migration-bundle.json`, which you then upload in AIWP under **Settings → Data → Import from Claude**, where you review and choose again before anything is imported.

## Install

**In the Claude desktop app** (the usual way):

1. Open **Customize → Plugins**, add the **Claude migration** plugin (upload the `.zip`, or pick it from your organization's plugins) and turn it **on**. Check that it shows the latest version.
2. **Quit Claude completely (Cmd+Q on Mac) and open it again.** The new version is only picked up after a restart.
3. Start a **new** session in the **Code** tab. Sessions that were already open keep the old plugin list.

**In Claude Code (terminal):**

```
/plugin marketplace add SMB-Team-Technology/Claude-migration-plugin
/plugin install claude-migration@smb-team-technology
```

Then start a new session.

If Claude says `/claude-migration:migrate` "isn't installed", repeat steps 2 and 3.

## Use

In a new Code-tab session, type `/claude-migration:migrate` (or ask Claude to "migrate my Claude data to AI Workforce Pro"). Claude will:

1. Ask what you want to migrate.
2. Get your claude.ai export. You click **Settings → Privacy → Export data** in claude.ai; Claude then downloads the files it needs through your browser.
3. Collect your Cowork and Code chats, skills, memories, scheduled tasks and artifacts.
4. Show you what was found and what is missing. Anything that looks like a password or key is left out unless you say otherwise.
5. Save `aiwp-migration-bundle.json` and tell you how to import it.

## What carries over

| Category | Notes |
|---|---|
| Projects | Names, descriptions, instructions and text context from explicit export/staged records. Requires the updated AIWP importer. Original project files are not migrated. |
| Chats | Text and thinking. Attachments and images are not included. |
| Memories | Imported as separate facts. |
| Skills | `SKILL.md` plus text supporting files in the bundle. AIWP currently imports the `SKILL.md`. |
| Scheduled tasks | Arrive paused in AIWP; connectors they relied on must be reconnected. |
| Artifacts | Final version of each artifact in your chat export. |

## Coverage and local Cowork data

The claude.ai export contains **Chat-mode conversations only**. Chats run in Cowork mode (even inside a cloud project) and desktop Code sessions are not in it. Collect them as session transcripts (`.jsonl`) and pass them with `--session` or list them in `inputs/sessions.json`:

- **Desktop Code sessions**: `~/.claude/projects/<folder>/<session-id>.jsonl` already holds the full transcript.
- **Cowork sessions**: the user runs `claude --teleport <session_…>` from an empty folder, types `/export <name>.txt` and then `/exit` (no message is sent). The full transcript is then saved under `~/.claude/projects/<that folder>/`. The `.txt` export itself is lossy and is not used.

Transcripts keep user and assistant text, questions Claude asked and the answers, messages typed while Claude was working, and visible thinking. Tool calls and their results, images, hidden thinking and subagent transcripts are reported as not migrated. A session attached to a project is linked to the exported project with the same, unique name. Repeated teleports of one session are deduplicated by its `session_…` ID. Never use snippets as full conversations.

claude.ai's **Export data** downloads an index (`member-manifest-….json`), not the data. `aiwp-migrate.mjs download` opens each listed archive's link in the logged-in browser, waits for the files in `~/Downloads`, and never outputs the links. Pass the index with `--export`, and every listed archive is read (`light_metadata` is skipped). The `frames` archive lists published artifacts: titles, kind (`page` = Docs) and version counts, but no content. `scan` uses it to report which published artifacts were not collected. Links expire after 24 hours and may be single-use; an archive older than its index is never used. `scan` returns `categories` plus coverage warnings; `build` embeds those warnings for review in AIWP. A valid bundle is not proof of complete migration.

Keep originals until destination contents are verified. Existing projects/chats are not updated on retry; unrelated same-name projects are not merged. Add original files and reconnect integrations manually.

## Developing

Requires Node 20+ and has no dependencies.

```
npm test
node scripts/aiwp-migrate.mjs download
node scripts/aiwp-migrate.mjs scan --export ~/Downloads/member-manifest-….json
node scripts/aiwp-migrate.mjs build --out bundle.json --categories conversations,skills --export export.zip
```

The bundle contract is in [docs/bundle-format.md](docs/bundle-format.md); the importer lives in AI Workforce Pro (`packages/api/src/migration`).

### Desktop sessions and a single entry point (0.5.0)

`sessions` lists Cowork sessions with paste-ready teleport commands that use the desktop app's bundled `claude`, plus desktop Code sessions. The plugin now has one entry point, `/claude-migration:migrate` (a skill); the separate command was removed.

### Export index download (0.4.0)

`download` fetches an export's archives through the user's browser. `--export` accepts the index, and published artifacts missing from the bundle are reported from `frames`.

### Session transcripts (0.3.0)

Cowork and desktop Code session transcripts are read with `--session <file|folder>` or `inputs/sessions.json`. Rows a teleport appends locally (`/export`, shell commands) are dropped. Staged `sessions.json` entries without a transcript are reported as expected but not collected.

### Export fidelity fixes (0.2.1)

Individual Claude project JSON records (including UUID-named files inside folders/archives) are recognized by their project shape. Account metadata in `users.json` is not imported. Project descriptions are preserved separately from instructions. Duplicate project records are rejected rather than silently merged.

`step_card_display_v0` cards become numbered Markdown steps in their original message position. Tool-result copies are not duplicated. Hidden thinking summaries are not treated as full thinking; omitted tool payloads, citations and unsupported structured blocks produce coverage warnings. Text-only fallback messages are kept verbatim.
