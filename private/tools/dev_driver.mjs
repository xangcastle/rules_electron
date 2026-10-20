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
  const inRunfilesTree = path.join(runfilesRoot, nodeModulesRunfilesRel);
  if (fs.existsSync(inRunfilesTree)) {
    return inRunfilesTree;
  }
  if (fs.existsSync(runfilesManifest)) {
    for (const line of fs.readFileSync(runfilesManifest, "utf8").split("\n")) {
      const sep = line.indexOf(" ");
      const target = line.slice(sep + 1);
      if (sep > 0 && line.slice(0, sep).startsWith(nodeModulesRunfilesRel + "/") && path.isAbsolute(target)) {
        return target.slice(0, target.length - (line.slice(0, sep).length - nodeModulesRunfilesRel.length));
      }
    }
  }
  console.error("dev_driver: node_modules tree not found in the runfiles at " + nodeModulesRunfilesRel);
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

let electron = null;
let devServer = null;
let shuttingDown = false;

function isRunning(child) {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

function signalProcessGroup(child, signalName) {
  if (!isRunning(child)) {
    return;
  }
  try {
    process.kill(-child.pid, signalName);
  } catch {
    try { child.kill(signalName); } catch {}
  }
}

function shutdown(exitCode, signalName = "SIGTERM") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  signalProcessGroup(devServer, signalName);
  if (isRunning(electron)) {
    electron.kill(signalName);
  }
  const finish = () => {
    removeStage();
    process.exit(exitCode);
  };
  const survivors = [devServer, electron].filter(isRunning);
  if (survivors.length === 0) {
    finish();
    return;
  }
  const escalation = setTimeout(() => {
    signalProcessGroup(devServer, "SIGKILL");
    if (isRunning(electron)) {
      electron.kill("SIGKILL");
    }
  }, 3000);
  const hardStop = setTimeout(finish, 6000);
  let remaining = survivors.length;
  for (const survivor of survivors) {
    survivor.once("exit", () => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(escalation);
        clearTimeout(hardStop);
        finish();
      }
    });
  }
}

for (const [signalName, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signalName, () => shutdown(exitCode, signalName));
}

function copyTreeContents(source, destination) {
  if (!fs.statSync(source).isDirectory()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return;
  }
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

const DEV_SERVER_TIMEOUT_MS = 60_000;

async function waitForDevServer(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(child)) {
      return "exited";
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return "ready";
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "timeout";
}

const electronEnv = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" };

if (spec.dev_server) {
  const { executable, url, env: urlVariable, environment, app_env_keys: appEnvKeys } = spec.dev_server;
  const serverEnvironment = { ...process.env };
  for (const key of appEnvKeys ?? []) {
    delete serverEnvironment[key];
  }
  Object.assign(serverEnvironment, environment);
  devServer = spawn(resolveInput(executable), [], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: serverEnvironment,
  });
  devServer.on("exit", (exitCode, signalName) => {
    if (!shuttingDown) {
      console.error("dev_driver: the dev server exited (" + (signalName ?? exitCode) + ")" +
                    (isRunning(electron) ? "; stopping Electron" : " before Electron started"));
      shutdown(exitCode ?? 1);
    }
  });
  const outcome = await waitForDevServer(url, devServer, DEV_SERVER_TIMEOUT_MS);
  if (outcome === "timeout") {
    console.error("dev_driver: the dev server did not answer at " + url + " within " +
                  (DEV_SERVER_TIMEOUT_MS / 1000) + "s; is it listening on that URL?");
    shutdown(2);
  }
  if (outcome !== "ready") {
    await new Promise(() => {});
  }
  electronEnv[urlVariable] = url;
}

electron = spawn(electronBin, [stage, ...passthroughArgs], {
  cwd: stage,
  stdio: "inherit",
  env: electronEnv,
});
electron.on("exit", (exitCode, signalName) => {
  if (!shuttingDown) {
    shutdown(signalName ? 130 : (exitCode ?? 0));
  }
});
