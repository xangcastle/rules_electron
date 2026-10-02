import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

// Launches an Electron app against pre-built bundles. Stages an ephemeral
// tree (bundles -> dist/, resources at their package-relative paths, the
// app package.json with main patched to the entry), overlays the linked
// node_modules (per-package symlinks, with packaged modules and native
// addons as real dirs), extracts the pinned Electron zip, and executes
// Electron with stdio inherited. The stage is removed on exit; Ctrl+C
// reaches the app through signal forwarding.
//
// argv contract (positions fixed by the rule's embedded_args):
//   [2] manifest absolute path (a resolved runfile arg)
//   [3] package.json absolute path (a resolved runfile arg)
//   [4] electron zip absolute path, or "-" when the app has none
//   [5] bundle count
//   [6] resource count
//   [7] app_main (package-relative entry, becomes package.json main)
//   then passthrough args from bazel run.
// The manifest carries bundles/resources as {src, dest} entries, the
// packaged module names, the native addon files, and the execroot-relative
// node_modules root.

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

function resolveInput(p) {
  return path.isAbsolute(p) ? p : path.join(runfilesRoot, "_main", p);
}

function findNodeModulesRoot(nmRootRel) {
  // The runfiles manifest maps runfiles-relative paths (entries under the
  // nm tree root) to absolute paths; the tree root is any entry minus its
  // relative suffix. Execroot paths (bazel-out/<cfg>/bin/<pkg>/node_modules)
  // map to <_main>/<pkg>/node_modules in the runfiles tree.
  const runfilesManifest = path.join(runfilesRoot, "MANIFEST");
  let runfilesRel = "_main/" + (nmRootRel.startsWith("bazel-out/")
      ? nmRootRel.slice(nmRootRel.indexOf("/bin/") + 5)
      : nmRootRel);
  runfilesRel = runfilesRel.replace(/\/\//g, "/");
  if (fs.existsSync(runfilesManifest)) {
    for (const line of fs.readFileSync(runfilesManifest, "utf8").split("\n")) {
      const sep = line.indexOf(" ");
      if (sep > 0 && line.slice(0, sep).startsWith(runfilesRel + "/")) {
        const abs = line.slice(sep + 1);
        return abs.slice(0, abs.length - (line.slice(0, sep).length - runfilesRel.length));
      }
    }
  }
  console.error("dev_driver: node_modules tree not found in the runfiles manifest at " + runfilesRel);
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packagedModules = spec.packaged_modules || [];
const nativeAddons = spec.native_addons || [];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rules_electron_dev_"));
const distDir = path.join(stage, "dist");
fs.mkdirSync(distDir, { recursive: true });

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

function copyDirContents(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    if (fs.statSync(from).isDirectory()) {
      copyRecursive(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    if (fs.statSync(from).isDirectory()) {
      copyRecursive(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function stageInto(source, destination) {
  // Bundle directories merge their CONTENTS into the destination (same
  // semantics as the packaging stage).
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    copyDirContents(source, destination);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

for (const entry of spec.bundles) {
  stageInto(resolveInput(entry.src), path.join(stage, entry.dest));
}

for (const entry of spec.resources) {
  stageInto(resolveInput(entry.src), path.join(stage, entry.dest));
}

const appPackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (fs.existsSync(path.join(stage, appMain))) {
  appPackage.main = appMain;
} else {
  appPackage.main = path.join("dist", appMain);
}
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
const stageNm = path.join(stage, "node_modules");
fs.mkdirSync(stageNm, { recursive: true });
// Per-entry symlinks into the linked tree, so packaged modules can be
// real directories (their injected .node files need writable locations).
for (const entry of fs.readdirSync(nodeModulesRoot)) {
  fs.symlinkSync(path.join(nodeModulesRoot, entry), path.join(stageNm, entry), "dir");
}
const resolveLinked = (name) => {
  const direct = path.join(nodeModulesRoot, name);
  if (fs.existsSync(path.join(direct, "package.json"))) {
    return direct;
  }
  // Transitives live only in the aspect store: .aspect_rules_js/<name>@<ver>/node_modules/<name>
  const store = path.join(nodeModulesRoot, ".aspect_rules_js");
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
};
for (const name of packagedModules) {
  const source = resolveLinked(name);
  if (!source) {
    console.error("dev_driver: packaged module " + name + " not found in the linked node_modules");
    process.exit(2);
  }
  const real = path.join(stage, "node_modules_real", name);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  execSync(`cp -RL ${JSON.stringify(source)} ${JSON.stringify(real)}`);
  execSync(`chmod -R u+w ${JSON.stringify(real)}`);
  fs.rmSync(path.join(stageNm, name), { force: true });
  fs.symlinkSync(real, path.join(stageNm, name), "dir");
}
for (const addon of nativeAddons) {
  const releaseDir = path.join(stage, "node_modules_real", addon.pkg, "build", "Release");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(resolveInput(addon.rel), path.join(releaseDir, path.basename(addon.rel)));
}

function electronExecutable(stageRoot) {
  const dist = path.join(stageRoot, "electron-dist");
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app/Contents/MacOS/Electron");
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe");
  }
  return path.join(dist, "electron");
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
child.on("exit", (code, signalName) => {
  removeStage();
  process.exit(signalName ? 130 : (code ?? 0));
});
