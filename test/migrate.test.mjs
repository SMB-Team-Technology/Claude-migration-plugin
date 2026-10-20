import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readZip } from '../scripts/lib/zip.mjs';
import { collect, summarize, select, makeBundle, validateBundle } from '../scripts/lib/bundle.mjs';
import { extractMemories } from '../scripts/lib/sources/export.mjs';
import { makeZip, sampleConversations } from './helpers.mjs';

const run = promisify(execFile);
const cli = path.resolve('scripts/aiwp-migrate.mjs');

const workspace = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migrate-'));
  const skills = path.join(dir, 'skills');
  await mkdir(path.join(skills, 'brief-writer', 'references'), { recursive: true });
  await writeFile(
    path.join(skills, 'brief-writer', 'SKILL.md'),
    '---\nname: brief-writer\ndescription: Drafts briefs\n---\nWrite briefs.',
  );
  await writeFile(path.join(skills, 'brief-writer', 'references', 'style.md'), 'Be concise.');
  await mkdir(path.join(skills, 'leaky'), { recursive: true });
  await writeFile(
    path.join(skills, 'leaky', 'SKILL.md'),
    '---\nname: leaky\ndescription: x\n---\nuse sk-ant-abcdefghijklmnopqrstuvwxyz123456',
  );
  const zip = path.join(dir, 'export.zip');
  await writeFile(zip, makeZip({ 'data/conversations.json': JSON.stringify(sampleConversations) }));
  const inputs = path.join(dir, 'inputs');
  await mkdir(inputs);
  await writeFile(path.join(inputs, 'memories.json'), JSON.stringify(['Prefers concise answers', { text: 'Works in family law' }]));
  await writeFile(
    path.join(inputs, 'scheduled-tasks.json'),
    JSON.stringify([{ id: 'daily', name: 'Daily digest', prompt: 'Summarize inbox', cron: '0 8 * * 1-5', timezone: 'America/Chicago' }]),
  );
  return { dir, skills, zip, inputs };
};

test('readZip reads deflated entries', () => {
  const entries = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }));
  assert.equal(entries.get('a.txt')().toString(), 'hello');
  assert.equal(entries.get('dir/b.txt')().toString(), 'world');
});

test('collect normalises conversations, replays artifact edits, and skips empty chats', async () => {
  const { zip, skills, inputs } = await workspace();
  const collected = await collect({ exportPath: zip, skillDirs: [skills], inputsDir: inputs });

  assert.equal(collected.conversations.length, 1);
  const [chat] = collected.conversations;
  assert.equal(chat.title, 'Lease review');
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.equal(chat.messages[1].thinking, 'Considering clauses');

  assert.equal(collected.artifacts.length, 1);
  assert.equal(collected.artifacts[0].content, 'Rent: $1200');
  assert.equal(collected.artifacts[0].conversationId, 'c1');

  assert.deepEqual(collected.memories.map((m) => m.value), ['Prefers concise answers', 'Works in family law']);
  assert.equal(collected.scheduledTasks[0].scheduleType, 'recurring');
  assert.equal(collected.skills.find((s) => s.name === 'brief-writer').files[0].path, 'references/style.md');
});

test('select honours categories and exclusions, and holds back credentials', async () => {
  const { zip, skills, inputs } = await workspace();
  const collected = await collect({ exportPath: zip, skillDirs: [skills], inputsDir: inputs });

  const summary = summarize(collected);
  assert.equal(summary.skills.flagged, 1);

  const { chosen, skipped } = select(collected, { categories: ['skills', 'memories'], exclude: ['memory-1'] });
  assert.equal(chosen.conversations.length, 0);
  assert.deepEqual(chosen.skills.map((s) => s.name), ['brief-writer']);
  assert.equal(chosen.memories.length, 1);
  assert.equal(skipped[0].id, 'leaky');

  const allowed = select(collected, { categories: ['skills'], allowFlagged: true });
  assert.equal(allowed.chosen.skills.length, 2);
});

test('makeBundle omits empty categories and validates', () => {
  const bundle = makeBundle({ conversations: [], memories: [{ id: 'm', value: 'x' }], skills: [], scheduledTasks: [], artifacts: [] });
  assert.deepEqual(Object.keys(bundle).filter((k) => ['conversations', 'memories'].includes(k)), ['memories']);
  assert.doesNotThrow(() => validateBundle(bundle));
  assert.throws(() => validateBundle({ ...bundle, memories: [{ value: 'no id' }] }), /missing an id/);
  assert.throws(() => validateBundle({ format: 'other' }), /Not a/);
});

test('extractMemories accepts prose fields', () => {
  const memories = extractMemories({ conversations_memory: '- Likes tea\n- Based in Austin, Texas' });
  assert.deepEqual(memories.map((m) => m.value), ['Likes tea', 'Based in Austin, Texas']);
});

test('CLI build writes a private bundle that validates', async () => {
  const { dir, zip, skills, inputs } = await workspace();
  const out = path.join(dir, 'out', 'bundle.json');
  const { stdout } = await run('node', [
    cli, 'build', '--out', out, '--export', zip, '--skills-dir', skills, '--inputs', inputs, '--categories', 'conversations,skills,scheduledTasks',
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.counts.conversations, 1);
  assert.equal(report.counts.skills, 1);
  assert.equal(report.skippedForCredentials.length, 1);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).scheduledTasks[0].cron, '0 8 * * 1-5');
  const check = await run('node', [cli, 'validate', out]);
  assert.equal(JSON.parse(check.stdout).valid, true);
});
