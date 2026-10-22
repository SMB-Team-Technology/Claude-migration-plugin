import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FETCH_SCRIPT = fileURLToPath(new URL('../../fetch.exp', import.meta.url));
export const PENDING_FILE = 'pending-sessions.txt';
const EXPECT = '/usr/bin/expect';

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

const HEAD_BYTES = 256 * 1024;
const REMOTE_SESSION = /"remote_session_change"[^\n]*?(session_[A-Za-z0-9]+)/;

const readHead = async (file) => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

/**
 * Finds Cowork transcripts already fetched anywhere under `projects` (from any earlier teleport),
 * keyed by remote session id, newest first. Reads only the start of each transcript.
 */
const fetchedTranscripts = async (projects) => {
  const files = (await Promise.all((await subdirs(projects)).map(async (dir) =>
    (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)),
  ))).flat();
  const found = new Map();
  for (const file of files) {
    const head = await readHead(file);
    const id = head.includes('"remoteSourced":true') ? head.match(REMOTE_SESSION)?.[1] : undefined;
    if (!id) continue;
    const { mtimeMs } = await stat(file);
    if (!found.has(id) || found.get(id).mtimeMs < mtimeMs) found.set(id, { file, mtimeMs });
  }
  return found;
};

export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** The single command a user pastes into a terminal to fetch every pending Cowork chat, using only built-in macOS tools. */
export const fetchAllCommand = ({ teleportFolder, claude, expect = EXPECT, script = FETCH_SCRIPT }) =>
  `mkdir -p ${shellQuote(teleportFolder)} && cd ${shellQuote(teleportFolder)} && ${shellQuote(expect)} ${shellQuote(script)} ${shellQuote(claude)} ${PENDING_FILE}`;

/**
 * Lists Cowork sessions (IDs and linked folders) and desktop Code sessions (titles and transcripts)
 * from the desktop app's session indexes. Reads only those fields; never app storage or credentials.
 */
export const listSessions = async ({ home, appDir = path.join(home, 'Library', 'Application Support', 'Claude'), configDir = path.join(home, '.claude') }) => {
  const teleportFolder = path.join(home, 'aiwp-migration', 'cowork');
  const transcripts = path.join(configDir, 'projects', projectSlug(teleportFolder));
  const fetched = await fetchedTranscripts(path.join(configDir, 'projects'));
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
      collected: fetched.has(entry.sessionId),
      transcript: fetched.get(entry.sessionId)?.file ?? null,
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
