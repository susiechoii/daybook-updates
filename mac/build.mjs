// Builds the Mac installers, Daybook-Mac-AppleSilicon.dmg and Daybook-Mac-Intel.dmg, from the newest
// published update bundle. Runs on a GitHub Mac runner in the daybook-updates repo
// (.github/workflows/mac.yml there); scripts/release.mjs copies this file to mac/build.mjs.
// It needs macOS tools (ditto, sips, iconutil, codesign, hdiutil), so it can't run on Windows.
// Usage, from the daybook-updates folder: node mac/build.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit' });
const site = process.cwd();
const out = path.resolve(process.argv[2] || 'dist');
const work = path.resolve('mac-work');
const { electron } = JSON.parse(fs.readFileSync(path.join(site, 'mac', 'config.json'), 'utf8'));
const latest = JSON.parse(fs.readFileSync(path.join(site, 'latest.json'), 'utf8'));
const { version, files } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, latest.bundle))));
if (version !== latest.version) throw new Error(`Bundle is ${version}, latest.json says ${latest.version}`);
// Versions before the Mac support can't update themselves on a Mac, so a Mac copy of one would be stuck there.
if (!Buffer.from(files['main/updater.mjs'], 'base64').toString().includes('darwin')) {
  throw new Error(`Daybook ${version} predates Mac support. Publish a newer version with "npm run release" first.`);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

// The app icon, from the 512px icon.png in the bundle.
const iconset = path.join(work, 'Daybook.iconset');
fs.mkdirSync(iconset);
fs.writeFileSync(path.join(work, 'icon.png'), Buffer.from(files['assets/icon.png'], 'base64'));
for (const s of [16, 32, 128, 256, 512]) {
  run('sips', '-z', String(s), String(s), path.join(work, 'icon.png'), '--out', path.join(iconset, `icon_${s}x${s}.png`));
  if (s < 512) run('sips', '-z', String(s * 2), String(s * 2), path.join(work, 'icon.png'), '--out', path.join(iconset, `icon_${s}x${s}@2x.png`));
}
fs.copyFileSync(path.join(work, 'icon.png'), path.join(iconset, 'icon_512x512@2x.png'));
const icns = path.join(work, 'Daybook.icns');
run('iconutil', '-c', 'icns', iconset, '-o', icns);

for (const [arch, label] of [['arm64', 'AppleSilicon'], ['x64', 'Intel']]) {
  const dir = path.join(work, arch);
  fs.mkdirSync(dir);
  const zip = path.join(dir, 'electron.zip');
  run('curl', '-fsSL', '-o', zip, `https://github.com/electron/electron/releases/download/v${electron}/electron-v${electron}-darwin-${arch}.zip`);
  run('ditto', '-x', '-k', zip, dir); // ditto keeps the framework's symlinks, which unzip tools can break

  const appDir = path.join(dir, 'Daybook.app');
  fs.renameSync(path.join(dir, 'Electron.app'), appDir);
  const contents = path.join(appDir, 'Contents');
  fs.renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', 'Daybook'));
  const plist = path.join(contents, 'Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleExecutable: 'Daybook', CFBundleName: 'Daybook', CFBundleDisplayName: 'Daybook',
    CFBundleIdentifier: 'com.susie.daybook', CFBundleShortVersionString: version, CFBundleVersion: version,
  })) run('plutil', '-replace', key, '-string', value, plist);
  fs.copyFileSync(icns, path.join(contents, 'Resources', 'electron.icns'));
  fs.rmSync(path.join(contents, 'Resources', 'default_app.asar'), { force: true });

  // The app code goes where Daybook's updater expects it: Contents/Resources/app.
  for (const [rel, b64] of Object.entries(files)) {
    const full = path.join(contents, 'Resources', 'app', ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
  }

  // No Apple Developer account, so it's signed "ad hoc": enough for Apple Silicon Macs to run it,
  // though macOS still asks people to allow it the first time (see the site's install steps).
  run('codesign', '--force', '--deep', '--sign', '-', appDir);

  // The disk image shows Daybook next to a shortcut to Applications, to drag it across.
  const stage = path.join(dir, 'dmg');
  fs.mkdirSync(stage);
  run('ditto', appDir, path.join(stage, 'Daybook.app'));
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmg = path.join(out, `Daybook-Mac-${label}.dmg`);
  run('hdiutil', 'create', '-volname', 'Daybook', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg);
  console.log(`Built ${dmg} (${(fs.statSync(dmg).size / 1e6).toFixed(0)} MB), Daybook ${version} on Electron ${electron}`);
}
