import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_SKILL = 50;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.mov', '.pyc',
]);

export const defaultSkillDirs = () => [path.join(os.homedir(), '.claude', 'skills')];

/** Skill origin from the desktop sync manifest: the user's own, provided by their team, or a Claude built-in. */
const ORIGINS = { custom: 'mine', plugin: 'team', anthropic: 'claude', 'anthropic-example': 'claude' };

const readOrigins = async (dir) => {
  const manifest = await readFile(path.join(dir, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  const skills = Array.isArray(manifest?.skills) ? manifest.skills : [];
  return new Map(skills.filter((skill) => typeof skill?.name === 'string').map((skill) => [skill.name, ORIGINS[skill.source] ?? 'mine']));
};

/** A root plus the desktop app's synced skill folders inside it (`synced/<organization>/`). */
const expandRoot = async (root) => {
  const synced = path.join(root, 'synced');
  const buckets = await readdir(synced, { withFileTypes: true }).catch(() => []);
  return [root, ...buckets.filter((entry) => entry.isDirectory()).map((entry) => path.join(synced, entry.name))];
};

const frontmatter = (content) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z_-]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '').trim()]),
  );
};

const walk = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !SKIP_DIRS.has(entry.name))
      .map((entry) => {
        const full = path.join(current, entry.name);
        return entry.isDirectory() ? walk(root, full) : [full];
      }),
  );
  return nested.flat();
};

const readSupportingFiles = async (root) => {
  const all = (await walk(root)).filter(
    (file) => path.basename(file) !== 'SKILL.md' && !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  const files = await Promise.all(
    all.slice(0, MAX_FILES_PER_SKILL).map(async (file) => {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) {
        return null;
      }
      const content = await readFile(file, 'utf8');
      return content.includes('\0') ? null : { path: path.relative(root, file).split(path.sep).join('/'), content };
    }),
  );
  return files.filter(Boolean);
};

const readSkill = async (dir) => {
  const content = await readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (content === null) {
    return null;
  }
  const meta = frontmatter(content);
  const name = meta.name || path.basename(dir);
  return { id: name, name, description: meta.description || name, content, files: await readSupportingFiles(dir) };
};

/**
 * Finds skills (folders containing SKILL.md) in the given roots, including desktop-synced skills,
 * labelled with their origin. The first skill of a name wins.
 */
export const scanSkills = async (roots) => {
  const found = new Map();
  for (const root of (await Promise.all(roots.map(expandRoot))).flat()) {
    const [names, origins] = await Promise.all([readdir(root).catch(() => []), readOrigins(root)]);
    const skills = await Promise.all(names.filter((name) => name !== 'synced').map((name) => readSkill(path.join(root, name))));
    for (const skill of skills.filter(Boolean)) {
      if (!found.has(skill.name)) {
        found.set(skill.name, { ...skill, origin: origins.get(skill.name) ?? origins.get(path.basename(skill.id)) ?? 'mine' });
      }
    }
  }
  return [...found.values()];
};
