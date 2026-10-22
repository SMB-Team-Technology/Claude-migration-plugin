import { stat } from 'node:fs/promises';
import { findSecret } from './secrets.mjs';
import { readExport, toBundleConversation, extractArtifacts, extractMemories } from './sources/export.mjs';
import { scanSkills, defaultSkillDirs } from './sources/skills.mjs';
import { readStaged } from './sources/staged.mjs';
import { toProject } from './sources/projects.mjs';
import { readSessions, linkSessionProjects } from './sources/sessions.mjs';

export const BUNDLE_FORMAT = 'claude-migration-bundle';
export const BUNDLE_VERSION = 1;
export const GENERATOR = { name: 'claude-migration-plugin', version: '0.3.0' };

export const CATEGORIES = ['projects', 'conversations', 'memories', 'skills', 'scheduledTasks', 'artifacts'];

const itemText = {
  projects: (item) => `${item.description ?? ''}\n${item.instructions}\n${item.context}`,
  conversations: (item) => item.messages.map((message) => `${message.text}\n${message.thinking ?? ''}`).join('\n'),
  memories: (item) => item.value,
  skills: (item) => [item.content, ...item.files.map((file) => file.content)].join('\n'),
  scheduledTasks: (item) => item.prompt,
  artifacts: (item) => item.content,
};

const itemTitle = {
  projects: (item) => item.name,
  conversations: (item) => item.title,
  memories: (item) => item.value.slice(0, 120),
  skills: (item) => item.name,
  scheduledTasks: (item) => item.name,
  artifacts: (item) => item.title,
};

const itemDetail = {
  projects: (item) => item.migrationWarnings?.join(' ') ?? 'Instructions and text context only; verify files separately',
  conversations: (item) => `${item.messages.length} messages`,
  memories: () => '',
  skills: (item) => `${item.files.length} supporting file(s)`,
  scheduledTasks: (item) => item.cron ?? item.runAt ?? '',
  artifacts: (item) => item.type,
};

/** Staged items win over export items with the same id, so a chat is never listed twice. */
const mergeById = (preferred, others) => {
  const seen = new Set(preferred.map((item) => item.id));
  return [...preferred, ...others.filter((item) => !seen.has(item.id))];
};

const exists = (file) => stat(file).then(() => true, () => false);

/** Splits staged session entries into transcript paths (with their overrides) and entries that name no readable file. */
const stagedSessions = async (entries) => {
  const found = await Promise.all(entries.map((entry) => (entry.path ? exists(entry.path) : false)));
  return {
    paths: entries.filter((_, index) => found[index]).map((entry) => entry.path),
    overrides: new Map(entries.filter((_, index) => found[index]).map(({ path: file, ...rest }) => [file, rest])),
    unread: entries.filter((_, index) => !found[index]),
  };
};

/** Applies staged titles/projects to chats matched by id; entries matching nothing are reported as not collected. */
const reconcileSessions = (chats, unread) => {
  const byId = new Map(unread.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const matched = new Set();
  const updated = chats.map((chat) => {
    const entry = byId.get(chat.id);
    if (!entry) return chat;
    matched.add(entry);
    const { sourceProjectName, ...rest } = chat;
    return entry.projectId
      ? { ...rest, title: entry.title, projectId: entry.projectId }
      : { ...chat, title: entry.title };
  });
  const missing = unread
    .filter((entry) => !matched.has(entry))
    .map((entry) => `Expected session "${entry.title}"${entry.id && entry.id !== entry.title ? ` (${entry.id})` : ''} was not collected: ${entry.path ? 'transcript not found' : 'no transcript was staged'}.`);
  return { chats: updated, missing };
};

/** Reads every source the options point at and returns the full, unfiltered set per category. */
export const collect = async (options = {}) => {
  const exported = options.exportPath ? await readExport(options.exportPath) : {};
  const rawConversations = Array.isArray(exported.conversations) ? exported.conversations : [];
  const staged = await readStaged(options.inputsDir);
  const skillRoots = options.skillDirs?.length ? options.skillDirs : defaultSkillDirs();
  const sessionSources = await stagedSessions(staged.sessions);
  const read = await readSessions([...(options.sessionPaths ?? []), ...sessionSources.paths], sessionSources.overrides);
  const sessions = reconcileSessions(read, sessionSources.unread);

  const projects = mergeById(staged.projects, (exported.projects ?? []).map(toProject));
  const exportedMemories = extractMemories(exported.memories);
  const exportedArtifacts = extractArtifacts(rawConversations);
  return {
    projects,
    conversations: mergeById(
      mergeById(staged.conversations, linkSessionProjects(sessions.chats, projects)),
      rawConversations.map(toBundleConversation).filter((chat) => chat.messages.length > 0),
    ),
    memories: [...staged.memories, ...exportedMemories],
    skills: options.skipLocalSkills ? [] : await scanSkills(skillRoots),
    scheduledTasks: staged.scheduledTasks,
    artifacts: [...staged.artifacts, ...exportedArtifacts],
    sourceWarnings: sessions.missing,
  };
};

/** Lightweight listing for the picker: ids, titles and any credential warnings, no content. */
export const summarize = (collected) =>
  Object.fromEntries(
    CATEGORIES.map((category) => {
      const items = collected[category].map((item) => {
        const secret = findSecret(itemText[category](item));
        return {
          id: item.id,
          title: itemTitle[category](item),
          detail: itemDetail[category](item),
          ...(secret ? { warning: `Looks like it contains ${secret}` } : {}),
        };
      });
      return [category, { count: items.length, flagged: items.filter((item) => item.warning).length, items }];
    }),
  );

/**
 * Applies the user's selection. `categories` limits what is exported; `exclude`
 * drops individual ids. Items that look like they contain credentials are left
 * out unless `allowFlagged` is set.
 */
export const select = (collected, { categories = CATEGORIES, exclude = [], allowFlagged = false } = {}) => {
  const excluded = new Set(exclude);
  const skipped = [];
  const chosen = Object.fromEntries(
    CATEGORIES.map((category) => {
      if (!categories.includes(category)) {
        return [category, []];
      }
      const items = collected[category].filter((item) => {
        if (excluded.has(item.id)) {
          return false;
        }
        const secret = allowFlagged ? null : findSecret(itemText[category](item));
        if (secret) {
          skipped.push({ category, id: item.id, title: itemTitle[category](item), reason: secret });
        }
        return !secret;
      });
      return [category, items];
    }),
  );
  return { chosen, skipped };
};

export const makeBundle = (chosen, createdAt = new Date().toISOString()) => ({
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  createdAt,
  generator: GENERATOR,
  ...Object.fromEntries(CATEGORIES.filter((category) => chosen[category]?.length > 0).map((c) => [c, chosen[c]])),
});

/** Throws a readable error when `bundle` would not be accepted by the importer. */
export const validateBundle = (bundle) => {
  if (bundle?.format !== BUNDLE_FORMAT) {
    throw new Error(`Not a ${BUNDLE_FORMAT} file`);
  }
  if (bundle.version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported bundle version ${bundle.version}`);
  }
  const problems = CATEGORIES.flatMap((category) => {
    const items = bundle[category];
    if (items === undefined) {
      return [];
    }
    if (!Array.isArray(items)) {
      return [`${category} must be an array`];
    }
    const seen = new Set();
    return items.flatMap((item, index) => {
      const label = `${category}[${index}]`;
      if (typeof item?.id !== 'string' || !item.id) return [`${label} is missing an id`];
      if (item.id.length > 300) return [`${label} id exceeds 300 characters`];
      if (seen.has(item.id)) return [`${label} has a duplicate id`];
      seen.add(item.id);
      if (category === 'projects' && (!item.name?.trim() || typeof item.instructions !== 'string' || typeof item.context !== 'string')) {
        return [`${label} requires name, instructions and context text`];
      }
      if (category === 'projects') {
        if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 100_000)) return [`${label} description must be text of at most 100000 characters`];
        if (item.name.length > 128) return [`${label} name exceeds 128 characters`];
        if (item.instructions.length > 100_000) return [`${label} instructions exceed 100000 characters`];
        if (item.context.length > 100_000) return [`${label} context exceeds 100000 characters`];
      }
      if (category === 'conversations' && item.projectId !== undefined && (typeof item.projectId !== 'string' || !item.projectId || item.projectId.length > 300)) {
        return [`${label} projectId must be a nonempty source ID of at most 300 characters`];
      }
      return [];
    });
  });
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  return bundle;
};
