// Process-wide settings shared by the CLI and the GitHub Action.
// Values are applied once in main() via setSettings() and read at call time.

const DEFAULT_MAX_FILE_MB = 5;

let migrationDirs = [];
let maxFileSizeMb = undefined;

function normalizeDir(dir) {
  return String(dir)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

export function setSettings({ migrationDirs: dirs, maxFileSizeMb: limit } = {}) {
  const list = dirs === undefined || dirs === null ? [] : (Array.isArray(dirs) ? dirs : [dirs]);
  migrationDirs = list.map(normalizeDir).filter(Boolean);
  maxFileSizeMb = typeof limit === "number" ? limit : undefined;
}

export function resetSettings() {
  migrationDirs = [];
  maxFileSizeMb = undefined;
}

export function getMigrationDirs() {
  return migrationDirs.slice();
}

export function getMaxFileMb() {
  return typeof maxFileSizeMb === "number" ? maxFileSizeMb : DEFAULT_MAX_FILE_MB;
}

export function getMaxFileBytes() {
  return getMaxFileMb() * 1024 * 1024;
}
