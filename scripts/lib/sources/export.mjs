import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from '../zip.mjs';
import { isManifest, neededFiles, resolveDownloaded, manifestTime } from './manifest.mjs';

const EXPORT_FILES = ['conversations.json', 'memories.json', 'projects.json'];
const PROJECT_FILE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i;
const ARTIFACT_RECORD = /(?:^|\/)artifacts\/[^/]+\/artifact\.json$/;
const isProject = (raw) => raw && !Array.isArray(raw) && typeof raw.uuid === 'string' && typeof raw.name === 'string' && Object.hasOwn(raw, 'prompt_template');

const combineProjects = (aggregate, individual) => {
  if (aggregate !== undefined && !Array.isArray(aggregate)) throw new Error('projects.json must contain an array');
  const projects = [...(aggregate ?? []), ...individual];
  const seen = new Map();
  for (const project of projects) {
    if (!project || typeof project !== 'object') throw new Error('Project payload entries must be objects');
    const id = project.id ?? project.uuid;
    if (seen.has(id)) throw new Error(`Ambiguous export: duplicate project ${id}. Choose one source explicitly.`);
    seen.set(id, project);
  }
  return aggregate !== undefined || individual.length ? projects : undefined;
};

/** Walks an extracted export for individual project records and published-artifact records. */
const recordFiles = async (dir, depth = 0) => {
  if (depth > 5) throw new Error('Export folder nesting exceeds 5 levels; choose the payload folder directly');
  const found = { projects: [], artifacts: [] };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await recordFiles(full, depth + 1);
      found.projects.push(...nested.projects);
      found.artifacts.push(...nested.artifacts);
    } else if (entry.isFile() && PROJECT_FILE.test(entry.name)) {
      found.projects.push(full);
    } else if (entry.isFile() && ARTIFACT_RECORD.test(full.split(path.sep).join('/'))) {
      found.artifacts.push(full);
    }
  }
  return found;
};

/** Maps a `frames` artifact record to an inventory entry: what exists, not its content. */
const toInventoryItem = (raw, label) => {
  if (typeof raw?.id !== 'string' || !Array.isArray(raw.versions)) throw new Error(`${label} is not a published-artifact record`);
  const active = raw.versions.find((version) => version.id === raw.active_version) ?? raw.versions.at(-1);
  return {
    id: raw.id,
    kind: raw.kind ?? 'artifact',
    title: active?.title?.trim() || 'Untitled',
    versions: raw.versions.length,
    ...(raw.visibility ? { visibility: raw.visibility } : {}),
  };
};

const inventoryOf = (records) => (records.length ? records : undefined);

const checkedExport = (data) => {
  if (Object.values(data).every((value) => value === undefined)) {
    throw new Error('No export payload found. Download the actual conversations, memories or projects archive, not just the export index. For extracted exports, pass the folder containing those JSON files.');
  }
  for (const key of ['conversations', 'projects']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`${key}.json must contain an array. This may be an export index rather than a data payload.`);
    }
  }
  return data;
};

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
};

/** Loads a claude.ai data export from its index (`member-manifest-….json`), a .zip, a folder, or a bare payload JSON. */
export const readExport = async (target) => {
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = await readdir(target);
    const read = async (name) =>
      names.includes(name) ? parseJson(await readFile(path.join(target, name), 'utf8'), name) : undefined;
    const [conversations, memories, projects] = await Promise.all(EXPORT_FILES.map(read));
    const records = await recordFiles(target);
    const individual = [];
    for (const file of records.projects) {
      const raw = parseJson(await readFile(file, 'utf8'), path.basename(file));
      if (isProject(raw)) individual.push(raw);
    }
    const inventory = await Promise.all(
      records.artifacts.map(async (file) => toInventoryItem(parseJson(await readFile(file, 'utf8'), file), file)),
    );
    return checkedExport({ conversations, memories, projects: combineProjects(projects, individual), artifactInventory: inventoryOf(inventory) });
  }
  if (target.toLowerCase().endsWith('.json')) {
    const name = path.basename(target).toLowerCase();
    const raw = parseJson(await readFile(target, 'utf8'), name);
    if (isProject(raw)) return { projects: [raw] };
    if (isManifest(raw)) return fromZipEntries(await manifestEntries(target, raw));
    if (!EXPORT_FILES.includes(name)) {
      throw new Error('Pass the export index (member-manifest-….json), conversations.json, memories.json, projects.json, an individual project JSON or an export archive.');
    }
    return checkedExport({ [name.replace('.json', '')]: raw });
  }
  return fromZipEntries(readZip(await readFile(target)));
};

/** Reads every archive an export index lists, from the folder the index was downloaded to. */
const manifestEntries = async (target, manifest) => {
  const dir = path.dirname(target);
  const since = manifestTime(manifest);
  const files = neededFiles(manifest);
  const found = await Promise.all(files.map((file) => resolveDownloaded(dir, file.filename, since)));
  const missing = files.filter((_, index) => !found[index]).map((file) => file.filename);
  if (missing.length > 0) {
    throw new Error(`The export index lists files that are not downloaded yet: ${missing.join(', ')}. Run the download step first.`);
  }
  const entries = new Map();
  for (const [index, file] of found.entries()) {
    for (const [name, read] of readZip(await readFile(file))) entries.set(`${files[index].filename}/${name}`, read);
  }
  return entries;
};

const fromZipEntries = (entries) => {
  const read = (name) => {
    const keys = [...entries.keys()].filter((entry) => entry === name || entry.endsWith(`/${name}`));
    if (keys.length > 1) {
      throw new Error(`Ambiguous export: multiple ${name} payloads. Extract and choose one explicitly.`);
    }
    return keys.length ? parseJson(entries.get(keys[0])().toString('utf8'), name) : undefined;
  };
  const individual = [];
  const inventory = [];
  for (const [name, readEntry] of entries) {
    if (ARTIFACT_RECORD.test(name)) {
      inventory.push(toInventoryItem(parseJson(readEntry().toString('utf8'), name), name));
      continue;
    }
    if (!PROJECT_FILE.test(name.split('/').at(-1))) continue;
    const raw = parseJson(readEntry().toString('utf8'), name);
    if (isProject(raw)) individual.push(raw);
  }
  return checkedExport({
    conversations: read('conversations.json'),
    memories: read('memories.json'),
    projects: combineProjects(read('projects.json'), individual),
    artifactInventory: inventoryOf(inventory),
  });
};

const blockText = (message) => {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.map((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'tool_use' && block.name === 'step_card_display_v0') {
      const input = block.input;
      if (!Array.isArray(input?.steps) || !input.steps.length || !input.steps.every((step) => typeof step?.title === 'string' && typeof step.description === 'string')) return '';
      const heading = typeof input.summary === 'string' ? `${input.summary}\n\n` : '';
      return `\n\n${heading}${input.steps.map((step, index) => `${index + 1}. **${step.title}**\n   ${step.description}`).join('\n\n')}\n\n`;
    }
    return '';
  }).join('');
  const thinking = blocks
    .filter((block) => block?.type === 'thinking' && block.thinking)
    .map((block) => block.thinking)
    .join('');
  return { text: text || message.text || '', thinking };
};

const toMessage = (message) => {
  const { text, thinking } = blockText(message);
  if (!text.trim() && !thinking.trim()) {
    return [];
  }
  const isUser = message.sender === 'human';
  return [
    {
      role: isUser ? 'user' : 'assistant',
      text,
      ...(thinking && !isUser ? { thinking } : {}),
      ...(message.created_at ? { createdAt: message.created_at } : {}),
    },
  ];
};

const fidelityWarnings = (conversation) => {
  const warnings = new Set();
  for (const message of conversation.chat_messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'thinking') {
        if (block.thinking_hidden || block.truncated || block.cut_off || (!block.thinking && block.summaries?.length)) warnings.add('Hidden, summarized or truncated thinking is not recovered as full thinking.');
      } else if (block?.type === 'text') {
        if (block.citations?.length) warnings.add('Citation metadata is not migrated; inline text and URLs are preserved.');
      } else if (block?.type === 'tool_result') {
        warnings.add('Tool-result payloads (including fetched pages and search results) are not migrated. Display cards are rendered from their tool inputs only.');
      } else if (block?.type === 'tool_use' && block.name === 'step_card_display_v0') {
        if (!Array.isArray(block.input?.steps) || !block.input.steps.length || !block.input.steps.every((step) => typeof step?.title === 'string' && typeof step.description === 'string')) warnings.add('A malformed step display card could not be recovered.');
      } else if (block?.type === 'tool_use' && block.name === 'artifacts') {
        continue;
      } else {
        warnings.add('Unsupported structured content or tool calls were omitted from this chat.');
      }
    }
  }
  return [...warnings];
};

/** Maps one claude.ai conversation to the bundle's conversation shape. */
export const toBundleConversation = (conversation) => ({
  id: conversation.uuid,
  title: conversation.name?.trim() || 'Imported Claude chat',
  ...(conversation.project_uuid ? { projectId: conversation.project_uuid } : {}),
  ...(conversation.created_at ? { createdAt: conversation.created_at } : {}),
  ...(conversation.updated_at ? { updatedAt: conversation.updated_at } : {}),
  messages: (conversation.chat_messages ?? []).flatMap(toMessage),
  migrationWarnings: fidelityWarnings(conversation),
});

const applyArtifactCommand = (artifacts, conversationId, input, createdAt) => {
  if (!input?.id) {
    return;
  }
  const key = `${conversationId}:${input.id}`;
  const current = artifacts.get(key);
  if (input.command === 'create' || (input.command === 'rewrite' && !current)) {
    artifacts.set(key, {
      id: key,
      title: input.title || current?.title || 'Untitled artifact',
      type: input.type || current?.type || 'text/html',
      ...(input.language ? { language: input.language } : {}),
      content: input.content ?? '',
      conversationId,
      ...(createdAt ? { createdAt } : {}),
    });
    return;
  }
  if (!current) {
    return;
  }
  if (input.command === 'rewrite') {
    artifacts.set(key, { ...current, title: input.title || current.title, content: input.content ?? '' });
    return;
  }
  if (input.command === 'update' && typeof input.old_str === 'string' && current.content.includes(input.old_str)) {
    artifacts.set(key, { ...current, content: current.content.replace(input.old_str, () => input.new_str ?? '') });
  }
};

/** Replays each conversation's artifact tool calls and returns the final version of every artifact. */
export const extractArtifacts = (conversations) => {
  const artifacts = new Map();
  for (const conversation of conversations) {
    for (const message of conversation.chat_messages ?? []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'tool_use' && block.name === 'artifacts') {
          applyArtifactCommand(artifacts, conversation.uuid, block.input, message.created_at);
        }
      }
    }
  }
  return [...artifacts.values()].filter((artifact) => artifact.content.trim());
};

const memoryText = (entry) =>
  typeof entry === 'string' ? entry : (entry?.text ?? entry?.content ?? entry?.memory ?? entry?.value ?? '');

const splitLines = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length >= 8);

/** Accepts the shapes a memories export plausibly takes: an array of strings/objects, or an object of prose fields. */
export const extractMemories = (raw) => {
  if (!raw) {
    return [];
  }
  const values = Array.isArray(raw)
    ? raw.map(memoryText).filter(Boolean)
    : Object.values(raw)
        .filter((value) => typeof value === 'string')
        .flatMap(splitLines);
  return values.map((value, index) => ({ id: `memory-${index + 1}`, value: value.trim() }));
};
