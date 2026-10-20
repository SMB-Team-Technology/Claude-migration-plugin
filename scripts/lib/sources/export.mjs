import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readZip } from '../zip.mjs';

const EXPORT_FILES = ['conversations.json', 'memories.json'];

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
};

/** Loads the JSON files of a claude.ai data export from a .zip, a folder, or a bare conversations.json. */
export const readExport = async (target) => {
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = await readdir(target);
    const read = async (name) =>
      names.includes(name) ? parseJson(await readFile(path.join(target, name), 'utf8'), name) : undefined;
    const [conversations, memories] = await Promise.all(EXPORT_FILES.map(read));
    return { conversations, memories };
  }
  if (target.toLowerCase().endsWith('.json')) {
    return { conversations: parseJson(await readFile(target, 'utf8'), path.basename(target)) };
  }
  const entries = readZip(await readFile(target));
  const read = (name) => {
    const key = [...entries.keys()].find((entry) => entry === name || entry.endsWith(`/${name}`));
    return key ? parseJson(entries.get(key)().toString('utf8'), name) : undefined;
  };
  return { conversations: read('conversations.json'), memories: read('memories.json') };
};

const blockText = (message) => {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
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

/** Maps one claude.ai conversation to the bundle's conversation shape. */
export const toBundleConversation = (conversation) => ({
  id: conversation.uuid,
  title: conversation.name?.trim() || 'Imported Claude chat',
  ...(conversation.created_at ? { createdAt: conversation.created_at } : {}),
  ...(conversation.updated_at ? { updatedAt: conversation.updated_at } : {}),
  messages: (conversation.chat_messages ?? []).flatMap(toMessage),
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
