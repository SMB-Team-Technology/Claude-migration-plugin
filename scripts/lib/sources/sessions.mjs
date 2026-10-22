import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const LOCAL_COMMAND = /^<(?:command-name|command-message|command-args|local-command-[a-z]+|bash-input|bash-stdout|bash-stderr)>/;
const REMOTE_ID = /session_[A-Za-z0-9]+/;
const ATTACHED_PROJECT = /attached to the Project \*\*"(.+?)"\*\*/;
const TITLE_LENGTH = 80;

const cleanText = (text) => (typeof text === 'string' ? text.replace(REMINDER, '').trim() : '');

const parseLines = (text, label) => {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line)];
    } catch (error) {
      if (index === lines.length - 1) return [];
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
};

/** Rows written locally after a teleport (shell commands, /export) follow the last row pulled from the remote session. */
const remoteRows = (rows) => {
  let last = -1;
  rows.forEach((row, index) => {
    if (row.remoteSourced) last = index;
  });
  return last < 0 ? rows : rows.slice(0, last + 1);
};

const answerText = (result) =>
  Object.entries(result.answers)
    .map(([question, answer]) => `${question}\n> ${answer}`)
    .join('\n\n');

const questionText = (input) =>
  (Array.isArray(input?.questions) ? input.questions : [])
    .map((item) => [item.question, ...(item.options ?? []).map((option) => `- ${option.label ?? option}`)].join('\n'))
    .join('\n\n');

/** Collects user and assistant turns from Claude Code / Cowork transcript rows, reporting what was left out. */
const readTurns = (rows) => {
  const messages = [];
  const omitted = { tools: new Map(), hiddenThinking: 0, images: 0, localCommands: 0, sidechain: 0 };
  let assistant = null;

  const pushUser = (text, createdAt) => {
    assistant = null;
    if (text) messages.push({ role: 'user', text, ...(createdAt ? { createdAt } : {}) });
  };

  const userText = (content) => {
    if (typeof content === 'string') return [content];
    return content.flatMap((block) => {
      if (block?.type === 'image') omitted.images += 1;
      return block?.type === 'text' ? [block.text] : [];
    });
  };

  for (const row of rows) {
    if (row.isSidechain) {
      omitted.sidechain += 1;
      continue;
    }
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.humanTurn !== false) {
      pushUser(cleanText(row.attachment.prompt), row.attachment.timestamp ?? row.timestamp);
      continue;
    }
    if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && row.message) {
      const { content } = row.message;
      if (row.toolUseResult?.answers && typeof row.toolUseResult.answers === 'object') {
        pushUser(answerText(row.toolUseResult), row.timestamp);
        continue;
      }
      const parts = userText(Array.isArray(content) || typeof content === 'string' ? content : []).map(cleanText).filter(Boolean);
      const commands = parts.filter((part) => LOCAL_COMMAND.test(part));
      omitted.localCommands += commands.length;
      const text = parts.filter((part) => !LOCAL_COMMAND.test(part)).join('\n\n');
      if (text) pushUser(text, row.timestamp);
      continue;
    }
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) {
      continue;
    }
    if (!assistant) {
      assistant = { role: 'assistant', text: '', thinking: '', ...(row.timestamp ? { createdAt: row.timestamp } : {}) };
      messages.push(assistant);
    }
    for (const block of row.message.content) {
      if (block?.type === 'text') {
        assistant.text = [assistant.text, block.text].filter(Boolean).join('\n\n');
      } else if (block?.type === 'thinking') {
        if (block.thinking) assistant.thinking += block.thinking;
        else omitted.hiddenThinking += 1;
      } else if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') {
        assistant.text = [assistant.text, questionText(block.input)].filter(Boolean).join('\n\n');
      } else if (block?.type === 'tool_use') {
        omitted.tools.set(block.name, (omitted.tools.get(block.name) ?? 0) + 1);
      }
    }
  }

  const kept = messages
    .filter((message) => message.text.trim() || message.thinking?.trim())
    .map(({ thinking, ...message }) => (thinking ? { ...message, thinking } : message));
  return { messages: kept, omitted };
};

const warningsFor = (omitted) => {
  const warnings = [];
  const toolCount = [...omitted.tools.values()].reduce((sum, count) => sum + count, 0);
  if (toolCount) {
    const names = [...omitted.tools].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ×${count}`);
    warnings.push(`${toolCount} tool calls and their results were not migrated (${names.join(', ')}). Files they created are not included.`);
  }
  if (omitted.hiddenThinking) warnings.push('Hidden, summarized or truncated thinking is not recovered as full thinking.');
  if (omitted.images) warnings.push(`${omitted.images} image(s) attached in this session were not migrated.`);
  if (omitted.localCommands) warnings.push(`${omitted.localCommands} local shell or slash command(s) typed in the session were omitted.`);
  if (omitted.sidechain) warnings.push('Subagent transcripts in this session were not migrated.');
  return warnings;
};

const firstMatch = (rows, find) => {
  for (const row of rows) {
    const value = find(row);
    if (value) return value;
  }
  return undefined;
};

/** Maps one Claude Code or Cowork session transcript (JSONL rows) to the bundle's conversation shape. */
export const toSessionConversation = (allRows, overrides = {}) => {
  const rows = remoteRows(allRows);
  const { messages, omitted } = readTurns(rows);
  const remoteId = firstMatch(rows, (row) => row.attachment?.type === 'remote_session_change' && row.attachment.url?.match(REMOTE_ID)?.[0]);
  const id = overrides.id ?? remoteId ?? firstMatch(rows, (row) => row.sessionId);
  const customTitle = rows.filter((row) => row.type === 'custom-title' && row.customTitle).at(-1)?.customTitle;
  const firstPrompt = messages.find((message) => message.role === 'user')?.text.split('\n')[0].slice(0, TITLE_LENGTH);
  const projectName = firstMatch(rows, (row) => row.attachment?.context?.attachedProject?.match(ATTACHED_PROJECT)?.[1]);
  const timestamps = rows
    .filter((row) => row.type === 'user' || row.type === 'assistant')
    .map((row) => row.timestamp)
    .filter(Boolean)
    .sort();
  return {
    id,
    title: (overrides.title ?? customTitle ?? firstPrompt ?? '').trim() || 'Imported Claude session',
    ...(overrides.projectId ? { projectId: overrides.projectId } : {}),
    ...(timestamps.length ? { createdAt: timestamps[0], updatedAt: timestamps.at(-1) } : {}),
    messages,
    migrationWarnings: warningsFor(omitted),
    ...(projectName && !overrides.projectId ? { sourceProjectName: projectName } : {}),
  };
};

const transcriptFiles = async (target) => {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const names = await readdir(target);
  return names.filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(target, name));
};

/** Reads transcripts from files or folders of `.jsonl`; `overrides` maps a resolved path to staged id/title/projectId. */
export const readSessions = async (targets = [], overrides = new Map()) => {
  const files = (await Promise.all(targets.map(transcriptFiles))).flat();
  const chats = await Promise.all(
    files.map(async (file) => {
      const rows = parseLines(await readFile(file, 'utf8'), path.basename(file));
      return toSessionConversation(rows, overrides.get(path.resolve(file)));
    }),
  );
  const byId = new Map();
  for (const chat of chats.filter((item) => item.id && item.messages.length > 0)) {
    const current = byId.get(chat.id);
    if (!current || (chat.updatedAt ?? '') > (current.updatedAt ?? '')) byId.set(chat.id, chat);
  }
  return [...byId.values()];
};

/** Links chats to exported projects by exact, unique project name; ambiguous or missing names stay unlinked with a warning. */
export const linkSessionProjects = (chats, projects) => {
  const byName = new Map();
  for (const project of projects) {
    const name = project.name.trim();
    byName.set(name, byName.has(name) ? null : project.id);
  }
  return chats.map(({ sourceProjectName, ...chat }) => {
    if (!sourceProjectName) return chat;
    const projectId = byName.get(sourceProjectName.trim());
    if (projectId) return { ...chat, projectId };
    const reason = projectId === null
      ? `Linked to project "${sourceProjectName}", but several projects share that name; set projectId in sessions.json.`
      : `Linked to project "${sourceProjectName}", which is not in this bundle; imported as a standalone chat.`;
    return { ...chat, migrationWarnings: [...chat.migrationWarnings, reason] };
  });
};
