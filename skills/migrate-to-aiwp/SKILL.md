---
name: migrate-to-aiwp
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
| Chats, Artifacts (export) | The claude.ai data export. Ask for the path to the `.zip` (or extracted folder). If they do not have one: claude.ai → Settings → Privacy → **Export data**; the download link is emailed and may take a while. Artifacts are rebuilt from the chats in that export. Offer the export when the tool route is partial, but do not claim it includes desktop-local Cowork projects or sessions. An emailed index is not the payload; obtain the separate actual archives. The helper accepts one export path; for separate archives extract their payload JSON files into a common source folder without overwriting duplicates, then pass that folder. |
| Skills | Read from `~/.claude/skills` automatically. Ask whether there are other skill folders; pass each with `--skills-dir`. |
| Memories | Only you can read these. Write them to `$WORK/inputs/memories.json` (below). |
| Scheduled tasks | Only you can read these. List them with whichever scheduled-task tool you have (for example a scheduled-tasks or cron list tool), then write `$WORK/inputs/scheduled-tasks.json`. |
| Extra artifacts | If you have a tool that lists the user's published artifacts, read their content and add them to `$WORK/inputs/artifacts.json`. Skip this if you have no such tool. |

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
  --export "<zip-or-folder>" --inputs "$WORK/inputs" [--skills-dir "<dir>"]...
```

It prints `categories` and a `coverage` report. Per category there is a count, the item titles, and a `warning` on any item that appears to contain a credential. Summarise the counts for the user in a short table. Do not print full item lists unless asked; offer to show a category.

## 3. Let the user choose

- Confirm the categories to include (use the answers from step 1, adjusted for what was actually found).
- Offer per-item choices for categories with few items (skills, scheduled tasks, artifacts, memories). For chats offer "all", or exclusion by title or date.
- For every item with a `warning`, tell the user which item and why, and ask whether to leave it out. **Default to leaving it out.** Only pass `--allow-flagged` if the user explicitly says to include those items.

## 4. Build the bundle

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/aiwp-migrate.mjs" build --out "$WORK/aiwp-migration-bundle.json" \
  --categories conversations,skills --exclude "<id>,<id>" \
  --export "<zip-or-folder>" --inputs "$WORK/inputs" [--skills-dir "<dir>"]...
```

Categories: `projects`, `conversations`, `memories`, `skills`, `scheduledTasks`, `artifacts`. Then run `validate` on the output and report counts, coverage warnings and credential exclusions. Include the projects referenced by selected chats. Never say validation establishes completeness or a successful destination import. If any requested source is unavailable, label the result partial.

## 5. Hand off

Tell the user:

1. The full path of `aiwp-migration-bundle.json`.
2. In AI Workforce Pro open **Settings → Data → Import from Claude**, upload the file, review the preview, and choose what to import. Select linked projects with their chats. Use the updated AIWP importer that supports projects; older servers ignore project fields. Repeat imports skip unchanged sources, but do not update existing projects or chats. Review every skipped/failed/rejected reason.
3. What to expect: imported scheduled tasks arrive **paused** so nothing runs until they review it; skills are imported as their `SKILL.md` and supporting files are not carried over yet; connectors and integrations are not migrated and must be reconnected in AIWP.
4. The bundle holds their private data. Keep it somewhere safe and delete it, and the `inputs` folder, only after verifying expected projects, chats, instructions, context and artifacts in AIWP. Keep source exports until that verification is complete.

Never read the bundle back out loud or paste its contents into chat.
