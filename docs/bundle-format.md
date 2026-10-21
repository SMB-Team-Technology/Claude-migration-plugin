# Migration bundle format (v1)

A bundle is one UTF-8 JSON file. The plugin writes it; AI Workforce Pro validates and imports it. The importer is the authority on limits and may skip or trim items it cannot accept, and reports each one to the user.

Every category is optional and omitted when empty. Every item has an `id` that is unique within its category; the importer uses it for selection, so keep it stable.

```jsonc
{
  "format": "claude-migration-bundle",
  "version": 1,
  "createdAt": "2026-10-19T12:00:00.000Z",
  "generator": { "name": "claude-migration-plugin", "version": "0.2.0" },

  "migrationWarnings": ["Local Cowork coverage must be verified separately"],
  "projects": [{ "id": "project-uuid", "name": "Client", "instructions": "…", "context": "…" }],
  "conversations": [{
    "projectId": "project-uuid", // optional; select the project with its chats
    "id": "uuid", "title": "Lease review",
    "createdAt": "ISO-8601", "updatedAt": "ISO-8601",
    "messages": [{ "role": "user | assistant", "text": "…", "thinking": "assistant only", "createdAt": "ISO-8601" }]
  }],

  "memories": [{ "id": "memory-1", "value": "Prefers concise answers", "key": "optional topic" }],

  "skills": [{
    "id": "brief-writer", "name": "brief-writer", "description": "…",
    "content": "full SKILL.md including frontmatter",
    "files": [{ "path": "references/style.md", "content": "text files only" }]
  }],

  "scheduledTasks": [{
    "id": "digest", "name": "Daily digest", "prompt": "…",
    "scheduleType": "recurring | once", "cron": "0 8 * * 1-5 (recurring)", "runAt": "ISO-8601 (once)",
    "timezone": "America/Chicago", "enabled": true
  }],

  "artifacts": [{
    "id": "conversation-uuid:artifact-id", "title": "Lease summary",
    "type": "text/html | text/markdown | application/vnd.ant.react | …", "language": "optional",
    "content": "…", "conversationId": "optional"
  }]
}
```

## Rules

- Roles are `user` or `assistant`; messages without text and thinking are dropped by the plugin.
- Artifacts are the final version after replaying create, update and rewrite edits.
- Items that appear to contain credentials are left out by the plugin unless the user opts in.
- Compatibility: new optional fields may be added within v1. A breaking change bumps `version`, and the importer rejects versions it does not know.

## Staging files (plugin input, not part of the bundle)

Claude can stage `projects.json`, `conversations.json`, `memories.json`, `scheduled-tasks.json` and `artifacts.json` in the inputs folder for data only it can reach. `conversations.json` takes the bundle's conversation shape (`role` may also be `human`). A staged chat or project replaces an export record with the same id. Projects require stable `id`, `name`, `instructions` and `context` text (the latter two default to empty). `projectId` references the source project ID, not a destination database ID.

## Project compatibility and limitations

Projects are an optional v1 extension and require an updated AIWP server. Older importers ignore them, so upgrade AIWP before using project bundles. Import projects before chats and select both. Missing, unselected, conflicting or failed projects cause their linked chats to be skipped with a reason, rather than imported without their project. Existing source projects are recognized by a user-scoped migration identity; same-name unrelated projects are not merged or overwritten.

Project names are limited to 128 characters; instructions and context to 100,000 characters each. Project files, attachments and connectors are **not** migrated; do not turn binary files into invented text context. `migrationWarnings` carries coverage limitations through preview and import results. Source adapters recognize explicit project `id`/`uuid`, `name`, `instructions`/`prompt_template`, and optional text `context`; other layouts require verified staging rather than guessing.

The helper rejects indexes and empty/mismatched payloads. A successful build reports collected counts, not source-account completeness or destination verification.
