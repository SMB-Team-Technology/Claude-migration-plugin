import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readExport, toBundleConversation } from '../scripts/lib/sources/export.mjs';
import { collect, select } from '../scripts/lib/bundle.mjs';
import { makeZip } from './helpers.mjs';

const uuid = '00000000-0000-4000-8000-000000000001';
const project = { uuid, name: 'Migration test', description: 'Migration', prompt_template: '', docs: [], creator: { full_name: 'Synthetic user' } };

test('loads individual project JSON directly, in folders and in zip archives', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fidelity-'));
  const nested = path.join(dir, 'projects');
  await mkdir(nested);
  const file = path.join(nested, `${uuid}.json`);
  await writeFile(file, JSON.stringify(project));
  await writeFile(path.join(dir, 'users.json'), '[{"email_address":"not-imported@example.test"}]');
  const zip = path.join(tmpdir(), `fidelity-${Date.now()}.zip`);
  await writeFile(zip, makeZip({ [`projects/${uuid}.json`]: JSON.stringify(project), 'users.json': '[]' }));
  for (const exportPath of [file, dir, zip]) {
    const data = await collect({ exportPath, skipLocalSkills: true });
    assert.equal(data.projects[0].description, 'Migration');
    assert.equal(data.projects[0].instructions, '');
    assert.equal(data.projects[0].context, '');
    assert.equal(data.projects[0].creator, undefined);
  }
  await writeFile(path.join(dir, 'projects.json'), JSON.stringify([project]));
  await assert.rejects(readExport(dir), /duplicate project/);
});

test('renders display steps in order without replaying tools or duplicating results', () => {
  const chat = toBundleConversation({ uuid: 'chat-1', name: 'Card example', project_uuid: null, chat_messages: [
    { sender: 'human', text: 'Help' },
    { sender: 'assistant', text: 'This block is not supported on your current device yet.', content: [
      { type: 'thinking', thinking: '', thinking_hidden: true, summaries: [{ summary: 'Not full thinking' }] },
      { type: 'text', text: 'Before' },
      { type: 'tool_use', name: 'step_card_display_v0', input: { summary: 'Setup', steps: [
        { title: 'First', description: 'Open settings' }, { title: 'Second', description: 'Confirm choice' },
      ] } },
      { type: 'tool_result', name: 'step_card_display_v0', content: [{ type: 'text', text: 'DUPLICATE JSON' }] },
      { type: 'tool_result', name: 'web_fetch', content: [{ type: 'knowledge', text: 'Fetched page' }] },
      { type: 'text', text: 'After', citations: [{ details: { url: 'https://example.test' } }] },
      { type: 'image', source: 'unsupported' },
    ] },
  ] });
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.projectId, undefined);
  assert.equal(chat.messages[1].thinking, undefined);
  const text = chat.messages[1].text;
  assert.ok(text.indexOf('Before') < text.indexOf('Open settings'));
  assert.ok(text.indexOf('Open settings') < text.indexOf('Confirm choice'));
  assert.ok(text.indexOf('Confirm choice') < text.indexOf('After'));
  assert.equal(text.split('Open settings').length - 1, 1);
  assert.doesNotMatch(text, /DUPLICATE|Fetched page|Not full thinking|not supported/);
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('thinking')));
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('Citation')));
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('Tool-result')));
  assert.ok(chat.migrationWarnings.some((warning) => warning.includes('Unsupported')));
});

test('malformed cards warn instead of inventing content', () => {
  const chat = toBundleConversation({ uuid: 'c', chat_messages: [{ sender: 'assistant', content: [
    { type: 'text', text: 'Available text' },
    { type: 'tool_use', name: 'step_card_display_v0', input: { steps: [{ title: 'Missing description' }] } },
  ] }] });
  assert.equal(chat.messages[0].text, 'Available text');
  assert.match(chat.migrationWarnings[0], /malformed/);
});

test('description credentials are excluded by the default secret scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'description-'));
  const file = path.join(dir, `${uuid}.json`);
  await writeFile(file, JSON.stringify({ ...project, description: 'sk-ant-abcdefghijklmnopqrstuvwxyz123456' }));
  const data = await collect({ exportPath: file, skipLocalSkills: true });
  assert.equal(select(data).chosen.projects.length, 0);
});
