import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

// Launches an Electron app against pre-built bundles. Stages an ephemeral
// tree (bundles -> dist/, resources at their package-relative paths, the
// app package.json with main patched to the entry), extracts the pinned
// Electron zip, symlinks the linked node_modules, and executes Electron
// with stdio inherited. The stage is removed on exit; Ctrl+C reaches the
// app through signal forwarding.
//
// argv contract (positions fixed by the rule's embedded_args):
//   [2] package.json absolute path (a resolved runfile arg)
//   [3] electron zip absolute path, or "-" when the app has none
//   [4] bundle count
//   [5] resource count
//   [6] app_main (package-relative entry, becomes package.json main)
//   [7..7+bundleCount)  bundle paths, absolute or runfiles-root-relative
//   [..+resourceCount)  resource paths, package-relative
//   then passthrough args from bazel run.

// argv: <manifest_abs> — everything else comes from the manifest.
const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("dev_driver: expected <manifest>");
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundleRels = spec.bundles;
const resourceRels = spec.resources;
const passthroughArgs = [];
const appMain = spec.app_main;
const packageJsonPath = process.argv[3];
const electronZipPath = process.argv[4] !== "-" ? process.argv[4] : null;

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
  // Resolved runfile args are absolute; embedded rels are main-repo
  // runfiles-root relative.
  return path.isAbsolute(p) ? p : path.join(runfilesRoot, "_main", p);
}

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

function stageInto(source, destination) {
  // Bundle directories merge their CONTENTS into the destination (same
  // semantics as the packaging stage).
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    copyDirContents(source, destination);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function copyDirContents(src, dest) {
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
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

for (const entry of bundleRels) {
  stageInto(resolveInput(entry.src), distDir);
}

for (const entry of resourceRels) {
  stageInto(resolveInput(entry.src), path.join(stage, entry.dest));
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

const runfilesNodeModules = path.join(runfilesRoot, "_main", "node_modules");
if (fs.existsSync(runfilesNodeModules)) {
  fs.symlinkSync(runfilesNodeModules, path.join(stage, "node_modules"), "dir");
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
