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

/** Finds skills (folders containing SKILL.md) in the given roots; the first skill of a name wins. */
export const scanSkills = async (roots) => {
  const found = new Map();
  for (const root of roots) {
    const names = await readdir(root).catch(() => []);
    const skills = await Promise.all(names.map((name) => readSkill(path.join(root, name))));
    for (const skill of skills.filter(Boolean)) {
      if (!found.has(skill.name)) {
        found.set(skill.name, skill);
      }
    }
  }
  return [...found.values()];
};
