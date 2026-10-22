import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, select, makeBundle, validateBundle } from '../scripts/lib/bundle.mjs';
import { scanSkills } from '../scripts/lib/sources/skills.mjs';
import { scanMemories } from '../scripts/lib/sources/memory.mjs';
import { toSessionConversation } from '../scripts/lib/sources/sessions.mjs';

const run = promisify(execFile);

const write = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

const skill = (name) => `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}`;

test('desktop-synced skills are found and labelled by origin; built-ins stay out of the bundle by default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
  const synced = path.join(root, 'synced', 'org-1');
  await write(path.join(root, 'local-only', 'SKILL.md'), skill('local-only'));
  await write(path.join(synced, 'manifest.json'), JSON.stringify({ skills: [
    { name: 'brief-writer', source: 'custom' },
    { name: 'team-notes', source: 'plugin' },
    { name: 'docx', source: 'anthropic' },
  ] }));
  for (const name of ['brief-writer', 'team-notes', 'docx']) await write(path.join(synced, name, 'SKILL.md'), skill(name));
  const skills = await scanSkills([root]);
  assert.deepEqual(skills.map((item) => [item.name, item.origin]).sort(), [
    ['brief-writer', 'mine'], ['docx', 'claude'], ['local-only', 'mine'], ['team-notes', 'team'],
  ]);
  const data = { projects: [], conversations: [], memories: [], skills, scheduledTasks: [], artifacts: [] };
  const recommended = makeBundle(select(data).chosen);
  assert.deepEqual(recommended.skills.map((item) => item.name).sort(), ['brief-writer', 'local-only', 'team-notes']);
  assert.ok(recommended.skills.every((item) => !('origin' in item)));
  assert.equal(makeBundle(select(data, { includeBuiltinSkills: true }).chosen).skills.length, 4);
});

test('Claude Code memory files become one memory each, verbatim, labelled by project; indexes are skipped', async () => {
  const projects = await mkdtemp(path.join(tmpdir(), 'projects-'));
  const repo = path.join(projects, '-Users-x-Documents-client-site');
  await write(path.join(repo, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/Users/x/Documents/client-site' })}\n`);
  await write(path.join(repo, 'memory', 'MEMORY.md'), '- [Deploys](deploys.md) — index line');
  await write(path.join(repo, 'memory', 'deploys.md'), '---\nname: deploys\ndescription: How deploys work\nmetadata:\n  type: project\n---\n\nDeploy previews first.\n**Why:** safety.\n');
  await write(path.join(repo, 'memory', 'empty-body.md'), '---\nname: tone\ndescription: Prefers short answers\n---\n');
  await write(path.join(projects, '-Users-x-Library-Application-Support-Claude-scratch-workspaces-a-b-scratch-2026-10-22-ff42a8', 'memory', 'note.md'), 'Plain note without frontmatter');
  const memories = await scanMemories(projects);
  assert.deepEqual(memories.map(({ key, value }) => [key, value]), [
    ['client-site · deploys', 'Deploy previews first.\n**Why:** safety.'],
    ['client-site · tone', 'Prefers short answers'],
    ['Claude desktop · note', 'Plain note without frontmatter'],
  ]);
  assert.equal(new Set(memories.map((item) => item.id)).size, 3);
});

test('cloud routine schedules are split into cron and timezone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tasks-'));
  await write(path.join(dir, 'scheduled-tasks.json'), JSON.stringify([
    { id: 'digest', name: 'End-of-day digest', prompt: 'Summarize my day', cron: 'CRON_TZ=America/New_York 15 16 * * 1-5' },
  ]));
  const data = await collect({ inputsDir: dir, skipLocalSkills: true, skipLocalMemories: true });
  assert.deepEqual(
    (({ cron, timezone, scheduleType }) => ({ cron, timezone, scheduleType }))(data.scheduledTasks[0]),
    { cron: '15 16 * * 1-5', timezone: 'America/New_York', scheduleType: 'recurring' },
  );
  assert.doesNotThrow(() => validateBundle(makeBundle(data)));
});

test('chat titles skip opening slash commands and answers to Claude questions', () => {
  const chat = toSessionConversation([
    { type: 'user', sessionId: 's1', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>claude-opus-5-5</command-args>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Do you have an export?', options: [{ label: 'Yes' }] }] } }] } },
    { type: 'user', toolUseResult: { answers: { 'Do you have an export?': 'Yes' } }, message: { role: 'user', content: [{ type: 'tool_result', content: 'answered' }] } },
    { type: 'user', message: { role: 'user', content: 'Build the pipeline map\nwith details' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]);
  assert.equal(chat.title, 'Build the pipeline map');
  assert.equal(chat.messages[0].text, '/model claude-opus-5-5');
});

test('build refuses to save a bundle inside a code repository', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'repo-'));
  await mkdir(path.join(repo, '.git'));
  const out = path.join(repo, 'nested', 'aiwp-migration-bundle.json');
  await assert.rejects(
    run('node', ['scripts/aiwp-migrate.mjs', 'build', '--no-local-skills', '--no-local-memories', '--out', out]),
    /Refusing to save the bundle inside the code repository/,
  );
});
