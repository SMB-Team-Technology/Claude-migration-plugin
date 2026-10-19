import { readFile } from 'node:fs/promises';
import path from 'node:path';

const readOptional = async (dir, name) => {
  const text = await readFile(path.join(dir, name), 'utf8').catch(() => null);
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

const toMemory = (memory, index) => ({
  id: String(memory?.id ?? `memory-${index + 1}`),
  value: (typeof memory === 'string' ? memory : (memory.value ?? memory.text ?? memory.content ?? '')).trim(),
  ...(memory?.key ? { key: memory.key } : {}),
});

/**
 * Reads the files Claude writes into the staging folder while it gathers data
 * only it can reach (its memory, scheduled tasks, artifact list).
 */
export const readStaged = async (dir) => {
  if (!dir) {
    return { memories: [], scheduledTasks: [], artifacts: [] };
  }
  const [memories, tasks, artifacts] = await Promise.all([
    readOptional(dir, 'memories.json'),
    readOptional(dir, 'scheduled-tasks.json'),
    readOptional(dir, 'artifacts.json'),
  ]);
  return {
    memories: asList(memories, 'memories').map(toMemory).filter((memory) => memory.value),
    scheduledTasks: asList(tasks, 'tasks').map(toTask).filter((task) => task.prompt),
    artifacts: asList(artifacts, 'artifacts').map(toArtifact).filter((artifact) => artifact.content.trim()),
  };
};
