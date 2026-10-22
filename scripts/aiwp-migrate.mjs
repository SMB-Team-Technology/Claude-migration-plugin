#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CATEGORIES, collect, summarize, select, makeBundle, validateBundle } from './lib/bundle.mjs';

const USAGE = `Usage:
  aiwp-migrate.mjs scan  [--export <zip|dir|json>] [--inputs <dir>] [--skills-dir <dir>]...
  aiwp-migrate.mjs build --out <file> [--categories a,b] [--exclude id,id] [--allow-flagged]
                         [--export ...] [--inputs ...] [--skills-dir ...]
  aiwp-migrate.mjs validate <file>

Categories: ${CATEGORIES.join(', ')}`;

const options = {
  export: { type: 'string' },
  inputs: { type: 'string' },
  'skills-dir': { type: 'string', multiple: true },
  'no-local-skills': { type: 'boolean' },
  categories: { type: 'string' },
  exclude: { type: 'string' },
  'allow-flagged': { type: 'boolean' },
  out: { type: 'string' },
};

const csv = (value) => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : undefined);

const sourcesFrom = (values) => ({
  exportPath: values.export,
  inputsDir: values.inputs,
  skillDirs: values['skills-dir'],
  skipLocalSkills: values['no-local-skills'],
});

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const coverage = (values, collected) => ({
  verifiedAtDestination: false,
  warnings: [
    'Cloud exports do not establish coverage of local Cowork projects or sessions. Stage local data from verified sources separately.',
    'Project files, attachments and connectors are not migrated. Projects contain instructions and text context only.',
    ...CATEGORIES.filter((category) => collected[category].length === 0)
      .map((category) => `No ${category} collected; this is not proof that the source account has none.`),
    ...collected.projects.flatMap((project) => project.migrationWarnings ?? []),
    ...collected.conversations.flatMap((chat) => (chat.migrationWarnings ?? []).map((warning) => `${chat.title}: ${warning}`)),
  ],
  sources: { export: values.export ?? null, staged: values.inputs ?? null },
});

const commands = {
  async scan(values) {
    const collected = await collect(sourcesFrom(values));
    print({ categories: summarize(collected), coverage: coverage(values, collected) });
  },

  async build(values) {
    if (!values.out) {
      throw new Error('--out is required');
    }
    const categories = csv(values.categories) ?? CATEGORIES;
    const unknown = categories.filter((category) => !CATEGORIES.includes(category));
    if (unknown.length > 0) {
      throw new Error(`Unknown categories: ${unknown.join(', ')}`);
    }
    const collected = await collect(sourcesFrom(values));
    const report = coverage(values, collected);
    const { chosen, skipped } = select(collected, {
      categories,
      exclude: csv(values.exclude),
      allowFlagged: values['allow-flagged'],
    });
    if (!CATEGORIES.some((category) => chosen[category].length > 0)) {
      throw new Error('No selected data to export. Check payloads, staged sources and credential exclusions.');
    }
    const bundle = validateBundle({ ...makeBundle(chosen), migrationWarnings: report.warnings });
    const out = path.resolve(values.out);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(bundle), { mode: 0o600 });
    print({
      file: out,
      counts: Object.fromEntries(CATEGORIES.map((category) => [category, chosen[category].length])),
      skippedForCredentials: skipped,
      coverage: report,
      status: 'Bundle created; destination import is not verified',
    });
  },

  async validate(_values, positionals) {
    const file = positionals[0];
    if (!file) {
      throw new Error('validate needs a file path');
    }
    const bundle = validateBundle(JSON.parse(await readFile(file, 'utf8')));
    print({ valid: true, counts: Object.fromEntries(CATEGORIES.map((c) => [c, bundle[c]?.length ?? 0])) });
  },
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!commands[command]) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(command ? 2 : 0);
  }
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true });
  await commands[command](values, positionals);
};

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exit(1);
});
