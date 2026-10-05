import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

const manifestPath = process.argv[2];
const packageJsonPath = process.argv[3];
const electronZipPath = process.argv[4];
const bundleCount = Number(process.argv[5]);
const resourceCount = Number(process.argv[6]);
const appMain = process.argv[7];
const passthroughArgs = process.argv.slice(8);

if (!manifestPath || !packageJsonPath || !Number.isInteger(bundleCount) ||
    !Number.isInteger(resourceCount) || !appMain) {
  console.error("dev_driver: corrupted argv");
  process.exit(2);
}

let runfilesRoot = process.env.RUNFILES_DIR;
if (!runfilesRoot) {
  runfilesRoot = path.dirname(new URL(import.meta.url).pathname);
  while (runfilesRoot !== path.dirname(runfilesRoot) && !path.basename(runfilesRoot).endsWith(".runfiles")) {
    runfilesRoot = path.dirname(runfilesRoot);
  }
  if (!path.basename(runfilesRoot).endsWith(".runfiles")) {
    console.error("dev_driver: could not locate the .runfiles root from " + runfilesRoot);
    process.exit(2);
  }
}

function resolveInput(runfilesRelativePath) {
  return path.isAbsolute(runfilesRelativePath)
      ? runfilesRelativePath
      : path.join(runfilesRoot, "_main", runfilesRelativePath);
}

function runfilesRelativeFromExecrootRel(execrootRelativePath) {
  return "_main/" + (execrootRelativePath.startsWith("bazel-out/")
      ? execrootRelativePath.slice(execrootRelativePath.indexOf("/bin/") + 5)
      : execrootRelativePath);
}

function findNodeModulesRoot(nodeModulesExecrootRel) {
  const runfilesManifest = path.join(runfilesRoot, "MANIFEST");
  const nodeModulesRunfilesRel =
      runfilesRelativeFromExecrootRel(nodeModulesExecrootRel).replace(/\/\//g, "/");
  if (fs.existsSync(runfilesManifest)) {
    for (const line of fs.readFileSync(runfilesManifest, "utf8").split("\n")) {
      const sep = line.indexOf(" ");
      if (sep > 0 && line.slice(0, sep).startsWith(nodeModulesRunfilesRel + "/")) {
        const absolute = line.slice(sep + 1);
        return absolute.slice(0, absolute.length - (line.slice(0, sep).length - nodeModulesRunfilesRel.length));
      }
    }
  }
  console.error("dev_driver: node_modules tree not found in the runfiles manifest at " + nodeModulesRunfilesRel);
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packagedModules = spec.packaged_modules || [];
const nativeAddons = spec.native_addons || [];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rules_electron_dev_"));
fs.mkdirSync(path.join(stage, "dist"), { recursive: true });

const removeStage = () => {
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
};
process.on("exit", removeStage);
for (const [signalName, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signalName, () => {
    removeStage();
    process.exit(exitCode);
  });
}

function copyTreeContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    copyTreeContents(path.join(source, entry), path.join(destination, entry));
  }
}

function stageSingleBundleEntry(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    copyTreeContents(source, destination);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function stageBundleEntries(bundleEntries) {
  for (const entry of bundleEntries) {
    const source = resolveInput(entry.src);
    const destination = path.join(stage, entry.dest);
    if (fs.statSync(source).isDirectory()) {
      copyTreeContents(source, destination);
    } else {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(source, path.join(destination, path.basename(source)));
    }
  }
}

stageBundleEntries(spec.bundles);
for (const entry of spec.resources) {
  stageSingleBundleEntry(resolveInput(entry.src), path.join(stage, entry.dest));
}

const appPackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
appPackage.main = appMain;
fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify(appPackage, null, 2),
);

if (electronZipPath && electronZipPath !== "-") {
  const electronDist = path.join(stage, "electron-dist");
  fs.mkdirSync(electronDist, { recursive: true });
  execSync(`unzip -o -q ${JSON.stringify(electronZipPath)} -d ${JSON.stringify(electronDist)}`, { stdio: "ignore" });
}

const nodeModulesRoot = findNodeModulesRoot(spec.node_modules_root);
const stageNodeModules = path.join(stage, "node_modules");
fs.mkdirSync(stageNodeModules, { recursive: true });
for (const entry of fs.readdirSync(nodeModulesRoot)) {
  fs.symlinkSync(path.join(nodeModulesRoot, entry), path.join(stageNodeModules, entry), "dir");
}

function resolveLinkedPackageDirectOrFromAspectStore(name) {
  const direct = path.join(nodeModulesRoot, name);
  if (fs.existsSync(path.join(direct, "package.json"))) {
    return direct;
  }
  const aspectStore = path.join(nodeModulesRoot, ".aspect_rules_js");
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

const stageNodeModulesReal = path.join(stage, "node_modules_real");
for (const name of packagedModules) {
  const source = resolveLinkedPackageDirectOrFromAspectStore(name);
  if (!source) {
    console.warn("dev_driver: packaged module " + name + " not in the linked tree; skipping");
    continue;
  }
  const real = path.join(stageNodeModulesReal, name);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  execSync(`cp -RL ${JSON.stringify(source)} ${JSON.stringify(real)}`);
  execSync(`chmod -R u+w ${JSON.stringify(real)}`);
  fs.rmSync(path.join(stageNodeModules, name), { force: true });
  fs.symlinkSync(real, path.join(stageNodeModules, name), "dir");
}
for (const addon of nativeAddons) {
  const releaseDir = path.join(stageNodeModulesReal, addon.pkg, "build", "Release");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(resolveInput(addon.rel), path.join(releaseDir, path.basename(addon.rel)));
}

function electronExecutable(stageRoot) {
  const electronDist = path.join(stageRoot, "electron-dist");
  if (process.platform === "darwin") {
    return path.join(electronDist, "Electron.app/Contents/MacOS/Electron");
  }
  if (process.platform === "win32") {
    return path.join(electronDist, "electron.exe");
  }
  return path.join(electronDist, "electron");
}

const electronBin = electronExecutable(stage);
if (!fs.existsSync(electronBin)) {
  console.error("dev_driver: electron binary not found at " + electronBin);
  process.exit(2);
}

const child = spawn(electronBin, [stage, ...passthroughArgs], {
  cwd: stage,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signalName, () => child.kill(signalName));
}
child.on("exit", (exitCode, signalName) => {
  removeStage();
  process.exit(signalName ? 130 : (exitCode ?? 0));
});
