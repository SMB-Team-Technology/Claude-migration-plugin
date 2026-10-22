import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const exists = (file) => stat(file).then(() => true, () => false);

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`);
  }
};

const subdirs = async (dir) => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

/** Claude Code names a folder's transcript directory after its path, with every other character replaced by `-`. */
export const projectSlug = (folder) => folder.replace(/[^a-zA-Z0-9]/g, '-');

const byVersionDesc = (a, b) => {
  const left = path.basename(a).split('.').map(Number);
  const right = path.basename(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0);
  }
  return 0;
};

/** The newest Claude Code program bundled with the Claude desktop app (macOS), so users need nothing installed. */
export const findDesktopClaude = async (appDir) => {
  for (const version of (await subdirs(path.join(appDir, 'claude-code'))).sort(byVersionDesc)) {
    for (const build of await subdirs(version)) {
      const binary = path.join(build, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (await exists(binary)) return binary;
    }
  }
  return null;
};

/** `<account>/<org>` folders the desktop app keeps per signed-in organization. */
const orgDirs = async (root) => (await Promise.all((await subdirs(root)).map(subdirs))).flat();

const transcriptIds = async (dir) => {
  const names = await readdir(dir).catch(() => []);
  const texts = await Promise.all(names.filter((name) => name.endsWith('.jsonl')).map((name) => readFile(path.join(dir, name), 'utf8')));
  return (id) => texts.some((text) => text.includes(id));
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Lists Cowork sessions (IDs and linked folders) and desktop Code sessions (titles and transcripts)
 * from the desktop app's session indexes. Reads only those fields; never app storage or credentials.
 */
export const listSessions = async ({ home, appDir = path.join(home, 'Library', 'Application Support', 'Claude'), configDir = path.join(home, '.claude') }) => {
  const teleportFolder = path.join(home, 'aiwp-migration', 'cowork');
  const transcripts = path.join(configDir, 'projects', projectSlug(teleportFolder));
  const collected = await transcriptIds(transcripts);
  const claude = await findDesktopClaude(appDir);

  const spaces = await Promise.all(
    (await orgDirs(path.join(appDir, 'local-agent-mode-sessions'))).map((dir) => readJson(path.join(dir, 'remote-session-spaces.json'))),
  );
  const seen = new Set();
  const cowork = spaces
    .flatMap((file) => (Array.isArray(file?.entries) ? file.entries : []))
    .filter((entry) => typeof entry?.sessionId === 'string' && /^session_[A-Za-z0-9]+$/.test(entry.sessionId) && !seen.has(entry.sessionId) && seen.add(entry.sessionId))
    .map((entry) => ({
      id: entry.sessionId,
      folders: (entry.folders ?? []).filter((folder) => typeof folder === 'string'),
      collected: collected(entry.sessionId),
      ...(claude ? { command: `mkdir -p ${shellQuote(teleportFolder)} && cd ${shellQuote(teleportFolder)} && ${shellQuote(claude)} --teleport ${entry.sessionId}` } : {}),
    }));

  const code = [];
  for (const dir of await orgDirs(path.join(appDir, 'claude-code-sessions'))) {
    for (const name of (await readdir(dir)).filter((file) => /^local_.*\.json$/.test(file))) {
      const record = await readJson(path.join(dir, name));
      if (typeof record?.cliSessionId !== 'string' || typeof record.cwd !== 'string') continue;
      const transcript = path.join(configDir, 'projects', projectSlug(record.cwd), `${record.cliSessionId}.jsonl`);
      const text = await readFile(transcript, 'utf8').catch(() => null);
      if (text?.includes('"remoteSourced":true')) continue;
      code.push({
        id: record.cliSessionId,
        title: typeof record.title === 'string' ? record.title : 'Untitled session',
        archived: record.isArchived === true,
        transcript: text === null ? null : transcript,
      });
    }
  }

  return {
    claude,
    teleportFolder,
    transcripts,
    cowork,
    code,
    coverage: 'Cowork chats are listed only when they have a linked folder. Compare with each project in the desktop app and add any others to sessions.json by id.',
    ...(claude ? {} : { notice: 'The Claude desktop app’s built-in command-line tool was not found, so Cowork sessions cannot be collected on this computer.' }),
  };
};
