import { findSecret } from './secrets.mjs';
import { readExport, toBundleConversation, extractArtifacts, extractMemories } from './sources/export.mjs';
import { scanSkills, defaultSkillDirs } from './sources/skills.mjs';
import { readStaged } from './sources/staged.mjs';

export const BUNDLE_FORMAT = 'claude-migration-bundle';
export const BUNDLE_VERSION = 1;
export const GENERATOR = { name: 'claude-migration-plugin', version: '0.1.0' };

export const CATEGORIES = ['conversations', 'memories', 'skills', 'scheduledTasks', 'artifacts'];

const itemText = {
  conversations: (item) => item.messages.map((message) => message.text).join('\n'),
  memories: (item) => item.value,
  skills: (item) => [item.content, ...item.files.map((file) => file.content)].join('\n'),
  scheduledTasks: (item) => item.prompt,
  artifacts: (item) => item.content,
};

const itemTitle = {
  conversations: (item) => item.title,
  memories: (item) => item.value.slice(0, 120),
  skills: (item) => item.name,
  scheduledTasks: (item) => item.name,
  artifacts: (item) => item.title,
};

const itemDetail = {
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

/** Reads every source the options point at and returns the full, unfiltered set per category. */
export const collect = async (options = {}) => {
  const exported = options.exportPath ? await readExport(options.exportPath) : {};
  const rawConversations = Array.isArray(exported.conversations) ? exported.conversations : [];
  const staged = await readStaged(options.inputsDir);
  const skillRoots = options.skillDirs?.length ? options.skillDirs : defaultSkillDirs();

  const exportedMemories = extractMemories(exported.memories);
  const exportedArtifacts = extractArtifacts(rawConversations);
  return {
    conversations: mergeById(
      staged.conversations,
      rawConversations.map(toBundleConversation).filter((chat) => chat.messages.length > 0),
    ),
    memories: [...staged.memories, ...exportedMemories],
    skills: options.skipLocalSkills ? [] : await scanSkills(skillRoots),
    scheduledTasks: staged.scheduledTasks,
    artifacts: [...staged.artifacts, ...exportedArtifacts],
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
  ...Object.fromEntries(CATEGORIES.filter((category) => chosen[category].length > 0).map((c) => [c, chosen[c]])),
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
    return items.flatMap((item, index) => (item?.id ? [] : [`${category}[${index}] is missing an id`]));
  });
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  return bundle;
};
