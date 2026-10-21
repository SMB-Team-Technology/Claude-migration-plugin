import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { collect, select, validateBundle, makeBundle } from '../scripts/lib/bundle.mjs';
import { readExport } from '../scripts/lib/sources/export.mjs';
import { makeZip } from './helpers.mjs';

const run = promisify(execFile);
const workspace = () => mkdtemp(path.join(os.tmpdir(), 'projects-'));

test('projects and linked chats can be staged without inventing local storage paths', async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([
    { id: 'p1', name: 'Client', instructions: 'Be precise', context: 'Reference', files: ['notes.pdf'] },
  ]));
  await writeFile(path.join(dir, 'conversations.json'), JSON.stringify([
    { id: 'c1', projectId: 'p1', messages: [{ role: 'user', text: 'Question' }] },
  ]));
  const data = await collect({ inputsDir: dir, skipLocalSkills: true });
  assert.equal(data.projects[0].context, 'Reference');
  assert.match(data.projects[0].migrationWarnings[0], /files were not migrated/);
  assert.equal(data.conversations[0].projectId, 'p1');
  assert.doesNotThrow(() => validateBundle(makeBundle(data)));
});

test('reads an explicit projects payload and preserves cloud project relationships', async () => {
  const dir = await workspace();
  const zip = path.join(dir, 'export.zip');
  await writeFile(zip, makeZip({
    'projects.json': JSON.stringify([{ uuid: 'p1', name: 'Client', prompt_template: 'Instructions', docs: [{ name: 'doc' }] }]),
    'conversations.json': JSON.stringify([{ uuid: 'c1', name: 'Chat', project_uuid: 'p1', chat_messages: [{ sender: 'human', text: 'hello' }] }]),
  }));
  const data = await collect({ exportPath: zip, skipLocalSkills: true });
  assert.equal(data.projects[0].instructions, 'Instructions');
  assert.equal(data.conversations[0].projectId, 'p1');
});

test('rejects export indexes, missing payloads and ambiguous archives', async () => {
  const dir = await workspace();
  const index = path.join(dir, 'export-index.json');
  await writeFile(index, JSON.stringify({ files: ['conversations.zip'] }));
  await assert.rejects(readExport(index), /indexes are not payloads/);
  const empty = path.join(dir, 'empty');
  await mkdir(empty);
  await assert.rejects(readExport(empty), /No export payload/);
  const zip = path.join(dir, 'ambiguous.zip');
  await writeFile(zip, makeZip({ 'conversations.json': '[]', 'nested/conversations.json': '[]' }));
  await assert.rejects(readExport(zip), /Ambiguous export/);
});

test('rejects malformed project records and duplicate IDs', async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([{ name: 'No stable ID' }]));
  await assert.rejects(collect({ inputsDir: dir, skipLocalSkills: true }), /stable id/);
  assert.throws(() => validateBundle({ format: 'claude-migration-bundle', version: 1, projects: [
    { id: 'p', name: 'One', instructions: '', context: '' },
    { id: 'p', name: 'Two', instructions: '', context: '' },
  ] }), /duplicate id/);
});

test('project limits match the AIWP contract without truncating content', () => {
  const valid = { id: 'p', name: 'n'.repeat(128), instructions: 'i'.repeat(100_000), context: 'c'.repeat(100_000) };
  const bundle = (project) => ({ format: 'claude-migration-bundle', version: 1, projects: [project] });
  assert.doesNotThrow(() => validateBundle(bundle(valid)));
  for (const [field, value] of [['id', 'x'.repeat(301)], ['name', 'x'.repeat(129)], ['instructions', 'x'.repeat(100_001)], ['context', 'x'.repeat(100_001)]]) {
    assert.throws(() => validateBundle(bundle({ ...valid, [field]: value })), /exceed/);
  }
});

test('scans thinking and project context for credentials', async () => {
  const dir = await workspace();
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([{ id: 'p', name: 'Client', context: secret }]));
  await writeFile(path.join(dir, 'conversations.json'), JSON.stringify([{ id: 'c', messages: [{ role: 'assistant', text: 'hello', thinking: secret }] }]));
  const { chosen, skipped } = select(await collect({ inputsDir: dir, skipLocalSkills: true }));
  assert.equal(chosen.projects.length, 0);
  assert.equal(chosen.conversations.length, 0);
  assert.equal(skipped.length, 2);
});

test('build reports coverage, carries warnings and refuses an empty bundle', async () => {
  const dir = await workspace();
  const projects = path.join(dir, 'projects.json');
  await writeFile(projects, JSON.stringify([{ id: 'p1', name: 'Client' }]));
  const { stdout } = await run('node', ['scripts/aiwp-migrate.mjs', 'build', '--export', projects, '--no-local-skills', '--out', path.join(dir, 'bundle.json')]);
  const result = JSON.parse(stdout);
  assert.equal(result.counts.projects, 1);
  assert.equal(result.coverage.verifiedAtDestination, false);
  assert.match(result.coverage.warnings[0], /Cowork/);
  await assert.rejects(run('node', ['scripts/aiwp-migrate.mjs', 'build', '--no-local-skills', '--out', path.join(dir, 'empty.json')]), /No selected data/);
});
