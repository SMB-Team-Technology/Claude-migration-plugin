import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toBundleConversation } from './export.mjs';
import { toProject } from './projects.mjs';

const readOptional = async (dir, name) => {
  const text = await readFile(path.join(dir, name), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
};

const asList = (raw, key) => (Array.isArray(raw) ? raw : (raw?.[key] ?? []));

const toTask = (task, index) => {
  const cron = task.cron ?? task.cronExpression ?? task.cron_expression;
  const runAt = task.runAt ?? task.run_once_at ?? task.fireAt;
  return {
    id: String(task.id ?? task.taskId ?? `task-${index + 1}`),
    name: task.name ?? task.title ?? task.id ?? `Scheduled task ${index + 1}`,
    prompt: task.prompt ?? task.description ?? '',
    scheduleType: cron ? 'recurring' : 'once',
    ...(cron ? { cron } : {}),
    ...(!cron && runAt ? { runAt } : {}),
    timezone: task.timezone ?? task.tz ?? 'UTC',
    enabled: task.enabled !== false,
  };
};

const toArtifact = (artifact, index) => ({
  id: String(artifact.id ?? `artifact-${index + 1}`),
  title: artifact.title ?? artifact.name ?? 'Untitled artifact',
  type: artifact.type ?? 'text/html',
  ...(artifact.language ? { language: artifact.language } : {}),
  content: artifact.content ?? '',
});

const toConversation = (chat, index) => {
  if (Array.isArray(chat.chat_messages)) {
    return toBundleConversation(chat);
  }
  const messages = (chat.messages ?? [])
    .map((message) => ({
      role: message.role === 'user' || message.role === 'human' ? 'user' : 'assistant',
      text: message.text ?? message.content ?? '',
      ...(message.thinking ? { thinking: message.thinking } : {}),
      ...(message.createdAt ?? message.created_at ? { createdAt: message.createdAt ?? message.created_at } : {}),
    }))
    .filter((message) => typeof message.text === 'string' && message.text.trim());
  return {
    id: String(chat.id ?? chat.uuid ?? `chat-${index + 1}`),
    title: (chat.title ?? chat.name ?? '').trim() || 'Imported Claude chat',
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
    ...(chat.createdAt ?? chat.created_at ? { createdAt: chat.createdAt ?? chat.created_at } : {}),
    messages,
  };
};

const toSession = (dir) => (entry, index) => ({
  ...(entry.path ? { path: path.resolve(dir, entry.path) } : {}),
  ...(entry.id ? { id: String(entry.id) } : {}),
  label: entry.title ?? entry.id ?? `Session ${index + 1}`,
  ...(entry.title ? { title: String(entry.title) } : {}),
  ...(entry.projectId ? { projectId: String(entry.projectId) } : {}),
});

const toMemory = (memory, index) => ({
  id: String(memory?.id ?? `memory-${index + 1}`),
  value: (typeof memory === 'string' ? memory : (memory.value ?? memory.text ?? memory.content ?? '')).trim(),
  ...(memory?.key ? { key: memory.key } : {}),
});

/**
 * Reads the files Claude writes into the staging folder while it gathers data
 * only it can reach (its memory, scheduled tasks, artifact list, session transcripts).
 */
export const readStaged = async (dir) => {
  if (!dir) {
    return { projects: [], conversations: [], sessions: [], memories: [], scheduledTasks: [], artifacts: [] };
  }
  const [projects, chats, sessions, memories, tasks, artifacts] = await Promise.all([
    readOptional(dir, 'projects.json'),
    readOptional(dir, 'conversations.json'),
    readOptional(dir, 'sessions.json'),
    readOptional(dir, 'memories.json'),
    readOptional(dir, 'scheduled-tasks.json'),
    readOptional(dir, 'artifacts.json'),
  ]);
  return {
    projects: asList(projects, 'projects').map(toProject),
    conversations: asList(chats, 'conversations')
      .map(toConversation)
      .filter((chat) => chat.messages.length > 0),
    sessions: asList(sessions, 'sessions').map(toSession(dir)),
    memories: asList(memories, 'memories').map(toMemory).filter((memory) => memory.value),
    scheduledTasks: asList(tasks, 'tasks').map(toTask).filter((task) => task.prompt),
    artifacts: asList(artifacts, 'artifacts').map(toArtifact).filter((artifact) => artifact.content.trim()),
  };
};
