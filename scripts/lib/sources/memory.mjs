import { open, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const INDEX_FILE = 'MEMORY.md';
const HEAD_BYTES = 64 * 1024;
const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;
const SCRATCH = /scratch-workspaces|\/scratch-\d{4}-\d{2}-\d{2}-/;

export const defaultProjectsDir = () => path.join(os.homedir(), '.claude', 'projects');

const subdirs = async (dir) =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort();

const readHead = async (file) => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

/** Human label for a Claude Code project folder: the folder name it was opened in, from one of its transcripts. */
const projectLabel = async (dir) => {
  const transcript = (await readdir(dir).catch(() => [])).find((name) => name.endsWith('.jsonl'));
  const cwd = transcript ? JSON.parse(`"${(await readHead(path.join(dir, transcript))).match(CWD)?.[1] ?? ''}"`) : '';
  if (SCRATCH.test(cwd || dir)) return 'Claude desktop';
  return cwd ? path.basename(cwd) : path.basename(dir).replace(/^-Users-[^-]+-/, '');
};

/** Splits a memory file into its flat frontmatter fields and its body. */
const parse = (text) => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields = Object.fromEntries(
    (match?.[1] ?? '')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z_-]+):\s*(.+)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '').trim()]),
  );
  return { fields, body: (match ? text.slice(match[0].length) : text).trim() };
};

/**
 * Reads Claude Code memory files (`<projects>/<project>/memory/*.md`, not the MEMORY.md index),
 * one memory per file, verbatim, labelled with the project folder it belongs to.
 */
export const scanMemories = async (projectsDir = defaultProjectsDir()) => {
  const memories = [];
  const used = new Map();
  const uniqueId = (base) => {
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };
  for (const dir of await subdirs(projectsDir)) {
    const memoryDir = path.join(dir, 'memory');
    const files = (await readdir(memoryDir).catch(() => [])).filter((name) => name.endsWith('.md') && name !== INDEX_FILE).sort();
    if (files.length === 0) continue;
    const label = await projectLabel(dir);
    for (const file of files) {
      const { fields, body } = parse(await readFile(path.join(memoryDir, file), 'utf8'));
      const value = body || fields.description || '';
      if (!value) continue;
      const name = fields.name || path.basename(file, '.md');
      memories.push({ id: uniqueId(`${label}/${path.basename(file, '.md')}`.slice(0, 290)), key: `${label} · ${name}`, value });
    }
  }
  return memories;
};
