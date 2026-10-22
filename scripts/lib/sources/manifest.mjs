import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Categories the index lists that the migration does not use. */
export const UNUSED_CATEGORIES = new Map([['light_metadata', 'account details, not migrated']]);
export const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MANIFEST_NAME = /^member-manifest-.*\.json$/;

/** True for the index a claude.ai "Export data" request downloads (`member-manifest-….json`). */
export const isManifest = (raw) => Array.isArray(raw?.data_files) && typeof raw.created_at === 'string';

/** The data files the migration needs, with their names and categories (links stay inside). */
export const neededFiles = (manifest) =>
  manifest.data_files.filter((file) => typeof file?.filename === 'string' && !UNUSED_CATEGORIES.has(file.category));

/** Only claude.ai export download links are ever opened. */
export const isExportLink = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'claude.ai' && url.pathname.startsWith('/export/');
  } catch {
    return false;
  }
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Browsers rename repeated downloads (`name (1).zip`); returns a matcher for every variant of `filename`. */
const variants = (filename) => {
  const ext = path.extname(filename);
  const base = escape(filename.slice(0, filename.length - ext.length));
  return new RegExp(`^${base}(?: \\(\\d+\\)|-\\d+)?${escape(ext)}$`);
};

/**
 * Finds the newest complete download of `filename` in `dir` made after `since`,
 * so an older export's file with the same name is never mistaken for this one.
 */
export const resolveDownloaded = async (dir, filename, since) => {
  const pattern = variants(filename);
  const names = (await readdir(dir)).filter((name) => pattern.test(name));
  const candidates = await Promise.all(
    names.map(async (name) => ({ file: path.join(dir, name), info: await stat(path.join(dir, name)) })),
  );
  const fresh = candidates
    .filter(({ info }) => info.isFile() && info.size > 0 && Math.max(info.mtimeMs, info.birthtimeMs) >= since)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  return fresh[0]?.file ?? null;
};

/** Every export index in `dir`, newest first. */
export const findManifests = async (dir) => {
  const names = (await readdir(dir)).filter((name) => MANIFEST_NAME.test(name));
  const found = await Promise.all(names.map(async (name) => ({ file: path.join(dir, name), info: await stat(path.join(dir, name)) })));
  return found.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).map(({ file }) => file);
};

/** Export creation time in ms; downloads older than this belong to another export. */
export const manifestTime = (manifest) => {
  const time = Date.parse(manifest.created_at);
  if (Number.isNaN(time)) throw new Error('The export index has no valid creation time; request a new export.');
  return time;
};
