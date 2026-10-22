import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSessions, projectSlug, fetchAllCommand, FETCH_SCRIPT, extractSessionIds, addKnownSessions } from '../scripts/lib/sources/desktop.mjs';

const write = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

const desktopHome = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desktop home's-"));
  const app = path.join(home, 'Library', 'Application Support', 'Claude');
  const projects = path.join(home, '.claude', 'projects');
  await write(path.join(app, 'claude-code', '2.1.9', 'b1', 'claude.app', 'Contents', 'MacOS', 'claude'), '');
  await write(path.join(app, 'claude-code', '2.1.10', 'b2', 'claude.app', 'Contents', 'MacOS', 'claude'), '');
  await write(path.join(app, 'local-agent-mode-sessions', 'acct', 'org', 'remote-session-spaces.json'), JSON.stringify({ entries: [
    { sessionId: 'session_01Alpha', folders: ['/Users/x/Client'] },
    { sessionId: 'session_01Beta', folders: [] },
    { sessionId: 'session_01DeltaLong00', folders: ['/Users/x/Delta'] },
    { sessionId: 'session_01Alpha', folders: ['/Users/x/Client'] },
    { sessionId: 'not a session; rm -rf ~', folders: [] },
  ] }));
  const sessions = path.join(app, 'claude-code-sessions', 'acct', 'org');
  await write(path.join(sessions, 'local_1.json'), JSON.stringify({ cliSessionId: 'cli-1', cwd: '/Users/x/repo', title: 'Release planning', isArchived: false, cookies: 'never read' }));
  await write(path.join(sessions, 'local_2.json'), JSON.stringify({ cliSessionId: 'cli-2', cwd: '/Users/x/tele', title: 'Teleported copy' }));
  await write(path.join(sessions, 'local_3.json'), JSON.stringify({ cliSessionId: 'cli-3', cwd: '/Users/x/gone', title: 'No transcript' }));
  await write(path.join(projects, projectSlug('/Users/x/repo'), 'cli-1.jsonl'), '{"type":"user"}\n');
  await write(path.join(projects, projectSlug('/Users/x/tele'), 'cli-2.jsonl'), '{"type":"user","remoteSourced":true}\n');
  await write(path.join(projects, 'some-earlier-folder', 'old.jsonl'), '{"type":"user","remoteSourced":true}\n{"type":"attachment","attachment":{"type":"remote_session_change","url":"https://claude.ai/code/session_01Beta"}}\n');
  await write(path.join(projects, 'unrelated', 'mention.jsonl'), '{"type":"user","message":{"content":"see session_01Alpha"}}\n');
  return { home, app, projects };
};

test('project slugs match Claude Code transcript folders', () => {
  assert.equal(
    projectSlug('/private/tmp/claude-502/-Users-g/f5/scratchpad/teleport-probe'),
    '-private-tmp-claude-502--Users-g-f5-scratchpad-teleport-probe',
  );
});

test('lists Cowork sessions with paste-ready commands for the bundled claude, and real desktop Code sessions', async () => {
  const { home, app, projects } = await desktopHome();
  const result = await listSessions({ home });
  assert.equal(result.claude, path.join(app, 'claude-code', '2.1.10', 'b2', 'claude.app', 'Contents', 'MacOS', 'claude'));
  assert.deepEqual(result.cowork.map((item) => [item.id, item.collected, item.transcript && path.basename(item.transcript)]), [
    ['session_01Alpha', false, null],
    ['session_01Beta', true, 'old.jsonl'],
    ['session_01DeltaLong00', false, null],
  ]);
  const [first] = result.cowork;
  assert.match(first.command, /^mkdir -p '.*aiwp-migration\/cowork' && cd '.*' && '.*claude' --teleport session_01Alpha$/);
  assert.ok(first.command.includes("home'\\''s-"), 'quotes in paths are escaped for the shell');
  assert.equal(result.transcripts, path.join(projects, projectSlug(path.join(home, 'aiwp-migration', 'cowork'))));
  assert.deepEqual(result.code.map((item) => [item.id, item.title, Boolean(item.transcript)]), [
    ['cli-1', 'Release planning', true],
    ['cli-3', 'No transcript', false],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /never read/);
});

test('without the desktop app there are no commands, and the reason is stated', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'no-desktop-'));
  const result = await listSessions({ home });
  assert.equal(result.claude, null);
  assert.deepEqual(result.cowork, []);
  assert.match(result.notice, /built-in command-line tool was not found/);
});

test('one paste-ready command fetches every pending chat with built-in tools only', () => {
  const command = fetchAllCommand({ teleportFolder: "/Users/o'neil/aiwp-migration/cowork", claude: '/Apps/Claude Support/claude' });
  assert.equal(
    command,
    `mkdir -p '/Users/o'\\''neil/aiwp-migration/cowork' && cd '/Users/o'\\''neil/aiwp-migration/cowork' && '/usr/bin/expect' '${FETCH_SCRIPT}' '/Apps/Claude Support/claude' pending-sessions.txt`,
  );
  assert.match(FETCH_SCRIPT, /scripts\/fetch\.exp$/);
});

test('pasted claude.ai Cowork links and session IDs become teleport IDs, once each', () => {
  assert.deepEqual(extractSessionIds(`EOS https://claude.ai/cowork/cse_012pPS4y44McBUr6vzygBVon
Connectors session_01AbCdEfGhIjKlMn and again claude.ai/cowork/cse_012pPS4y44McBUr6vzygBVon; noise cse_short session_; rm -rf ~`), [
    'session_012pPS4y44McBUr6vzygBVon',
    'session_01AbCdEfGhIjKlMn',
  ]);
});

test('added sessions are remembered, listed with folder-index sessions and not duplicated', async () => {
  const { home } = await desktopHome();
  assert.deepEqual(await addKnownSessions(home, 'https://claude.ai/cowork/cse_01Gamma0000000 cse_01DeltaLong00'), { added: 2, total: 2 });
  assert.deepEqual(await addKnownSessions(home, 'cse_01Gamma0000000'), { added: 0, total: 2 });
  const result = await listSessions({ home });
  assert.deepEqual(result.cowork.map((item) => [item.id, item.source]), [
    ['session_01Alpha', 'folder'],
    ['session_01Beta', 'folder'],
    ['session_01DeltaLong00', 'folder'],
    ['session_01Gamma0000000', 'added'],
  ]);
});
