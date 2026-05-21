#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { type: "patch", version: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--type" || arg === "-t") args.type = argv[++i] ?? args.type;
    else if (arg === "--version" || arg === "-v") args.version = argv[++i] ?? "";
    else if (!arg.startsWith("-")) args.type = arg;
  }
  return args;
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`Invalid semver version: ${version}`);
  return match.slice(1, 4).map(Number);
}

function nextVersion(current, type, explicitVersion) {
  if (explicitVersion) {
    const normalized = explicitVersion.replace(/^v/, "");
    parseVersion(normalized);
    return normalized;
  }

  const [major, minor, patch] = parseVersion(current);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  if (type === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump type: ${type}. Use patch, minor, major, or --version x.y.z`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function replaceVersionInToml(path, packageName, version) {
  const source = readFileSync(path, "utf8");
  let inPackage = false;
  let sawName = false;

  const updated = source
    .split("\n")
    .map((line) => {
      if (line.trim() === "[[package]]" || line.trim() === "[package]") {
        inPackage = true;
        sawName = false;
        return line;
      }

      if (inPackage && line.startsWith("[") && line.trim() !== "[package]" && line.trim() !== "[[package]]") {
        inPackage = false;
        sawName = false;
      }

      if (inPackage && line === `name = "${packageName}"`) {
        sawName = true;
        return line;
      }

      if (inPackage && sawName && line.startsWith("version = ")) {
        sawName = false;
        return `version = "${version}"`;
      }

      return line;
    })
    .join("\n");

  writeFileSync(path, updated);
}

const { type, version: explicitVersion } = parseArgs(process.argv.slice(2));

const packageJsonPath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const tauriConfigPath = resolve(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = resolve(root, "src-tauri", "Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri", "Cargo.lock");

const packageJson = readJson(packageJsonPath);
const version = nextVersion(packageJson.version, type, explicitVersion);

packageJson.version = version;
writeJson(packageJsonPath, packageJson);

const packageLock = readJson(packageLockPath);
packageLock.version = version;
if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
writeJson(packageLockPath, packageLock);

const tauriConfig = readJson(tauriConfigPath);
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

replaceVersionInToml(cargoTomlPath, "flashkit", version);
replaceVersionInToml(cargoLockPath, "flashkit", version);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag_name=v${version}\n`, { flag: "a" });
}

console.log(version);
