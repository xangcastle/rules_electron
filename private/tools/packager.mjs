import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Stages a project directory for electron-builder and runs it with the
// network blocked. Receives every path as a CLI argument from the Starlark
// rule. All external toolsets (Electron binary, AppImage, WinCodeSign,
// dmgbuild) come from Bazel-fetched, SHA-256-pinned caches passed via
// --electron_cache and --builder_cache; HOME and XDG cache directories are
// redirected into the staging area, so the run neither downloads nor writes
// outside the sandbox.

const argv = process.argv.slice(2);

function arg(name) {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : null;
}

function argList(name) {
  const out = [];
  const prefix = "--" + name + "=";
  for (const a of argv) {
    if (a.startsWith(prefix)) out.push(a.slice(prefix.length));
  }
  return out;
}

function extractArchive(archivePath, destinationDir, sevenZipRoot) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(destinationDir)}`, { stdio: "ignore" });
    return;
  }
  const sevenZip = resolveSevenZip(sevenZipRoot);
  execSync(`${JSON.stringify(sevenZip)} x -y -o${JSON.stringify(destinationDir)} ${JSON.stringify(archivePath)}`, { stdio: "ignore" });
}

function resolveSevenZip(sevenZipRoot) {
  if (!sevenZipRoot) {
    console.error("packager: 7za required but 7zip-bin is not among runner_tools");
    process.exit(2);
  }
  const platformDir = { darwin: "mac", linux: "linux", win32: "win" }[process.platform];
  const archDir = { arm64: "arm64", x64: "x64", ia32: "ia32" }[process.arch] || "x64";
  const candidate = path.join(sevenZipRoot, platformDir, archDir, "7za");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  console.error("packager: 7za not found at " + candidate);
  try {
    console.error("packager: sevenZipRoot contents:", fs.readdirSync(sevenZipRoot));
    console.error("packager: sevenZipRoot realpath:", fs.realpathSync(sevenZipRoot));
  } catch (e) {
    console.error("packager: sevenZipRoot unreadable:", e.message);
  }
  process.exit(2);
}

function hashUrlSafe(input, length = 6) {
  // electron-builder's deterministic URL hash (DJB2, unsigned, base-36).
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  hash >>>= 0;
  const out = hash.toString(36);
  return out.length >= length ? out.slice(0, length) : out.padStart(length, "0");
}

// builder-util's getPath7za chmods the 7zip-bin binaries unconditionally
// before every use, and the npm store it resolves from is a read-only
// action input on linux sandboxes (EROFS). Copies land inside the stage
// and every 7zip-bin resolution anchor electron-builder uses is aliased
// to them: builder-util resolves the module from its own package root,
// which does not coincide with electron-builder's for every version
// (26.4.1 vs 26.7.0 differ and both ship in this workspace).
function stageSevenZipBin(stage) {
  const electronBuilderId = require.resolve("electron-builder/package.json");
  const electronBuilderRequire = createRequire(electronBuilderId);
  let binSourceId;
  try {
    binSourceId = electronBuilderRequire.resolve("7zip-bin");
  } catch (e) {
    console.error("packager: 7zip-bin not resolvable from electron-builder: " + e.message);
    process.exit(2);
  }
  const bin = require(binSourceId);
  const patched = {};
  for (const [key, source] of Object.entries(bin)) {
    if (typeof source !== "string" || !fs.existsSync(source)) {
      patched[key] = source;
      continue;
    }
    const copy = path.join(stage, "7zip-bin", key, path.basename(source));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(source, copy);
    fs.chmodSync(copy, 0o755);
    patched[key] = copy;
  }
  const fake = new (require("module").Module)(binSourceId, null);
  fake.exports = patched;
  fake.loaded = true;

  const anchors = new Set([binSourceId]);
  for (const pkg of ["app-builder-lib", "builder-util"]) {
    try {
      anchors.add(electronBuilderRequire.resolve(pkg + "/package.json"));
    } catch (e) {}
  }
  const aliasedIds = new Set();
  for (const anchorId of anchors) {
    const anchorRequire = createRequire(anchorId);
    let id;
    try {
      id = anchorRequire.resolve("7zip-bin");
    } catch (e) {
      continue;
    }
    for (const key of new Set([id, fs.realpathSync(id)])) {
      require.cache[key] = fake;
      aliasedIds.add(key);
    }
  }

  for (const anchorId of anchors) {
    const anchorRequire = createRequire(anchorId);
    let seen;
    try {
      seen = anchorRequire("7zip-bin").path7za;
    } catch (e) {
      continue;
    }
    if (seen !== patched.path7za) {
      console.error("packager: the 7zip-bin alias did not take for the anchor " +
                    anchorId + "; electron-builder would chmod the read-only store copy");
      process.exit(2);
    }
  }
}

// app-builder's icon converter chmods its input; the default icons live
// in app-builder-lib's read-only templates, so when the platform config
// leaves the icon unset the conversion gets a staged copy instead.
function stageDefaultIcon(stage, platKey, config) {
  const template = {
    linux: "electron-linux/256x256.png",
    win: "electron-win/icon.ico",
  }[platKey];
  if (!template) return;
  const platConfig = config[platKey] || (config[platKey] = {});
  if (platConfig.icon) return;
  const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));
  let source;
  try {
    const libId = electronBuilderRequire.resolve("app-builder-lib/package.json");
    source = path.join(path.dirname(libId), "templates", ...template.split("/"));
  } catch (e) {
    return;
  }
  if (!fs.existsSync(source)) return;
  const copy = path.join(stage, "default-icon", path.basename(template));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o644);
  platConfig.icon = copy;
}

function stageBuilderCache(builderCacheFiles, stage, homeDir, sevenZipRoot) {
  const cacheDir = path.join(stage, "eb-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const relativeLayout of Object.keys(builderCacheFiles)) {
    const source = builderCacheFiles[relativeLayout];
    const toolRootName = relativeLayout.split("/")[0];
    const fileName = path.basename(relativeLayout);

    if (toolRootName.startsWith("dmg-builder@")) {
      // JS side (dmgbuild): <EBC>/<release>/<stem>-<suffix5>/ extracted with
      // the top-level archive directory stripped, plus a .complete marker
      // that short-circuits any download attempt.
      const baseUrl =
        "https://github.com/electron-userland/electron-builder-binaries/releases/download/";
      const suffix = hashUrlSafe(`${baseUrl}-${toolRootName}-${fileName}`, 5);
      const folderName = fileName.replace(/\.(tar\.gz|tgz)$/, "") + "-" + suffix;
      const extractDir = path.join(cacheDir, toolRootName, folderName);
      fs.mkdirSync(extractDir, { recursive: true });
      execSync(
        `tar -xzf ${JSON.stringify(path.resolve(source))} -C ${JSON.stringify(extractDir)} --strip-components 1`,
        { stdio: "ignore" },
      );
      fs.writeFileSync(extractDir + ".complete", "");
      continue;
    }

    // Go side (app-builder: AppImage, WinCodeSign, NSIS): the extracted
    // toolset directory under <tool>/<release>/.
    const toolDir = path.join(cacheDir, toolRootName);
    const archiveCopy = path.join(toolDir, fileName);
    fs.mkdirSync(toolDir, { recursive: true });
    fs.copyFileSync(source, archiveCopy);
    const releaseName = fileName.replace(/\.(7z|tar\.gz|tgz)$/i, "");
    const extracted = path.join(toolDir, releaseName);
    const tmp = path.join(toolDir, ".extract-" + releaseName);
    extractArchive(archiveCopy, tmp, sevenZipRoot);
    const entries = fs.readdirSync(tmp);
    if (entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory()) {
      fs.renameSync(path.join(tmp, entries[0]), extracted);
      fs.rmSync(tmp, { recursive: true, force: true });
    } else {
      fs.renameSync(tmp, extracted);
    }
    fs.writeFileSync(extracted + ".complete", "");
  }

  // The Go binary resolves its cache from HOME/XDG paths, the JS side from
  // ELECTRON_BUILDER_CACHE: one content directory, three addresses, so both
  // sides see the same pre-populated cache.
  const xdgDir = path.join(homeDir, ".cache");
  fs.mkdirSync(xdgDir, { recursive: true });
  const macDir = path.join(homeDir, "Library", "Caches");
  fs.mkdirSync(macDir, { recursive: true });
  fs.symlinkSync(cacheDir, path.join(xdgDir, "electron-builder"), "dir");
  fs.symlinkSync(cacheDir, path.join(macDir, "electron-builder"), "dir");
  return cacheDir;
}

async function main() {
  const outDir = arg("out");
  const target = arg("target");
  const arch = arg("arch");
  const projectDir = arg("project_dir");
  const electronBuilderConfig = arg("config");
  const packageJson = arg("package_json");
  const bundles = argList("bundle");
  const scripts = argList("script");
  const resources = argList("resource");
  const nodeModules = arg("node_modules");
  const electronCache = arg("electron_cache");
  const extraEnvRaw = arg("extra_env");

  if (!outDir || !target || !arch) {
    console.error("packager: missing required args --out, --target, --arch");
    process.exit(2);
  }

  // The execroot path, captured before any chdir; Bazel paths are relative to it.
  const execroot = process.cwd();
  const outDirAbs = path.resolve(execroot, outDir);

  // The stage lives inside the execroot so the sandbox sees it; it doubles as
  // the redirected HOME, so any stray write from electron-builder lands here
  // instead of the developer's real profile.
  const stage = path.join(
    path.dirname(outDirAbs),
    ".stage-" + path.basename(outDirAbs),
  );
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const homeDir = path.join(stage, "home");
  for (const dir of ["", ".cache", ".config"]) {
    fs.mkdirSync(path.join(homeDir, dir), { recursive: true });
  }

  const abs = (p) => path.resolve(execroot, p);

  // builder_cache files arrive as "<release>/<filename>" layouts plus a
  // resolved absolute path each; staging mirrors that layout inside
  // <stage>/eb-cache and pre-extracts every archive with its .complete marker.
  let electronBuilderCacheDir = null;
  const builderToolArgs = argList("builder_tool");
  if (builderToolArgs.length > 0) {
    const entries = {};
    for (const entry of builderToolArgs) {
      const sep = entry.indexOf("=");
      entries[entry.slice(0, sep)] = abs(entry.slice(sep + 1));
    }
    electronBuilderCacheDir = stageBuilderCache(
        entries,
        stage,
        homeDir,
        arg("seven_zip") ? abs(arg("seven_zip")) : null,
    );
  }

  // bundles -> staging/dist/ (contents merged into the dist root).
  const distDir = path.join(stage, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const rendererBundle = arg("renderer_bundle");
  const rendererAbs = rendererBundle ? abs(rendererBundle) : null;
  for (const b of bundles) {
    if (rendererAbs && abs(b) === rendererAbs) {
      continue;
    }
    stageInto(abs(b), distDir);
  }
  if (rendererAbs) {
    const rendererSubdir = arg("renderer_dir") || "renderer";
    const rendererTargetDir =
      rendererSubdir === "." ? distDir : path.join(distDir, rendererSubdir);
    fs.mkdirSync(rendererTargetDir, { recursive: true });
    copyDirContents(rendererAbs, rendererTargetDir);
    const expected = argList("renderer_entrypoint");
    const entrypoints = expected.length
      ? expected
      : ["index.html", "welcomeScreen.html"];
    for (const entrypoint of entrypoints) {
      const rendererEntrypoint = path.join(rendererTargetDir, entrypoint);
      if (!fs.existsSync(rendererEntrypoint)) {
        throw new Error(
          `Renderer staging is incomplete; expected ${rendererEntrypoint}`,
        );
      }
    }
  }

  copyFile(
    abs(electronBuilderConfig),
    path.join(stage, "electron-builder.json"),
  );
  const pj = JSON.parse(fs.readFileSync(abs(packageJson), "utf8"));
  // Main-process entry inside the package: dist/index.js, .webpack/main,
  // electron/main.js, etc. Set by the macro's app_main.
  pj.main = arg("main") || "index.js";
  delete pj.scripts;
  delete pj.devDependencies;
  fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify(pj, null, 2),
  );

  if (scripts.length) {
    const sdir = path.join(stage, "scripts");
    fs.mkdirSync(sdir, { recursive: true });
    for (const s of scripts)
      copyFile(abs(s), path.join(sdir, path.basename(s)));
  }

  for (const r of resources) {
    const ra = abs(r);
    const rel = resourceRelative(r, projectDir);
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursive(ra, dest);
  }

  // node_modules: the runtime closure is copied dereferenced because
  // electron-builder resolves packages through each realpath's node_modules
  // ancestor; a symlink into the linked tree would bypass the native addons
  // staged into it.
  const nativeAddons = argList("native_addon").map((entry) => {
    const i = entry.indexOf("=");
    return { pkg: entry.slice(0, i), nodeFile: abs(entry.slice(i + 1)) };
  });
  if (nodeModules) {
    stageNodeModules(stage, abs(nodeModules), nativeAddons, argList("packaged_module"));
  }

  // Electron version detection: electron-builder's computeElectronVersion
  // reads node_modules/electron/package.json from the project dir; pnpm's
  // virtual layout confuses that walk, so resolve electron from the packager
  // runfiles and write a minimal package.json into the staged node_modules.
  try {
    const electronPkgPath = require.resolve("electron/package.json");
    const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, "utf8"));
    const electronNmDir = path.join(stage, "node_modules", "electron");
    fs.mkdirSync(electronNmDir, { recursive: true });
    fs.writeFileSync(
      path.join(electronNmDir, "package.json"),
      JSON.stringify({ name: "electron", version: electronPkg.version }),
    );
  } catch (e) {
    console.warn(
      "Could not resolve electron from packager runfiles:",
      e.message,
    );
  }

  // Hermetic Electron binary cache: the pinned zip arrives as a single file
  // with its canonical release name; app-builder expects a directory
  // containing it, staged inside the action.
  if (electronCache) {
    if (fs.statSync(electronCache).isDirectory()) {
      process.env.ELECTRON_CACHE = electronCache;
    } else {
      const cacheDir = path.join(stage, ".electron-cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(
        electronCache,
        path.join(cacheDir, path.basename(electronCache)),
      );
      process.env.ELECTRON_CACHE = cacheDir;
    }
  }

  // Hermetic packaging toolsets: a pre-populated, read-anchored
  // ELECTRON_BUILDER_CACHE inside the stage; HOME and XDG dirs point into
  // the stage as well, so nothing writes to the real profile and any
  // unexpected download fails with the network blocked.
  if (electronBuilderCacheDir) {
    process.env.ELECTRON_BUILDER_CACHE = electronBuilderCacheDir;
  }
  process.env.HOME = homeDir;
  process.env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  // Deterministic archives: fix embedded file timestamps. ZIP cannot
  // represent dates before 1980, so use 2000-01-01T00:00:00Z.
  if (!process.env.SOURCE_DATE_EPOCH) {
    process.env.SOURCE_DATE_EPOCH = "946684800";
  }
  // Disable code signing by default; consumers override via env.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  if (extraEnvRaw) {
    const extra = JSON.parse(extraEnvRaw);
    for (const [k, v] of Object.entries(extra)) process.env[k] = String(v);
  }

  stageSevenZipBin(stage);
  process.chdir(stage);
  const { build, Platform, Arch } = require("electron-builder");
  const rawConfig = JSON.parse(
    fs.readFileSync("electron-builder.json", "utf8"),
  );
  // Bazel builds must never auto-publish.
  rawConfig.publish = null;
  // The staged node_modules carry no npm executable: beforeBuild=false skips
  // electron-builder's install/rebuild and (e-b >= 26) its node-module
  // collector, which spawns npm/pnpm. With the collector off, runtime
  // packages ride explicit {from,to} copy directives that bypass the files
  // matcher.
  rawConfig.beforeBuild = async () => false;
  const nmPkgs = new Set([
    "bindings",
    "file-uri-to-path",
    ...nativeAddons.map((a) => a.pkg),
    ...argList("packaged_module"),
  ]);
  if (nmPkgs.size > 0) {
    rawConfig.files = (rawConfig.files || []).filter(
      (f) => !(typeof f === "string" && f.includes("node_modules")),
    );
    for (const p of nmPkgs) {
      rawConfig.files.push({
        from: path.join("node_modules", p),
        to: path.join("node_modules", p),
        filter: [
          "**/*",
          "!bin/**",
          "!build/obj.target/**",
          "!build/Makefile",
          "!build/binding.Makefile",
        ],
      });
    }
  }

  // MAS builds without certificates: disable signing entirely.
  if (target === "mas" || target === "mas-dev") {
    rawConfig.mac = rawConfig.mac || {};
    rawConfig.mac.hardenedRuntime = false;
    rawConfig.mac.gatekeeperAssess = false;
    delete rawConfig.mac.notarize;
    rawConfig.mac.identity = null;
  }

  // DMG on macOS Sequoia/APFS fails when the /Applications symlink already
  // exists on the volume; drop the symlink entry (a UX nicety).
  if (
    target === "dmg" &&
    rawConfig.dmg &&
    Array.isArray(rawConfig.dmg.contents)
  ) {
    rawConfig.dmg.contents = rawConfig.dmg.contents.filter(
      (c) => !(c.type === "link" && c.path === "/Applications"),
    );
  }

  // Windows without Wine: rcedit needs Wine on non-Windows hosts; skip the
  // icon/version stamping (ELECTRON_BUILDER_WINE=1 re-enables it on runners
  // that have Wine).
  if (!rawConfig.win) rawConfig.win = {};
  if (
    (process.platform === "linux" || process.platform === "darwin") &&
    !process.env.ELECTRON_BUILDER_WINE
  ) {
    rawConfig.win.signAndEditExecutable = false;
  }
  if (fs.existsSync(path.join(stage, "scripts", "afterpack.bazel.js"))) {
    rawConfig.afterPack = "scripts/afterpack.bazel.js";
  }
  if (fs.existsSync(path.join(stage, "scripts", "afterbuild.bazel.js"))) {
    rawConfig.afterAllArtifactBuild = "scripts/afterbuild.bazel.js";
  }
  if (fs.existsSync(path.join(stage, "scripts", "aftersign.bazel.js"))) {
    rawConfig.afterSign = "scripts/aftersign.bazel.js";
  }
  // Flatten artifactName: a "${version}/" prefix creates a subdirectory that
  // cannot live inside a Bazel tree artifact.
  if (rawConfig.artifactName) {
    rawConfig.artifactName = rawConfig.artifactName.replace(
      /^\$\{version\}\//,
      "",
    );
  }
  if (rawConfig.deb && rawConfig.deb.artifactName) {
    rawConfig.deb.artifactName = rawConfig.deb.artifactName.replace(
      /^\$\{version\}\//,
      "",
    );
  }

  const platformMap = {
    linux: Platform.LINUX,
    win: Platform.WINDOWS,
    mac: Platform.MAC,
  };
  const archMap = {
    x64: Arch.x64,
    arm64: Arch.arm64,
    ia32: Arch.ia32,
    universal: Arch.universal,
  };
  const platKey = platformFromTarget(target);
  const plat = platformMap[platKey];
  if (!plat) throw new Error("Unknown platform for target: " + target);
  const archEnum = archMap[arch] || Arch.x64;
  stageDefaultIcon(stage, platKey, rawConfig);
  const targets = plat.createTarget(target, archEnum);
  const opts = {
    targets: targets,
    config: {
      ...rawConfig,
      directories: {
        buildResources:
          (rawConfig.directories && rawConfig.directories.buildResources) ||
          "build",
        output: outDirAbs,
      },
    },
  };
  await build(opts);

  // Hermeticity receipt: the redirected HOME must hold nothing beyond the
  // staged cache skeleton. Any file here means something tried to write or
  // download outside the pinned inputs.
  const stray = [];
  collectFiles(homeDir, "", stray);
  for (const f of stray) {
    // "Library/Caches/electron-builder" is our own symlink to the staged
    // cache; anything ELSE in the redirected HOME is a non-hermetic write.
    if (f.startsWith("Library")) {
      continue;
    }
    if (!f.startsWith(".cache") && !f.startsWith(".config")) {
      console.error(
        "packager: non-hermetic write detected in the redirected HOME: " + f,
      );
      process.exitCode = 1;
    }
  }
  if (stray.length === 0) {
    console.log("[packager] hermeticity receipt: redirected HOME stayed empty");
  }
}

function collectFiles(dir, relative, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      out.push(rel);
      collectFiles(path.join(dir, entry.name), rel, out);
    } else {
      out.push(rel);
    }
  }
}

function platformFromTarget(t) {
  if (
    ["deb", "rpm", "tar.gz", "appimage", "snap", "freebsd", "pacman"].includes(
      t,
    )
  )
    return "linux";
  if (
    ["nsis", "squirrel.windows", "zip", "msi", "portable", "appx"].includes(t)
  )
    return "win";
  if (["dmg", "pkg", "mas", "mas-dev"].includes(t)) return "mac";
  throw new Error("Unknown target: " + t);
}

function resourceRelative(absPath, projectDir) {
  if (!projectDir) return path.basename(absPath);
  const p = path.resolve(absPath);
  const root = path.resolve(projectDir);
  if (p.startsWith(root)) return path.relative(root, p);
  return path.basename(absPath);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    copyFile(src, dest);
  }
}

function copyDirContents(src, dest) {
  for (const entry of fs.readdirSync(src)) {
    copyRecursive(path.join(src, entry), path.join(dest, entry));
  }
}

function stageInto(src, dest) {
  // Bundle labels may be directory outputs (webpack/vite bundles) or plain
  // files (filegroups); files land at the dist root under their basename.
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    copyDirContents(src, dest);
  } else {
    copyFile(src, path.join(dest, path.basename(src)));
  }
}

function resolveLinkedPackage(linkedNm, name) {
  const direct = path.join(linkedNm, name);
  if (fs.existsSync(path.join(direct, "package.json"))) {
    return direct;
  }
  const store = path.join(linkedNm, ".aspect_rules_js");
  if (!fs.existsSync(store)) {
    return null;
  }
  const prefix = name.replace("/", "+") + "@";
  for (const entry of fs.readdirSync(store)) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const candidate = path.join(store, entry, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return null;
}

function stageNodeModules(stage, linkedNm, nativeAddons, packagedModules) {
  const nmDest = path.join(stage, "node_modules");
  fs.mkdirSync(nmDest, { recursive: true });

  const stagedPj = JSON.parse(
    fs.readFileSync(path.join(stage, "package.json"), "utf8"),
  );
  const queue = Object.keys(stagedPj.dependencies || {});
  for (const name of packagedModules) {
    if (!queue.includes(name)) {
      queue.push(name);
    }
  }
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const src = resolveLinkedPackage(linkedNm, name);
    if (src == null) {
      continue;
    }
    const dest = path.join(nmDest, name);
    fs.mkdirSync(dest, { recursive: true });
    copyDirContents(src, dest);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dest, "package.json"), "utf8"),
    );
    queue.push(...Object.keys(pkg.dependencies || {}));
  }

  for (const a of nativeAddons) {
    const releaseDir = path.join(nmDest, a.pkg, "build", "Release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.copyFileSync(
      a.nodeFile,
      path.join(releaseDir, path.basename(a.nodeFile)),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
