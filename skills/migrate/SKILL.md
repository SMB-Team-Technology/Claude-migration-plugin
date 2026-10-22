---
name: migrate
description: Export the user's Claude projects, chats, memories, skills, scheduled tasks and artifacts into one migration bundle for import into AI Workforce Pro. Use when the user wants to migrate, move, export or back up their Claude data to AI Workforce Pro (AIWP).
---

# Migrate Claude data to AI Workforce Pro

You produce one file, `aiwp-migration-bundle.json`, that the user uploads in AI Workforce Pro under **Settings → Data → Import from Claude**. The user decides what goes in it. Nothing is sent anywhere from here: you only write a local file.

The helper is `node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs"` (Node 20+, no installs). Work in a folder named `aiwp-migration` in the current directory; call it `$WORK`.

## 1. Find out what is available

Ask which of these the user wants to migrate (multi-select): **Projects, Chats, Memories, Skills, Scheduled tasks, Artifacts**. Ask whether they use web Claude, local desktop Cowork, or both. Cloud exports do not prove coverage of local Cowork data. Then collect sources for the ones they picked.

| Category | Where it comes from |
|---|---|
| Projects | Read `projects.json` from the actual export, or stage `$WORK/inputs/projects.json` from a verified source. Preserve stable IDs, names, instructions and text context. Do not guess local storage paths. Project files are not migrated in this version; report them and ask the user to add originals in AIWP. |
| Chats | **Try your own chat-history tools first** (for example tools that list recent chats or search/fetch past conversations). If you have them, gather the chats and write `$WORK/inputs/conversations.json` (below). If you have no such tool, or it cannot return full messages, use the data export instead. |
| Chats, Projects, Artifacts (export) | The claude.ai data export; see "Getting the export" below. It holds Chat-mode chats, project records and the list of published artifacts. It does **not** hold Cowork or Code chats, and it has no artifact content. |
| Chats (Cowork and Code sessions) | **Not in the claude.ai export**, which holds Chat-mode conversations only, even for chats inside a cloud project. Collect them as session transcripts; see "Cowork and Code sessions" below. |
| Skills | Read from `~/.claude/skills` automatically. Ask whether there are other skill folders; pass each with `--skills-dir`. |
| Memories | Only you can read these. Write them to `$WORK/inputs/memories.json` (below). |
| Scheduled tasks | Only you can read these. List them with whichever scheduled-task tool you have (for example a scheduled-tasks or cron list tool), then write `$WORK/inputs/scheduled-tasks.json`. |
| Extra artifacts | If you have a tool that lists the user's published artifacts, read their content and add them to `$WORK/inputs/artifacts.json`. Skip this if you have no such tool. |

### Getting the export

1. Ask the user to open claude.ai → **Settings → Privacy → Export data** and wait for it to finish. The browser downloads one small file, `member-manifest-….json`. This is an index of download links, not the data. If several are in Downloads, the newest is used. Suggest the user requests only one export.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs" download`. It finds the newest index in `~/Downloads`, opens each data file's link in the user's browser (which is already logged in), and waits until the files arrive. The user may see download prompts in the browser; ask them to allow them. Report the result in plain words, for example "✅ conversations, ✅ projects, ✅ frames". `light_metadata` holds account details and is skipped.
3. If the status is `expired` or `incomplete`, tell the user what its `next` text says. Links expire 24 hours after the export and may work only once, so a new export is usually the fix.
4. Pass the index file itself to scan/build as `--export "<manifest path from the result>"`. Never unzip, move or merge the archives.

Never print, paste or log the download links. The helper never outputs them either.

### Cowork and Code sessions

1. **List them.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs" sessions` (macOS). Do not read the desktop app's folders yourself. It returns:
   - `cowork`: Cowork sessions with `id`, linked `folders`, whether they are already `collected`, and a ready-to-paste `command`.
   - `code`: desktop Code sessions with `title` and `transcript` path.
   - `transcripts`: the folder where fetched Cowork transcripts are saved.
   It only lists Cowork chats that have a linked folder. Ask the user to compare with each project's "Chats and tasks" list in the desktop app and tell you about any that are missing.
2. **Desktop Code sessions:** ask whether to include them, with **"All (recommended)"** as the first option, then groups or individual sessions by title, then "None". Pass each chosen `transcript` with `--session`.
3. **Cowork sessions:** sessions with `"collected": true` are already fetched; pass their `transcript` with `--session`. For the rest (`pending`), `sessions` returns one `fetchAll` command that fetches all of them in one go. You cannot run it yourself: never run `fetchAll` or a session's `command`. Give the user `fetchAll` exactly as returned, in a plain `text` code block (not `bash`, so the desktop app shows no run ▶ button), with these steps:
   1. Copy the command. In the Claude desktop app, open a terminal with the **terminal icon** (not ▶). Elsewhere, open the **Terminal** app (Cmd+Space, type Terminal). Paste and press Return.
   2. Leave it running and don't type in that window. It shows one line per chat, for example `[3/120] session_… ✅`, and ends with `Finished: N of N fetched`. It takes about half a minute per chat, so tell the user roughly how long to expect.
   3. Tell Claude when it says Finished, or paste any ❌ lines.
   Then run `sessions` again. If some are still pending, give the same `fetchAll` again: it retries only those. After two failed attempts for a session, continue without it and report it as not collected. If `claude` is null or `fetchAll` is missing while chats are pending, Cowork chats cannot be fetched on this computer; say so and continue without them.
4. Write `$WORK/inputs/sessions.json` with one entry per expected session: `id` (`session_…` for Cowork, the Code `id`) and `title`. Cowork titles are not stored locally, so ask the user for the title shown in the desktop app, or leave `title` out to use the chat's first message. Pass each collected session's `transcript` with `--session`. Entries are matched by `id`, and entries that match no transcript are reported as not collected instead of disappearing.

Sessions attached to a project are linked to the exported project with the same name. If two projects share a name, set `projectId` in the entry. Tool calls and their results, images and hidden thinking are reported as not migrated. Files a session created (for example in its linked folder) are not included.

Staging files are plain JSON, written by you from real data. Never invent entries, and say plainly when a source is unavailable rather than guessing.

```jsonc
// projects.json: instructions and text context only; keep file limitations explicit
[{ "id": "<stable source project id>", "name": "Client", "instructions": "…", "context": "…" }]

// memories.json: one fact per entry, as the user would recognise it
["Prefers concise answers", "Practices family law in Texas"]

// scheduled-tasks.json: recurring tasks use "cron" (5-field), one-time tasks use "runAt" (ISO 8601)
[{ "id": "digest", "name": "Daily digest", "prompt": "Summarize my inbox", "cron": "0 8 * * 1-5", "timezone": "America/Chicago", "enabled": true }]

// artifacts.json
[{ "id": "intake-form", "title": "Intake form", "type": "text/html", "content": "<!doctype html>..." }]
```

```jsonc
// conversations.json: full messages in order, oldest first
[{ "id": "<chat id>", "projectId": "<stable source project id>", "title": "Lease review", "createdAt": "2026-01-02T10:00:00Z",
   "messages": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }] }]
```

Chats via tools: ask the user how many or which (for example the last 50, or a date range or topic), because fetching every chat one by one is slow. Save only message text that a tool actually returned. If a tool returns only snippets or summaries, do not stage them as if they were full chats: tell the user those chats are partial and recommend the export for them. Report how many chats you staged and how many you could not fetch in full.

Keep prompts, memories and chat text verbatim. Do not summarise away detail.

## 2. Show what was found

Run the scan with the flags for the sources you gathered:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs" scan \
  --export "<zip-or-folder>" --inputs "$WORK/inputs" [--session "<jsonl-or-folder>"]... [--skills-dir "<dir>"]...
```

It prints `categories` and a `coverage` report. Per category there is a count, the item titles, and a `warning` on any item that appears to contain a credential. Summarise the counts for the user in a short table. Do not print full item lists unless asked; offer to show a category.

## 3. Let the user choose

- Confirm the categories to include (use the answers from step 1, adjusted for what was actually found).
- Whenever you ask the user to choose items, make **"All (recommended)"** the first option, and pre-select the recommendation (for skills: their own and team skills, not Claude's built-ins). Then offer groups or individual items, then "None". For chats, offer "all", or exclusion by title or date.
- For every item with a `warning`, tell the user which item and why, and ask whether to leave it out. **Default to leaving it out.** Only pass `--allow-flagged` if the user explicitly says to include those items.

## 4. Build the bundle

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs" build --out "$WORK/aiwp-migration-bundle.json" \
  --categories conversations,skills --exclude "<id>,<id>" \
  --export "<zip-or-folder>" --inputs "$WORK/inputs" [--session "<jsonl-or-folder>"]... [--skills-dir "<dir>"]...
```

Categories: `projects`, `conversations`, `memories`, `skills`, `scheduledTasks`, `artifacts`. Then run `validate` on the output and report counts, coverage warnings and credential exclusions. Include the projects referenced by selected chats. Never say validation establishes completeness or a successful destination import. If any requested source is unavailable, label the result partial.

## 5. Hand off

Tell the user:

1. The full path of `aiwp-migration-bundle.json`.
2. In AI Workforce Pro open **Settings → Data → Import from Claude**, upload the file, review the preview, and choose what to import. Select linked projects with their chats. Use the updated AIWP importer that supports projects; older servers ignore project fields. Repeat imports skip unchanged sources, but do not update existing projects or chats. Review every skipped/failed/rejected reason.
3. What to expect: imported scheduled tasks arrive **paused** so nothing runs until they review it; skills are imported as their `SKILL.md` and supporting files are not carried over yet; connectors and integrations are not migrated and must be reconnected in AIWP.
4. The bundle holds their private data. Keep it somewhere safe and delete it, and the `inputs` folder, only after verifying expected projects, chats, instructions, context and artifacts in AIWP. Keep source exports until that verification is complete.

Never read the bundle back out loud or paste its contents into chat.
