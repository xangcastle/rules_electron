import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const NATIVE_ADDON_RUNTIME_HELPERS = ["bindings", "file-uri-to-path"];

const REDIRECTED_HOME_ALLOWED_TOP_LEVEL_ENTRIES = new Set([".cache", ".config", "Library"]);

const argv = process.argv.slice(2);

const SQUASHFS_SUPERBLOCK_MKFS_TIME_OFFSET = 8;

const GZIP_HEADER_MTIME_OFFSET = 4;

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

function electronBuilderDjb2UrlHashBase36(input, length = 6) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  hash >>>= 0;
  const out = hash.toString(36);
  return out.length >= length ? out.slice(0, length) : out.padStart(length, "0");
}

function stageSevenZipBinCopiesAndAliasResolutionAnchors(stage) {
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

function stageDefaultPlatformIconCopyWhenUnset(stage, platKey, config) {
  const defaultTemplate = {
    linux: "electron-linux/256x256.png",
    win: "electron-win/icon.ico",
  }[platKey];
  if (!defaultTemplate) return;
  const platConfig = config[platKey] || (config[platKey] = {});
  if (platConfig.icon) return;
  const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));
  let source;
  try {
    const libId = electronBuilderRequire.resolve("app-builder-lib/package.json");
    source = path.join(path.dirname(libId), "templates", ...defaultTemplate.split("/"));
  } catch (e) {
    return;
  }
  if (!fs.existsSync(source)) return;
  const copy = path.join(stage, "default-icon", path.basename(defaultTemplate));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o644);
  platConfig.icon = copy;
}

function stageDmgBuildJsToolCacheEntry(cacheDir, releaseName, fileName, sourceArchivePath) {
  const baseUrl = "https://github.com/electron-userland/electron-builder-binaries/releases/download/";
  const suffix = electronBuilderDjb2UrlHashBase36(`${baseUrl}-${releaseName}-${fileName}`, 5);
  const folderName = fileName.replace(/\.(tar\.gz|tgz)$/, "") + "-" + suffix;
  const extractDir = path.join(cacheDir, releaseName, folderName);
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(
      `tar -xzf ${JSON.stringify(path.resolve(sourceArchivePath))} -C ${JSON.stringify(extractDir)} --strip-components 1`,
      { stdio: "ignore" },
  );
  fs.writeFileSync(extractDir + ".complete", "");
}

const TOOLSET_GETBIN_DIRECT_NAMES = {"winCodeSign-2.6.0": "winCodeSign"};

function appBuilderDownloadArtifactName(releaseName, fileName) {
  return TOOLSET_GETBIN_DIRECT_NAMES[releaseName] ??
      `${releaseName}-${fileName.replace(/\.[^.]+$/, "")}`;
}

function stageAppBuilderDownloadArtifactCacheEntry(cacheDir, releaseName, fileName, sourceArchivePath, sevenZipRoot) {
  const downloadArtifactName = appBuilderDownloadArtifactName(releaseName, fileName);
  const releaseDir = path.join(cacheDir, downloadArtifactName.split("-")[0], downloadArtifactName);
  stageExtractedToolsetCacheEntry(cacheDir, releaseDir, fileName, sourceArchivePath, sevenZipRoot);
  return releaseDir;
}

function stageAppBuilderGoToolCacheEntry(cacheDir, releaseName, fileName, sourceArchivePath, sevenZipRoot) {
  stageExtractedToolsetCacheEntry(
      cacheDir,
      path.join(cacheDir, releaseName.split("-")[0], releaseName),
      fileName,
      sourceArchivePath,
      sevenZipRoot,
  );
}

function isMakensisToolset(releaseName) {
  return /^nsis-\d/.test(releaseName);
}

function prepareMakensisForTheHost(makensisToolsetDir) {
  process.env.NSISDIR = makensisToolsetDir;
  if (process.platform !== "darwin") {
    return;
  }
  const macDir = path.join(makensisToolsetDir, "mac");
  for (const entry of fs.readdirSync(macDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const macExecutable = path.join(macDir, entry.name);
    fs.chmodSync(macExecutable, 0o755);
    try {
      execSync(`codesign --force --sign - ${JSON.stringify(macExecutable)}`, { stdio: "ignore" });
    } catch (e) {}
  }
}

function stageExtractedToolsetCacheEntry(cacheDir, releaseDir, fileName, sourceArchivePath, sevenZipRoot) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const extractionTmp = path.join(cacheDir, ".extract-" + fileName);
  extractArchive(sourceArchivePath, extractionTmp, sevenZipRoot);
  const entries = fs.readdirSync(extractionTmp);
  if (entries.length === 1 && fs.statSync(path.join(extractionTmp, entries[0])).isDirectory()) {
    fs.renameSync(path.join(extractionTmp, entries[0]), releaseDir);
    fs.rmSync(extractionTmp, { recursive: true, force: true });
  } else {
    fs.renameSync(extractionTmp, releaseDir);
  }
}

function isAppBuilderGoDownloaderToolset(releaseName) {
  return releaseName.startsWith("appimage");
}

function isDmgBuilderJsDownloadToolset(releaseName) {
  return releaseName.startsWith("dmg-builder@");
}

function stageBuilderToolCache(builderCacheFiles, stage, homeDir, sevenZipRoot) {
  const cacheDir = path.join(stage, "eb-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const [relativeLayout, source] of Object.entries(builderCacheFiles)) {
    const releaseName = relativeLayout.split("/")[0];
    const fileName = path.basename(relativeLayout);
    if (isAppBuilderGoDownloaderToolset(releaseName)) {
      stageAppBuilderGoToolCacheEntry(cacheDir, releaseName, fileName, source, sevenZipRoot);
    } else if (isDmgBuilderJsDownloadToolset(releaseName)) {
      stageDmgBuildJsToolCacheEntry(cacheDir, releaseName, fileName, source);
    } else {
      const releaseDir = stageAppBuilderDownloadArtifactCacheEntry(cacheDir, releaseName, fileName, source, sevenZipRoot);
      if (isMakensisToolset(releaseName)) {
        prepareMakensisForTheHost(releaseDir);
      }
    }
  }

  const xdgDir = path.join(homeDir, ".cache");
  const macDir = path.join(homeDir, "Library", "Caches");
  fs.mkdirSync(xdgDir, { recursive: true });
  fs.mkdirSync(macDir, { recursive: true });
  fs.symlinkSync(cacheDir, path.join(xdgDir, "electron-builder"), "dir");
  fs.symlinkSync(cacheDir, path.join(macDir, "electron-builder"), "dir");
  return cacheDir;
}

function disableElectronBuilderAutoPublish(config) {
  config.publish = null;
}

function shipRuntimePackagesThroughExplicitFileCopies(config, runtimePackageNames) {
  config.beforeBuild = async () => false;
  if (runtimePackageNames.size === 0) {
    return;
  }
  config.files = (config.files || []).filter(
      (f) => !(typeof f === "string" && f.includes("node_modules")),
  );
  for (const runtimePackage of runtimePackageNames) {
    config.files.push({
      from: path.join("node_modules", runtimePackage),
      to: path.join("node_modules", runtimePackage),
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

function disableMacosSigningForMasTargets(config, target) {
  if (target !== "mas" && target !== "mas-dev") {
    return;
  }
  config.mac = config.mac || {};
  config.mac.hardenedRuntime = false;
  config.mac.gatekeeperAssess = false;
  delete config.mac.notarize;
  config.mac.identity = null;
}

function dropDmgApplicationsSymlinkEntry(config, target) {
  if (
    target === "dmg" &&
    config.dmg &&
    Array.isArray(config.dmg.contents)
  ) {
    config.dmg.contents = config.dmg.contents.filter(
        (c) => !(c.type === "link" && c.path === "/Applications"),
    );
  }
}

function skipWindowsExecutableStampingWithoutWine(config) {
  if (!config.win) config.win = {};
  if (
    (process.platform === "linux" || process.platform === "darwin") &&
    !process.env.ELECTRON_BUILDER_WINE
  ) {
    config.win.signAndEditExecutable = false;
  }
}

function flattenArtifactNameForBazelTreeArtifacts(config) {
  if (config.artifactName) {
    config.artifactName = config.artifactName.replace(
        /^\$\{version\}\//,
        "",
    );
  }
  if (config.deb && config.deb.artifactName) {
    config.deb.artifactName = config.deb.artifactName.replace(
        /^\$\{version\}\//,
        "",
    );
  }
}

function wireBazelLifecycleScripts(config, stage) {
  if (fs.existsSync(path.join(stage, "scripts", "afterpack.bazel.js"))) {
    config.afterPack = "scripts/afterpack.bazel.js";
  }
  if (fs.existsSync(path.join(stage, "scripts", "afterbuild.bazel.js"))) {
    config.afterAllArtifactBuild = "scripts/afterbuild.bazel.js";
  }
  if (fs.existsSync(path.join(stage, "scripts", "aftersign.bazel.js"))) {
    config.afterSign = "scripts/aftersign.bazel.js";
  }
}

function pinTreeMtimes(dir, epochSeconds) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) pinTreeMtimes(entryPath, epochSeconds);
    fs.lutimesSync(entryPath, epochSeconds, epochSeconds);
  }
  fs.lutimesSync(dir, epochSeconds, epochSeconds);
}

function pinAppOutDirMtimesToSourceDateEpoch(config, stage) {
  const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH);
  for (const hookName of ["afterPack", "afterSign"]) {
    const userHook = config[hookName];
    config[hookName] = async (context) => {
      if (userHook) {
        const hookModule = typeof userHook === "function" ?
          userHook :
          require(path.resolve(stage, userHook));
        await (hookModule.default || hookModule)(context);
      }
      pinTreeMtimes(context.appOutDir, epochSeconds);
    };
  }
}

function findMacAppBundles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
      .map((entry) => path.join(dir, entry.name));
}

function signMacAppAdHocAfterPack(config, stage, codesign) {
  const userHook = config.afterPack;
  config.afterPack = async (context) => {
    if (userHook) {
      const hookModule = typeof userHook === "function" ?
        userHook :
        require(path.resolve(stage, userHook));
      await (hookModule.default || hookModule)(context);
    }
    for (const appBundle of findMacAppBundles(context.appOutDir)) {
      const result = spawnSync(codesign, ["sign", appBundle], { encoding: "utf8" });
      if (result.status !== 0) {
        console.error(result.stdout, result.stderr);
        throw new Error("rcodesign failed to sign " + appBundle);
      }
    }
  };
}

function removeUnpackedMacAppDirectories(outDir) {
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    const entryPath = path.join(outDir, entry.name);
    if (entry.isDirectory() && findMacAppBundles(entryPath).length) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }
}

async function runMksquashfsWithPinnedTimes([realMksquashfs, ...args]) {
  const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH);
  const [sourceDir, image] = args;
  const offsetFlag = args.indexOf("-offset");
  const offset = offsetFlag >= 0 ? Number(args[offsetFlag + 1]) : 0;
  pinTreeMtimes(sourceDir, epochSeconds);
  const result = spawnSync(realMksquashfs, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const mkfsTime = Buffer.alloc(4);
  mkfsTime.writeUInt32LE(epochSeconds);
  const fd = fs.openSync(image, "r+");
  try {
    fs.writeSync(fd, mkfsTime, 0, mkfsTime.length, offset + SQUASHFS_SUPERBLOCK_MKFS_TIME_OFFSET);
  } finally {
    fs.closeSync(fd);
  }
}

function routeMksquashfsThroughPinnedTimes(cacheDir, stage) {
  const linuxToolArch = { arm64: "arm64", x64: "x64", ia32: "ia32", arm: "arm32" }[process.arch];
  const appImageToolsetsDir = path.join(cacheDir, "appimage");
  if (process.platform !== "linux" || !linuxToolArch || !fs.existsSync(appImageToolsetsDir)) {
    return;
  }
  for (const release of fs.readdirSync(appImageToolsetsDir)) {
    const realMksquashfs = path.join(appImageToolsetsDir, release, "linux-" + linuxToolArch, "mksquashfs");
    if (!fs.existsSync(realMksquashfs)) {
      continue;
    }
    const wrapper = path.join(stage, ".mksquashfs-pinned-times.sh");
    fs.writeFileSync(
        wrapper,
        "#!/bin/sh\nexec " + [process.execPath, fileURLToPath(import.meta.url), MKSQUASHFS_WRAPPER_FLAG, realMksquashfs]
            .map((word) => JSON.stringify(word))
            .join(" ") + " \"$@\"\n",
        { mode: 0o755 },
    );
    process.env.MKSQUASHFS_PATH = wrapper;
    return;
  }
}

function zeroGzipHeaderMtimes(outDir) {
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) {
      continue;
    }
    const fd = fs.openSync(path.join(outDir, entry.name), "r+");
    try {
      const magic = Buffer.alloc(2);
      fs.readSync(fd, magic, 0, 2, 0);
      if (magic[0] === 0x1f && magic[1] === 0x8b) {
        fs.writeSync(fd, Buffer.alloc(4), 0, 4, GZIP_HEADER_MTIME_OFFSET);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

function stageElectronVersionFromRunnerRunfiles(stage) {
  try {
    const electronPackageJsonPath = require.resolve("electron/package.json");
    const electronPackage = JSON.parse(fs.readFileSync(electronPackageJsonPath, "utf8"));
    const electronNodeModulesDir = path.join(stage, "node_modules", "electron");
    fs.mkdirSync(electronNodeModulesDir, { recursive: true });
    fs.writeFileSync(
        path.join(electronNodeModulesDir, "package.json"),
        JSON.stringify({ name: "electron", version: electronPackage.version }),
    );
  } catch (e) {
    console.warn(
        "Could not resolve electron from packager runfiles:",
        e.message,
    );
  }
}

function stageElectronZipCacheDirectory(pinnedZipPath, stage) {
  if (fs.statSync(pinnedZipPath).isDirectory()) {
    return pinnedZipPath;
  }
  const cacheDir = path.join(stage, ".electron-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(pinnedZipPath, path.join(cacheDir, path.basename(pinnedZipPath)));
  return cacheDir;
}

function stageNodeModulesDereferenced(stage, linkedNodeModules, nativeAddons, packagedModules) {
  const nodeModulesDir = path.join(stage, "node_modules");
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  const stagedPackageJson = JSON.parse(
      fs.readFileSync(path.join(stage, "package.json"), "utf8"),
  );
  const closureQueue = Object.keys(stagedPackageJson.dependencies || {});
  for (const name of packagedModules) {
    if (!closureQueue.includes(name)) {
      closureQueue.push(name);
    }
  }
  const visited = new Set();
  while (closureQueue.length > 0) {
    const name = closureQueue.shift();
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    const source = resolveLinkedPackage(linkedNodeModules, name);
    if (source == null) {
      continue;
    }
    const destination = path.join(nodeModulesDir, name);
    fs.mkdirSync(destination, { recursive: true });
    copyRecursive(source, destination);
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(destination, "package.json"), "utf8"),
    );
    closureQueue.push(...Object.keys(packageJson.dependencies || {}));
  }

  for (const addon of nativeAddons) {
    const releaseDir = path.join(nodeModulesDir, addon.pkg, "build", "Release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.copyFileSync(
        addon.nodeFile,
        path.join(releaseDir, path.basename(addon.nodeFile)),
    );
  }
}

function resolveLinkedPackage(linkedNodeModules, name) {
  const direct = path.join(linkedNodeModules, name);
  if (fs.existsSync(path.join(direct, "package.json"))) {
    return direct;
  }
  const aspectStore = path.join(linkedNodeModules, ".aspect_rules_js");
  if (!fs.existsSync(aspectStore)) {
    return null;
  }
  const aspectStoreEntryPrefix = name.replace("/", "+") + "@";
  for (const entry of fs.readdirSync(aspectStore)) {
    if (!entry.startsWith(aspectStoreEntryPrefix)) {
      continue;
    }
    const candidate = path.join(aspectStore, entry, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return null;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyRecursive(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
  } else {
    copyFile(source, destination);
  }
}

function stageFileOrTreeInto(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    copyRecursive(source, destination);
  } else {
    copyFile(source, path.join(destination, path.basename(source)));
  }
}

function resourceRelative(absolutePath, projectDir) {
  if (!projectDir) return path.basename(absolutePath);
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(projectDir);
  if (resolved.startsWith(root)) return path.relative(root, resolved);
  return path.basename(absolutePath);
}

function platformFromTarget(targetName) {
  if (
    ["deb", "rpm", "tar.gz", "appimage", "snap", "freebsd", "pacman"].includes(
        targetName,
    )
  ) {
    return "linux";
  }
  if (
    ["nsis", "squirrel.windows", "zip", "msi", "portable", "appx"].includes(
        targetName,
    )
  ) {
    return "win";
  }
  if (["dmg", "pkg", "mas", "mas-dev"].includes(targetName)) return "mac";
  throw new Error("Unknown target: " + targetName);
}

function splitPlatformPrefix(rawTarget) {
  const separator = rawTarget.indexOf(":");
  if (separator < 0) {
    return { platKey: platformFromTarget(rawTarget), builderTarget: rawTarget };
  }
  const platKey = rawTarget.slice(0, separator);
  if (!["linux", "mac", "win"].includes(platKey)) {
    throw new Error("Unknown platform prefix in target: " + rawTarget);
  }
  return { platKey, builderTarget: rawTarget.slice(separator + 1) };
}

function collectFiles(dir, relativePath = "") {
  const entries = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryRel = relativePath ? relativePath + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      entries.push(entryRel);
      entries.push(...collectFiles(path.join(dir, entry.name), entryRel));
    } else {
      entries.push(entryRel);
    }
  }
  return entries;
}

function auditRedirectedHomeStayedEmpty(homeDir) {
  const nonHermeticWrites = collectFiles(homeDir)
      .filter((entry) => !REDIRECTED_HOME_ALLOWED_TOP_LEVEL_ENTRIES.has(entry.split("/")[0]));
  for (const entry of nonHermeticWrites) {
    console.error(
        "packager: non-hermetic write detected in the redirected HOME: " + entry,
    );
  }
  if (nonHermeticWrites.length === 0) {
    console.log("[packager] hermeticity receipt: redirected HOME stayed empty");
  } else {
    process.exitCode = 1;
  }
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
  const codesignArg = arg("codesign");

  if (!outDir || !target || !arch) {
    console.error("packager: missing required args --out, --target, --arch");
    process.exit(2);
  }

  const execrootBeforeChdir = process.cwd();
  const outDirAbs = path.resolve(execrootBeforeChdir, outDir);
  const codesign = codesignArg ? path.resolve(execrootBeforeChdir, codesignArg) : null;
  const abs = (p) => path.resolve(execrootBeforeChdir, p);

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

  let electronBuilderCacheDir = null;
  const builderToolArgs = argList("builder_tool");
  if (builderToolArgs.length > 0) {
    const builderCacheFiles = {};
    for (const entry of builderToolArgs) {
      const sep = entry.indexOf("=");
      builderCacheFiles[entry.slice(0, sep)] = abs(entry.slice(sep + 1));
    }
    electronBuilderCacheDir = stageBuilderToolCache(
        builderCacheFiles,
        stage,
        homeDir,
        arg("seven_zip") ? abs(arg("seven_zip")) : null,
    );
  }

  const distDir = path.join(stage, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const rendererBundle = arg("renderer_bundle");
  const rendererAbs = rendererBundle ? abs(rendererBundle) : null;
  for (const b of bundles) {
    if (rendererAbs && abs(b) === rendererAbs) {
      continue;
    }
    stageFileOrTreeInto(abs(b), distDir);
  }
  if (rendererAbs) {
    const rendererSubdir = arg("renderer_dir") || "renderer";
    const rendererTargetDir =
      rendererSubdir === "." ? distDir : path.join(distDir, rendererSubdir);
    fs.mkdirSync(rendererTargetDir, { recursive: true });
    copyRecursive(rendererAbs, rendererTargetDir);
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
  const projectPackageJson = JSON.parse(fs.readFileSync(abs(packageJson), "utf8"));
  projectPackageJson.main = arg("main") || "index.js";
  delete projectPackageJson.scripts;
  delete projectPackageJson.devDependencies;
  fs.writeFileSync(
      path.join(stage, "package.json"),
      JSON.stringify(projectPackageJson, null, 2),
  );

  if (scripts.length) {
    const scriptsDir = path.join(stage, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const s of scripts) {
      copyFile(abs(s), path.join(scriptsDir, path.basename(s)));
    }
  }

  for (const r of resources) {
    const resourceAbs = abs(r);
    const destination = path.join(stage, resourceRelative(resourceAbs, projectDir));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyRecursive(resourceAbs, destination);
  }

  const nativeAddons = argList("native_addon").map((entry) => {
    const i = entry.indexOf("=");
    return { pkg: entry.slice(0, i), nodeFile: abs(entry.slice(i + 1)) };
  });
  if (nodeModules) {
    stageNodeModulesDereferenced(stage, abs(nodeModules), nativeAddons, argList("packaged_module"));
  }

  stageElectronVersionFromRunnerRunfiles(stage);

  if (electronCache) {
    process.env.ELECTRON_CACHE = stageElectronZipCacheDirectory(abs(electronCache), stage);
  }

  if (electronBuilderCacheDir) {
    process.env.ELECTRON_BUILDER_CACHE = electronBuilderCacheDir;
  }
  process.env.HOME = homeDir;
  process.env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  if (!process.env.SOURCE_DATE_EPOCH) {
    process.env.SOURCE_DATE_EPOCH = "946684800";
  }
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  if (electronBuilderCacheDir) {
    routeMksquashfsThroughPinnedTimes(electronBuilderCacheDir, stage);
  }
  if (extraEnvRaw) {
    const extra = JSON.parse(extraEnvRaw);
    for (const [k, v] of Object.entries(extra)) process.env[k] = String(v);
  }

  stageSevenZipBinCopiesAndAliasResolutionAnchors(stage);
  process.chdir(stage);
  const { build, Platform, Arch } = require("electron-builder");
  const rawConfig = JSON.parse(
      fs.readFileSync("electron-builder.json", "utf8"),
  );
  disableElectronBuilderAutoPublish(rawConfig);
  const runtimePackageNames = new Set([
    ...NATIVE_ADDON_RUNTIME_HELPERS,
    ...nativeAddons.map((a) => a.pkg),
    ...argList("packaged_module"),
  ]);
  shipRuntimePackagesThroughExplicitFileCopies(rawConfig, runtimePackageNames);
  const { platKey, builderTarget } = splitPlatformPrefix(target);
  disableMacosSigningForMasTargets(rawConfig, builderTarget);
  dropDmgApplicationsSymlinkEntry(rawConfig, builderTarget);
  skipWindowsExecutableStampingWithoutWine(rawConfig);
  wireBazelLifecycleScripts(rawConfig, stage);
  if (codesign && platKey === "mac") {
    signMacAppAdHocAfterPack(rawConfig, stage, codesign);
  }
  pinAppOutDirMtimesToSourceDateEpoch(rawConfig, stage);
  flattenArtifactNameForBazelTreeArtifacts(rawConfig);

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
  const plat = platformMap[platKey];
  if (!plat) throw new Error("Unknown platform for target: " + target);
  const archEnum = archMap[arch] || Arch.x64;
  stageDefaultPlatformIconCopyWhenUnset(stage, platKey, rawConfig);
  const electronBuilderTargets = plat.createTarget(builderTarget, archEnum);
  const opts = {
    targets: electronBuilderTargets,
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
  zeroGzipHeaderMtimes(outDirAbs);
  if (platKey === "mac") {
    removeUnpackedMacAppDirectories(outDirAbs);
  }

  auditRedirectedHomeStayedEmpty(homeDir);
}

const MKSQUASHFS_WRAPPER_FLAG = "--mksquashfs-wrapper";

(argv[0] === MKSQUASHFS_WRAPPER_FLAG ?
  runMksquashfsWithPinnedTimes(argv.slice(1)) :
  main()
).catch((err) => {
  console.error(err);
  process.exit(1);
});
