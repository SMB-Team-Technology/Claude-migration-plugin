# Migration bundle format (v1)

A bundle is one UTF-8 JSON file. The plugin writes it; AI Workforce Pro validates and imports it. The importer is the authority on limits and may skip or trim items it cannot accept, and reports each one to the user.

Every category is optional and omitted when empty. Every item has an `id` that is unique within its category; the importer uses it for selection, so keep it stable.

```jsonc
{
  "format": "claude-migration-bundle",
  "version": 1,
  "createdAt": "2026-10-19T12:00:00.000Z",
  "generator": { "name": "claude-migration-plugin", "version": "0.1.0" },

  "conversations": [{
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
