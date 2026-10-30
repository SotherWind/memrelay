#!/usr/bin/env node
/*
 * MemRelay bootstrap entry.
 * Written in old CommonJS syntax on purpose: it must load and run on any
 * Node that can parse it (>= 14), even though the real CLI needs >= 22.16.
 * Its only job: find a suitable Node, re-launch the bundled CLI with it.
 */
"use strict";

var fs = require("fs");
var os = require("os");
var path = require("path");
var url = require("url");
var childProcess = require("child_process");

var MIN_MAJOR = 22;
var MIN_MINOR = 16;
var EXIT_ENV = 2;

function parseVersion(str) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(str || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function versionOk(v) {
  if (!v) return false;
  if (v.major > MIN_MAJOR) return true;
  if (v.major < MIN_MAJOR) return false;
  return v.minor >= MIN_MINOR;
}

function execName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function isExecutable(p) {
  try {
    var st = fs.statSync(p);
    if (!st.isFile()) return false;
  } catch (e) {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return p;
  }
}

function memrelayDir() {
  var override = process.env.MEMRELAY_HOME;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".memrelay");
}

function candidates() {
  var out = [];
  var dir = memrelayDir();

  try {
    var runtime = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8"));
    if (runtime && typeof runtime.node === "string") out.push(runtime.node);
    if (runtime && typeof runtime.nodeReal === "string") out.push(runtime.nodeReal);
  } catch (e) {
    /* no runtime.json yet */
  }

  var pathNode = null;
  try {
    pathNode = childProcess.execFileSync(process.platform === "win32" ? "where" : "which", ["node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    /* not on PATH */
  }
  if (pathNode) {
    var lines = String(pathNode).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) out.push(lines[i].trim());
    }
  }

  // 测试隔离用：只信 runtime.json 与 PATH，不扫描系统/版本管理器固定目录
  if (process.env.MEMRELAY_BOOT_NO_SYSTEM === "1") return out;

  var home = os.homedir();
  var listed = [
    path.join(home, ".volta", "bin", execName()),
    path.join(home, ".local", "share", "mise", "shims", execName()),
    path.join(home, ".asdf", "shims", execName()),
    path.join(home, ".local", "bin", execName()),
    path.join("/opt/homebrew/bin", "node"),
    path.join("/usr/local/bin", "node"),
    process.env.NVM_SYMLINK_DIR ? path.join(process.env.NVM_SYMLINK_DIR, "node") : null,
  ];
  for (var j = 0; j < listed.length; j++) {
    if (listed[j]) out.push(listed[j]);
  }

  var parentDirs = [
    path.join(home, ".nvm", "versions", "node"),
    process.env.NVM_DIR ? path.join(process.env.NVM_DIR, "versions", "node") : null,
    process.env.NVM_HOME ? path.join(process.env.NVM_HOME) : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, "nvm") : null,
    path.join(home, "AppData", "Roaming", "nvm"),
    path.join(home, "Library", "Application Support", "fnm", "node-versions"),
    path.join(home, ".local", "share", "fnm", "node-versions"),
    path.join(home, ".fnm", "node-versions"),
    path.join(home, ".local", "share", "mise", "installs", "node"),
    path.join(home, ".asdf", "installs", "nodejs"),
    path.join(home, ".nvm-windows"),
  ];

  var candidatesFromDirs = [];
  for (var k = 0; k < parentDirs.length; k++) {
    var parent = parentDirs[k];
    if (!parent) continue;
    var entries;
    try {
      entries = fs.readdirSync(parent);
    } catch (e) {
      continue;
    }
    for (var n = 0; n < entries.length; n++) {
      var entry = entries[n];
      candidatesFromDirs.push(
        path.join(parent, entry, "bin", execName()),
        path.join(parent, entry, execName()),
        path.join(parent, entry, "installation", execName()),
        path.join(parent, entry, execName()),
      );
    }
  }

  function versionOf(p) {
    var m = /v?(\d+)\.(\d+)\.(\d+)/.exec(p.replace(/\\/g, "/"));
    return m ? Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]) : -1;
  }
  candidatesFromDirs.sort(function (a, b) {
    return versionOf(b) - versionOf(a);
  });

  for (var q = 0; q < candidatesFromDirs.length; q++) out.push(candidatesFromDirs[q]);

  var seen = {};
  var result = [];
  for (var r = 0; r < out.length; r++) {
    var p = out[r];
    if (!p || seen[p]) continue;
    seen[p] = true;
    result.push(p);
  }
  return result;
}

function nodeVersionOf(bin) {
  try {
    var out = childProcess.execFileSync(bin, ["-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    var parsed = parseVersion(String(out).trim());
    debugLog("raw out for " + bin + ": " + JSON.stringify(String(out).trim()));
    return parsed;
  } catch (e) {
    var why = e && (e.message || e.code || e.toString());
    debugLog("exec failed for " + bin + ": " + String(why).split("\n")[0]);
    return null;
  }
}

function debugLog(msg) {
  if (process.env.MEMRELAY_BOOT_DEBUG) process.stderr.write("[boot] " + msg + "\n");
}

function findNode() {
  var list = candidates();
  debugLog("candidates: " + JSON.stringify(list));
  for (var i = 0; i < list.length; i++) {
    var bin = list[i];
    if (!isExecutable(bin)) { debugLog("skip not-executable: " + bin); continue; }
    var v = nodeVersionOf(bin);
    debugLog("try " + bin + " -> " + (v ? v.major + "." + v.minor + "." + v.patch : "null"));
    if (versionOk(v)) return bin;
  }
  return null;
}

function cliPath() {
  var dir = memrelayDir();
  var packaged = path.join(__dirname, "..", "dist", "cli.mjs");
  if (fs.existsSync(packaged)) return packaged;
  var runtimeCli = path.join(dir, "runtime", "cli.mjs");
  if (fs.existsSync(runtimeCli)) return runtimeCli;
  return packaged;
}

function failNoNode(reason) {
  /* 写给 agent 看：纯英文，避开终端代码页问题 */
  var msg = [
    "MemRelay: no suitable Node.js runtime found.",
    "MemRelay needs Node.js >= " + MIN_MAJOR + "." + MIN_MINOR + " (found: " + reason + ").",
    "",
    "Install Node.js >= 22.16 (https://nodejs.org or nvm), then run: memrelay doctor",
    "",
  ].join("\n");
  process.stderr.write(msg + "\n");
  process.exitCode = EXIT_ENV;
}

function launch(nodeBin, cli, args) {
  var result = childProcess.spawnSync(nodeBin, [cli].concat(args), {
    stdio: ["inherit", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write("MemRelay: failed to launch Node at " + nodeBin + ": " + result.error.message + "\n");
    process.exitCode = EXIT_ENV;
    return;
  }
  process.exitCode = typeof result.status === "number" ? result.status : EXIT_ENV;
}

/**
 * 当前 Node 可用（常态）时直接在本进程加载 CLI：省掉一次 Node 启动（约 0.2s）。
 * MEMRELAY_CLI_PATH 告诉 CLI 自己来自哪个 bundle——setup 记录启动脚本要用它。
 */
function runInProcess(cli, args) {
  process.env.MEMRELAY_CLI_PATH = cli;
  import(url.pathToFileURL(cli).href).then(
    function (mod) {
      return mod.main(args);
    }
  ).then(
    function (code) {
      process.exitCode = typeof code === "number" ? code : 0;
    },
    function (err) {
      process.stderr.write(
        "MemRelay: failed to load CLI at " + cli + ": " + (err && err.message ? err.message : err) + "\n",
      );
      process.exitCode = EXIT_ENV;
    }
  );
}

function main() {
  var args = process.argv.slice(2);
  /* 测试缝：用假的 Node 版本号驱动入口逻辑（不影响真实运行） */
  var effectiveVersion = process.env.MEMRELAY_FAKE_NODE_VERSION || process.versions.node;

  var cli = cliPath();
  if (!fs.existsSync(cli)) {
    process.stderr.write(
      "MemRelay: CLI bundle not found at " + cli + "\nRun: npm i -g memrelay && memrelay setup\n",
    );
    process.exitCode = EXIT_ENV;
    return;
  }

  if (versionOk(parseVersion(effectiveVersion))) {
    if (!process.env.MEMRELAY_FAKE_NODE_VERSION) {
      runInProcess(cli, args);
      return;
    }
    launch(process.execPath, cli, args);
    return;
  }

  var found = findNode();
  if (!found) {
    failNoNode("current Node is " + effectiveVersion);
    return;
  }
  launch(found, cli, args);
}

main();
