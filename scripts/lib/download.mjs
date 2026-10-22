import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  UNUSED_CATEGORIES,
  LINK_LIFETIME_MS,
  isManifest,
  neededFiles,
  isExportLink,
  resolveDownloaded,
  findManifests,
  manifestTime,
} from './sources/manifest.mjs';

const PARTIAL = /\.(?:crdownload|download|part)$/;
const POLL_MS = 1000;

const OPENERS = {
  darwin: (url) => ['open', [url]],
  win32: (url) => ['cmd', ['/c', 'start', '""', url]],
};

/** Opens `url` in the user's default browser, which downloads it with their existing claude.ai login. */
export const openInBrowser = (url) => {
  const [command, args] = (OPENERS[process.platform] ?? ((link) => ['xdg-open', [link]]))(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A browser still writing `file` leaves a sibling like `file.crdownload`. */
const finished = async (file) => {
  const names = await readdir(path.dirname(file));
  const base = path.basename(file);
  return !names.some((name) => name.startsWith(base) && PARTIAL.test(name));
};

const arrived = async (folder, entry, since) => {
  const file = await resolveDownloaded(folder, entry.filename, since);
  return Boolean(file) && (await finished(file));
};

/**
 * Downloads every archive an export index lists (except unused categories) by
 * opening its link in the browser, then waits for the files. Links are never
 * returned or printed; the result names files only.
 */
export const downloadExport = async ({ dir, manifestPath, waitSeconds = 180, opener = openInBrowser, now = Date.now() } = {}) => {
  const indexes = manifestPath ? [manifestPath] : await findManifests(dir);
  const file = indexes[0];
  if (!file) {
    return { status: 'no-index', next: 'No export index (member-manifest-….json) was found. In claude.ai open Settings → Privacy → Export data, wait for the download, then run this again.' };
  }
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (!isManifest(manifest)) throw new Error(`${path.basename(file)} is not a claude.ai export index`);
  const folder = path.dirname(file);
  const since = manifestTime(manifest);
  const files = neededFiles(manifest);
  const skipped = manifest.data_files
    .filter((entry) => UNUSED_CATEGORIES.has(entry.category))
    .map((entry) => `${entry.filename} (${UNUSED_CATEGORIES.get(entry.category)})`);
  const present = await Promise.all(files.map((entry) => resolveDownloaded(folder, entry.filename, since)));
  const pending = files.filter((_, index) => !present[index]);
  const base = {
    manifest: file,
    createdAt: manifest.created_at,
    alreadyPresent: files.filter((_, index) => present[index]).map((entry) => entry.filename),
    skipped,
    ...(indexes.length > 1
      ? { notice: `${indexes.length} export indexes were found; the newest is used. Files downloaded after it from an older export can be mistaken for its own, so keep only one export in this folder.` }
      : {}),
  };

  if (pending.length > 0 && now - since > LINK_LIFETIME_MS) {
    return { ...base, status: 'expired', missing: pending.map((entry) => entry.filename), next: 'The download links in this export are older than 24 hours. In claude.ai open Settings → Privacy → Export data again, then run this again.' };
  }
  const invalid = pending.filter((entry) => !isExportLink(entry.export_url));
  if (invalid.length > 0) {
    throw new Error(`Refusing to open links that are not claude.ai export downloads: ${invalid.map((entry) => entry.filename).join(', ')}`);
  }
  for (const entry of pending) {
    await opener(entry.export_url);
  }

  const deadline = Date.now() + waitSeconds * 1000;
  let missing = pending;
  while (missing.length > 0 && Date.now() < deadline) {
    await pause(POLL_MS);
    const found = await Promise.all(missing.map((entry) => arrived(folder, entry, since)));
    missing = missing.filter((_, index) => !found[index]);
  }
  const downloaded = pending.filter((entry) => !missing.includes(entry)).map((entry) => entry.filename);
  if (missing.length === 0) {
    return { ...base, status: 'complete', downloaded, missing: [], next: `Pass --export "${file}" to scan and build.` };
  }
  return {
    ...base,
    status: 'incomplete',
    downloaded,
    missing: missing.map((entry) => entry.filename),
    next: 'Some files did not arrive. Check the browser for a download prompt or an error page. Used or expired links stop working; if so, request a new export in Settings → Privacy → Export data.',
  };
};
