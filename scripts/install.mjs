#!/usr/bin/env node
/**
 * dsh-creativity-nudge 一键安装。
 *   node scripts/install.mjs [--profile desktop] [--home <DSH_HOME>] [--link] [--dry-run] [--json]
 *   node scripts/install.mjs --uninstall
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_NAME, addBundle, parseArgv, placePackage, readJson, removePackage, removeBundle,
  resolveHome, resolveProfileDir, resolveProfileName, timestamp,
} from './profile-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(here, '..');

const options = parseArgv(process.argv.slice(2));
const home = resolveHome(options);
const profile = resolveProfileName(options);
const profileDir = resolveProfileDir(options);
const manifestPath = join(profileDir, 'package.json');
const dryRun = options['dry-run'] === true;
const asJson = options.json === true;
const uninstall = options.uninstall === true;

const report = { home, profile, profileDir, sourceDir, dryRun, uninstall, steps: [], ok: false, warnings: [] };

if (!existsSync(profileDir) || !existsSync(manifestPath)) {
  process.stderr.write('档案不存在：' + profileDir + '\n');
  process.exit(1);
}

const manifest = readJson(manifestPath);
if (!manifest || !manifest.dsh) report.warnings.push('这个 package.json 里没有 dsh 段，可能不是 DSH 档案');

if (dryRun) {
  report.steps.push({
    action: uninstall ? 'remove-package' : 'place-package',
    target: join(profileDir, 'node_modules', PACKAGE_NAME),
    mode: options.link ? 'link' : 'copy',
  });
  report.steps.push({ action: uninstall ? 'remove-bundle' : 'add-bundle', manifest: manifestPath, bundle: PACKAGE_NAME });
  report.ok = true;
} else if (uninstall) {
  report.steps.push({ action: 'remove-package', removed: removePackage(profileDir) });
  const result = removeBundle(manifestPath, timestamp());
  report.steps.push({ action: 'remove-bundle', changed: result.changed });
  report.ok = true;
} else {
  const placed = placePackage(sourceDir, profileDir, { link: options.link === true });
  report.steps.push({ action: 'place-package', target: placed.target, mode: placed.mode });
  const bundleResult = addBundle(manifestPath, timestamp());
  report.steps.push({
    action: 'add-bundle',
    manifest: manifestPath,
    changed: bundleResult.changed,
    backup: bundleResult.changed ? manifestPath + '.bak-' + timestamp() : null,
  });
  report.ok = true;
}

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const lines = ['', '💡  dsh-creativity-nudge ' + (uninstall ? '卸载' : '安装') + (dryRun ? '（预演，未写入）' : '')];
  lines.push('   DSH_HOME : ' + home);
  lines.push('   档案     : ' + profile);
  for (const step of report.steps) {
    if (step.action === 'place-package') lines.push('   · 已' + (step.mode === 'link' ? '链接' : '复制') + '包 → ' + step.target);
    if (step.action === 'remove-package') lines.push('   · 移除包 → ' + (step.removed ? '已删除' : '本来就不存在'));
    if (step.action === 'add-bundle') lines.push(step.changed === false ? '   · bundles 里已经有了，跳过' : '   · 已追加到 dsh.profile.bundles');
    if (step.action === 'remove-bundle') lines.push(step.changed ? '   · 已从 dsh.profile.bundles 摘除' : '   · bundles 里本来就没有');
  }
  for (const warning of report.warnings) lines.push('   ⚠ ' + warning);
  if (report.ok && !dryRun) {
    lines.push('');
    if (uninstall) {
      lines.push('   下一步：完全退出并重开 DSH。');
    } else {
      lines.push('   插件默认 enabled: false —— 装上不生效。');
      lines.push('   开启：编辑 ' + join(profileDir, 'cordis.patch.yml') + '，或在包内改 cordis.patch.yml 后重装。');
      lines.push('   下一步：完全退出并重开 DSH。');
    }
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}
