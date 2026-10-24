/**
 * 安装/卸载共用的档案读写工具（复制自 dsh-command-guard，同一套约定）。
 *
 * 关键事实：<profile>/cordis.yml 每次启动重新生成，真正的输入是
 *   package.json 的 dsh.profile.bundles（按顺序叠加每个包的 dsh.bundle.patch）
 *   → cordis.patch.yml（本档案用户层）→ $DSH_HOME/cordis.patch.yml
 *
 * 所以安装 = 把包放进 <profile>/node_modules/ + 追加进 bundles。
 *
 * @module dsh-creativity-nudge/scripts/profile-io
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PACKAGE_NAME = 'dsh-creativity-nudge';

/** 读不到 package.json 的 files 字段时的兜底清单。 */
const SHIP_FILES = ['package.json', 'cordis.patch.yml', 'lib', 'scripts', 'tests', 'README.md', 'LICENSE'];

export function shipFiles(sourceDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
    if (Array.isArray(manifest.files) && manifest.files.length > 0) {
      const list = manifest.files.filter((entry) => typeof entry === 'string' && !entry.includes('*'));
      if (!list.includes('package.json')) list.unshift('package.json');
      return list;
    }
  } catch { /* 落到兜底清单 */ }
  return SHIP_FILES;
}

export function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const eq = token.indexOf('=');
    if (eq > 0) { out[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
}

export function resolveHome(options = {}) {
  const fromFlag = typeof options.home === 'string' ? options.home : undefined;
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : undefined;
  return resolve(fromFlag ?? fromEnv ?? join(homedir(), '.dsh'));
}

export function resolveProfileName(options = {}) {
  const fromFlag = typeof options.profile === 'string' ? options.profile : undefined;
  const fromEnv = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim().length > 0 ? process.env.DSH_PROFILE.trim() : undefined;
  return fromFlag ?? fromEnv ?? 'desktop';
}

export function resolveProfileDir(options = {}) {
  return join(resolveHome(options), 'profiles', resolveProfileName(options));
}

export function timestamp() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

export function readJson(file) {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value, backupSuffix) {
  if (backupSuffix) writeFileSync(file + '.bak-' + backupSuffix, readFileSync(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * 安全地删掉一棵目录树。
 *
 * fs.rmSync(path, { recursive: true }) 在 Windows 上遇到目录联接（junction）会**穿透**
 * 它去删真正的目标。所以先递归把树里所有链接单独 unlink 掉，再删剩下的实体目录。
 */
export function removeTree(path) {
  if (!existsSync(path) && !isLink(path)) return false;
  if (isLink(path)) { unlinkSync(path); return true; }
  let entries = [];
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { /* 读不动就直接删 */ }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (isLink(child)) {
      try { unlinkSync(child); } catch { /* ignore */ }
    } else if (entry.isDirectory()) {
      removeTree(child);
    }
  }
  rmSync(path, { recursive: true, force: true });
  return true;
}

export function placePackage(sourceDir, profileDir, options = {}) {
  const target = join(profileDir, 'node_modules', PACKAGE_NAME);
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  if (existsSync(target) || isLink(target)) removeTree(target);
  if (options.link) {
    symlinkSync(sourceDir, target, 'junction');
    return { target, mode: 'link' };
  }
  for (const entry of shipFiles(sourceDir)) {
    const from = join(sourceDir, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, entry), { recursive: true });
  }
  return { target, mode: 'copy' };
}

export function removePackage(profileDir) {
  const target = join(profileDir, 'node_modules', PACKAGE_NAME);
  if (!existsSync(target) && !isLink(target)) return false;
  removeTree(target);
  return true;
}

export function addBundle(manifestPath, backupSuffix) {
  const manifest = readJson(manifestPath);
  if (!manifest) throw new Error('找不到 profile 的 package.json：' + manifestPath);
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  if (bundles.includes(PACKAGE_NAME)) return { changed: false, bundles };
  bundles.push(PACKAGE_NAME);
  manifest.dsh.profile.bundles = bundles;
  writeJson(manifestPath, manifest, backupSuffix);
  return { changed: true, bundles };
}

export function removeBundle(manifestPath, backupSuffix) {
  const manifest = readJson(manifestPath);
  if (!manifest) return { changed: false };
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(PACKAGE_NAME)) return { changed: false };
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
  writeJson(manifestPath, manifest, backupSuffix);
  return { changed: true };
}
