import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, makeBundle, validateBundle } from '../scripts/lib/bundle.mjs';
import { toSessionConversation } from '../scripts/lib/sources/sessions.mjs';

const project = { uuid: '00000000-0000-4000-8000-0000000000aa', name: 'Synthetic project', description: 'Test', prompt_template: '', docs: [] };
const remoteUrl = 'https://claude.ai/code/session_01SyntheticRemote';
const at = (minute) => `2026-10-21T20:${String(minute).padStart(2, '0')}:00.000Z`;

/** Rows shaped like a teleported Cowork session, including the local rows a teleport and /export append. */
const teleported = (lastMinute = 9) => [
  { type: 'permission-mode' },
  { type: 'user', remoteSourced: true, timestamp: at(0), message: { role: 'user', content: '<system-reminder>Folder connected</system-reminder>' } },
  { type: 'attachment', attachment: { type: 'session_context', context: { attachedProject: 'This session is attached to the Project **"Synthetic project"**.' } } },
  { type: 'attachment', timestamp: '2026-10-22T16:07:00.000Z', attachment: { type: 'remote_session_change', url: remoteUrl } },
  { type: 'user', remoteSourced: true, timestamp: at(1), message: { role: 'user', content: 'Create fictional test files' } },
  { type: 'assistant', remoteSourced: true, timestamp: at(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
  { type: 'assistant', remoteSourced: true, timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Where should files go?', options: [{ label: 'Root' }, { label: 'Subfolder' }] }] } }] } },
  { type: 'user', remoteSourced: true, timestamp: at(3), toolUseResult: { answers: { 'Where should files go?': 'Root' } }, message: { role: 'user', content: [{ type: 'tool_result', content: 'answered' }] } },
  { type: 'assistant', remoteSourced: true, timestamp: at(4), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'device_bash', input: { command: 'touch a' } }] } },
  { type: 'user', remoteSourced: true, timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] } },
  { type: 'attachment', timestamp: at(5), attachment: { type: 'queued_command', prompt: 'Use the root folder', humanTurn: true, timestamp: at(5) } },
  { type: 'assistant', remoteSourced: true, timestamp: at(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
  { type: 'assistant', remoteSourced: true, timestamp: at(6), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'device_bash', input: { command: 'touch b' } }] } },
  { type: 'user', remoteSourced: true, timestamp: at(7), message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] } },
  { type: 'assistant', remoteSourced: true, timestamp: at(lastMinute), message: { role: 'assistant', content: [{ type: 'text', text: 'Created the files.' }] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local command' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/export</command-name>' } },
  { type: 'user', message: { role: 'user', content: '<bash-input>true</bash-input>' } },
];

const desktop = [
  { type: 'custom-title', customTitle: 'Early title' },
  { type: 'user', sessionId: 'local-session-1', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>Injected</system-reminder>' }, { type: 'text', text: 'Plan the release' }, { type: 'image', source: {} }] } },
  { type: 'api-request-blob', message: { role: 'user', content: 'REQUEST COPY' } },
  { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT' }] } },
  { type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Visible reasoning' }, { type: 'text', text: 'Here is the plan.' }] } },
  { type: 'custom-title', customTitle: 'Release planning' },
];

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');

test('teleported Cowork sessions keep the conversation and drop injected, tool and teleport-local rows', () => {
  const chat = toSessionConversation(teleported());
  assert.equal(chat.id, 'session_01SyntheticRemote');
  assert.equal(chat.sourceProjectName, 'Synthetic project');
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'user', 'user', 'assistant']);
  assert.equal(chat.messages[0].text, 'Create fictional test files');
  assert.match(chat.messages[1].text, /Where should files go\?\n- Root\n- Subfolder/);
  assert.match(chat.messages[2].text, /> Root/);
  assert.equal(chat.messages[3].text, 'Use the root folder');
  assert.equal(chat.messages[4].text, 'Working on it.\n\nCreated the files.');
  assert.equal(chat.messages[4].createdAt, at(6));
  const all = JSON.stringify(chat.messages);
  assert.doesNotMatch(all, /Folder connected|TOOL OUTPUT|touch|export|bash-input|Caveat/);
  assert.equal(chat.createdAt, at(0));
  assert.equal(chat.updatedAt, at(9));
  assert.match(chat.migrationWarnings[0], /^2 tool calls .*device_bash ×2/);
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('thinking')));
  assert.ok(!chat.migrationWarnings.some((warning) => warning.includes('local shell')));
});

test('desktop sessions use their latest title, keep visible thinking and report images and subagents', () => {
  const chat = toSessionConversation(desktop);
  assert.equal(chat.id, 'local-session-1');
  assert.equal(chat.title, 'Release planning');
  assert.deepEqual(chat.messages, [
    { role: 'user', text: 'Plan the release', createdAt: at(0) },
    { role: 'assistant', text: 'Here is the plan.', createdAt: at(1), thinking: 'Visible reasoning' },
  ]);
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('1 image')));
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('Subagent')));
});

test('collects session folders, links projects by unique name and keeps the newest copy of a repeated teleport', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sessions-'));
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir);
  await writeFile(path.join(exportDir, `${project.uuid}.json`), JSON.stringify(project));
  await writeFile(path.join(dir, 'a.jsonl'), jsonl(teleported(8)));
  await writeFile(path.join(dir, 'b.jsonl'), `${jsonl(teleported(9))}\n{"type":"trunc`);
  const data = await collect({ exportPath: exportDir, sessionPaths: [dir], skipLocalSkills: true });
  assert.equal(data.conversations.length, 1);
  const [chat] = data.conversations;
  assert.equal(chat.projectId, project.uuid);
  assert.equal(chat.updatedAt, at(9));
  assert.equal(chat.sourceProjectName, undefined);
  assert.doesNotThrow(() => validateBundle(makeBundle(data)));
});

test('ambiguous or missing project names leave the chat standalone with a reason', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sessions-'));
  await writeFile(path.join(dir, 's.jsonl'), jsonl(teleported()));
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([
    { id: 'p1', name: 'Synthetic project' },
    { id: 'p2', name: 'Synthetic project' },
  ]));
  const ambiguous = await collect({ inputsDir: dir, sessionPaths: [path.join(dir, 's.jsonl')], skipLocalSkills: true });
  assert.equal(ambiguous.conversations[0].projectId, undefined);
  assert.match(ambiguous.conversations[0].migrationWarnings.at(-1), /several projects share that name/);
  const missing = await collect({ sessionPaths: [path.join(dir, 's.jsonl')], skipLocalSkills: true });
  assert.match(missing.conversations[0].migrationWarnings.at(-1), /not in this bundle/);
});

test('sessions.json supplies titles and project ids and reports expected sessions that were not collected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sessions-'));
  await writeFile(path.join(dir, 'harlow.jsonl'), jsonl(teleported()));
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([{ id: 'p1', name: 'Another name' }]));
  await writeFile(path.join(dir, 'sessions.json'), JSON.stringify([
    { path: 'harlow.jsonl', title: 'Test data setup', projectId: 'p1' },
    { id: 'session_01NotFetched', title: 'One-page document' },
    { path: 'missing.jsonl', title: 'Lost session' },
  ]));
  const data = await collect({ inputsDir: dir, skipLocalSkills: true });
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].title, 'Test data setup');
  assert.equal(data.conversations[0].projectId, 'p1');
  assert.equal(data.conversations[0].id, 'session_01SyntheticRemote');
  assert.deepEqual(data.sourceWarnings, [
    'Expected session "One-page document" (session_01NotFetched) was not collected: no transcript was staged.',
    'Expected session "Lost session" was not collected: transcript not found.',
  ]);
});

test('a corrupt line before the end of a transcript is rejected rather than skipped', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sessions-'));
  await writeFile(path.join(dir, 'bad.jsonl'), `{"broken\n${jsonl(desktop)}`);
  await assert.rejects(collect({ sessionPaths: [dir], skipLocalSkills: true }), /bad\.jsonl line 1 is not valid JSON/);
});

test('sessions.json entries match transcripts passed by folder through their session id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sessions-'));
  const teleports = path.join(dir, 'teleports');
  await mkdir(teleports);
  await writeFile(path.join(teleports, 'random-local-id.jsonl'), jsonl(teleported()));
  await writeFile(path.join(dir, 'sessions.json'), JSON.stringify([
    { id: 'session_01SyntheticRemote', title: 'Harlow & Pike test data setup' },
    { id: 'session_01NotFetched', title: 'One-page personal document' },
  ]));
  const data = await collect({ inputsDir: dir, sessionPaths: [teleports], skipLocalSkills: true });
  assert.equal(data.conversations[0].title, 'Harlow & Pike test data setup');
  assert.match(data.conversations[0].migrationWarnings.at(-1), /"Synthetic project", which is not in this bundle/);
  assert.deepEqual(data.sourceWarnings, ['Expected session "One-page personal document" (session_01NotFetched) was not collected: no transcript was staged.']);
});
