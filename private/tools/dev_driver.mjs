import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

// Launches an Electron app against pre-built bundles. Stages an ephemeral
// dist/ from runfiles, extracts the pinned Electron zip, symlinks the linked
// node_modules, and executes Electron with stdio inherited. The stage is
// removed on exit; Ctrl+C reaches the app through signal forwarding.
//
// argv contract: <bundle_count> <package_json> <electron_zip|-> <app_main>
// <bundle...> <passthrough...>

const [countRaw, packageJsonRel, electronZipRel, appMain, ...rest] =
  process.argv.slice(2);

const bundleCount = Number(countRaw);
if (
  !Number.isInteger(bundleCount) ||
  bundleCount < 0 ||
  !packageJsonRel ||
  electronZipRel === undefined ||
  !appMain
) {
  console.error(
    "dev_driver: expected <bundle_count> <package_json> <electron_zip|-> <app_main> <bundle...> [args...]",
  );
  process.exit(2);
}

const bundleRels = rest.slice(0, bundleCount);
const passthroughArgs = rest.slice(bundleCount);

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

function resolveRunfilesPath(runfilesRelativePath) {
  const absolutePath = path.join(runfilesRoot, runfilesRelativePath);
  if (!fs.existsSync(absolutePath)) {
    console.error("dev_driver: not found in runfiles at " + absolutePath);
    process.exit(2);
  }
  return absolutePath;
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

for (const rel of bundleRels) {
  const source = resolveRunfilesPath(rel);
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(source)) {
      const from = path.join(source, entry);
      const to = path.join(distDir, entry);
      fs.rmSync(to, { recursive: true, force: true });
      execSync(`cp -R ${JSON.stringify(from)} ${JSON.stringify(to)}`);
    }
  } else {
    fs.copyFileSync(source, path.join(distDir, path.basename(rel)));
  }
}

fs.copyFileSync(resolveRunfilesPath(packageJsonRel), path.join(stage, "package.json"));

if (electronZipRel !== "-") {
  const zipPath = resolveRunfilesPath(electronZipRel);
  const electronDist = path.join(stage, "electron-dist");
  fs.mkdirSync(electronDist, { recursive: true });
  execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(electronDist)}`, { stdio: "ignore" });
}

// The whole linked node_modules tree rides in runfiles under the workspace
// root; symlink it so runtime requires resolve during development.
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
