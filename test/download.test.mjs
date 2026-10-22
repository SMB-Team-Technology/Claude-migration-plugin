import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readExport } from '../scripts/lib/sources/export.mjs';
import { collect } from '../scripts/lib/bundle.mjs';
import { downloadExport } from '../scripts/lib/download.mjs';
import { makeZip, sampleConversations } from './helpers.mjs';

const createdAt = '2026-10-22T00:18:23.345767+00:00';
const created = Date.parse(createdAt);
const link = (token) => `https://claude.ai/export/00000000-0000-4000-8000-000000000000/download/${token}`;
const projectId = '00000000-0000-4000-8000-0000000000bb';

const manifest = (urls = {}) => ({
  instructions: 'Download each file using the export_url.',
  created_at: createdAt,
  total_files: 4,
  version: '1.0',
  data_files: [
    { category: 'light_metadata', part: 0, filename: 'light_metadata-000.zip', export_url: link('meta') },
    { category: 'projects', part: 0, filename: 'projects-000.zip', export_url: urls.projects ?? link('projects') },
    { category: 'frames', part: 0, filename: 'frames-000.zip', export_url: link('frames') },
    { category: 'conversations', part: 0, filename: 'conversations-000.zip', export_url: link('conversations') },
  ],
});

const archives = {
  'projects-000.zip': makeZip({ [`projects/${projectId}.json`]: JSON.stringify({ uuid: projectId, name: 'Client', prompt_template: '', docs: [] }) }),
  'conversations-000.zip': makeZip({ 'conversations.json': JSON.stringify(sampleConversations) }),
  'frames-000.zip': makeZip({
    'artifacts/a1/artifact.json': JSON.stringify({ id: 'a1', kind: 'artifact', active_version: 'v2', versions: [{ id: 'v1', title: 'Old title' }, { id: 'v2', title: 'Lease summary' }] }),
    'artifacts/a2/artifact.json': JSON.stringify({ id: 'a2', kind: 'page', versions: [{ id: 'v1', title: 'Team handbook' }] }),
    'artifacts/a3/artifact.json': JSON.stringify({ id: 'a3', kind: 'artifact', versions: [{ id: 'v1', title: 'Untitled' }] }),
  }),
};

const folderWithIndex = async (data = manifest()) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'export-index-'));
  const index = path.join(dir, 'member-manifest-org-1.json');
  await writeFile(index, JSON.stringify(data));
  return { dir, index };
};

const fakeBrowser = (dir, opened, names = {}) => async (url) => {
  opened.push(url);
  const filename = Object.keys(archives).find((name) => url.endsWith(`/${name.split('-')[0]}`));
  await writeFile(path.join(dir, names[filename] ?? filename), archives[filename]);
};

test('reads every archive an export index lists, skipping account metadata, and inventories published artifacts', async () => {
  const { dir, index } = await folderWithIndex();
  for (const [name, data] of Object.entries(archives)) await writeFile(path.join(dir, name), data);
  const data = await readExport(index);
  assert.equal(data.projects[0].name, 'Client');
  assert.equal(data.conversations.length, 2);
  assert.deepEqual(data.artifactInventory.map((item) => [item.title, item.kind, item.versions]), [
    ['Lease summary', 'artifact', 2], ['Team handbook', 'page', 1], ['Untitled', 'artifact', 1],
  ]);
});

test('an older download with the same name is not mistaken for this export', async () => {
  const { dir, index } = await folderWithIndex();
  for (const [name, data] of Object.entries(archives)) await writeFile(path.join(dir, name), data);
  const before = new Date(created - 60_000);
  await utimes(path.join(dir, 'frames-000.zip'), before, before);
  await assert.rejects(readExport(index), /not downloaded yet: frames-000\.zip/);
  await writeFile(path.join(dir, 'frames-000 (1).zip'), archives['frames-000.zip']);
  assert.equal((await readExport(index)).artifactInventory.length, 3);
});

test('download opens only missing export links and never reports the links', async () => {
  const { dir } = await folderWithIndex();
  await writeFile(path.join(dir, 'projects-000.zip'), archives['projects-000.zip']);
  const opened = [];
  const result = await downloadExport({ dir, opener: fakeBrowser(dir, opened, { 'frames-000.zip': 'frames-000 (1).zip' }), now: created + 1000, waitSeconds: 5 });
  assert.equal(result.status, 'complete');
  assert.deepEqual(opened, [link('frames'), link('conversations')]);
  assert.deepEqual(result.alreadyPresent, ['projects-000.zip']);
  assert.deepEqual(result.downloaded, ['frames-000.zip', 'conversations-000.zip']);
  assert.deepEqual(result.skipped, ['light_metadata-000.zip (account details, not migrated)']);
  assert.doesNotMatch(JSON.stringify(result), /https:|download\//);
  assert.equal(result.notice, undefined);
});

test('several export indexes use the newest and say so', async () => {
  const { dir } = await folderWithIndex();
  const older = path.join(dir, 'member-manifest-org-0.json');
  await writeFile(older, JSON.stringify(manifest()));
  const past = new Date(created - 60_000);
  await utimes(older, past, past);
  for (const [name, data] of Object.entries(archives)) await writeFile(path.join(dir, name), data);
  const result = await downloadExport({ dir, opener: async () => assert.fail('nothing to open'), now: created });
  assert.equal(path.basename(result.manifest), 'member-manifest-org-1.json');
  assert.match(result.notice, /2 export indexes were found; the newest is used/);
});

test('expired links ask for a new export instead of opening anything', async () => {
  const { dir } = await folderWithIndex();
  const opened = [];
  const result = await downloadExport({ dir, opener: fakeBrowser(dir, opened), now: created + 25 * 60 * 60 * 1000 });
  assert.equal(result.status, 'expired');
  assert.equal(opened.length, 0);
  assert.match(result.next, /Export data again/);
});

test('links outside claude.ai exports are refused', async () => {
  const { dir } = await folderWithIndex(manifest({ projects: 'https://example.test/export/x' }));
  await assert.rejects(downloadExport({ dir, opener: async () => {}, now: created }), /Refusing to open links.*projects-000\.zip/);
});

test('files that never arrive are reported as incomplete', async () => {
  const { dir } = await folderWithIndex();
  const result = await downloadExport({ dir, opener: async () => {}, now: created, waitSeconds: 0 });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.missing, ['projects-000.zip', 'frames-000.zip', 'conversations-000.zip']);
});

test('published artifacts the bundle lacks are reported, with Docs guidance', async () => {
  const { dir, index } = await folderWithIndex();
  for (const [name, data] of Object.entries(archives)) await writeFile(path.join(dir, name), data);
  const data = await collect({ exportPath: index, skipLocalSkills: true });
  assert.deepEqual(data.sourceWarnings, [
    'The export lists 3 published artifact(s); 1 matched collected artifacts.',
    'Published Docs page "Team handbook" was not collected; export it through the Docs connector.',
    'Published artifact "Untitled" was not collected.',
  ]);
});
