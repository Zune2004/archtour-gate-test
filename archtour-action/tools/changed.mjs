import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFacts } from "./facts.mjs";
import { isCandidateSource, shouldSkipDir, DEFAULT_TEST_DIR_NAMES } from "./scan.mjs";
import { isSqlMigrationCandidate } from "./facts-sql.mjs";
import { isGraphQLFile } from "./facts-graphql.mjs";
import YAML from "yaml";
import { computeBlobSha, FactsCache } from "./facts-cache.mjs";

const execFileAsync = promisify(execFile);

/**
 * Checks whether a directory is inside a Git repository.
 */
export async function isInsideGitRepo(dir = ".") {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: path.resolve(dir),
      encoding: "utf8"
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Gets the top-level root directory of the Git repository.
 */
export async function getGitRoot(dir = ".") {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.resolve(dir),
      encoding: "utf8"
    });
    return path.resolve(stdout.trim());
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Resolves the merge-base between <ref> and HEAD.
 * Falls back to resolving <ref> directly if merge-base fails.
 */
export async function getMergeBase(repoDir, ref) {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", ref, "HEAD"], {
      cwd: repoDir,
      encoding: "utf8"
    });
    const mb = stdout.trim();
    if (mb) return mb;
  } catch {}

  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoDir,
    encoding: "utf8"
  });
  return stdout.trim();
}

function parseNameStatusZ(stdout, renames) {
  const files = [];
  const tokens = stdout.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) break;
    const statusCode = status[0];
    if (statusCode === "R" || statusCode === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        const normOld = oldPath.replace(/\\/g, "/");
        const normNew = newPath.replace(/\\/g, "/");
        if (statusCode === "R") {
          renames.set(normNew, normOld);
        }
        files.push(normNew);
      }
    } else {
      const p = tokens[i++];
      if (p) {
        files.push(p.replace(/\\/g, "/"));
      }
    }
  }
  return files;
}

/**
 * Lists files changed between mergeBase and HEAD.
 * Uses `git diff -M --name-status -z <mergebase> HEAD` (+ untracked if opts.includeUntracked).
 */
export async function getChangedFiles(repoDir, mergeBase, opts = {}) {
  const renames = opts.renames instanceof Map ? opts.renames : new Map();

  const diffOutput = await execFileAsync("git", ["diff", "-M", "--name-status", "-z", mergeBase, "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  const files = parseNameStatusZ(diffOutput.stdout, renames);

  if (opts.includeUntracked) {
    try {
      const untrackedOutput = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024
      });
      const untracked = untrackedOutput.stdout.split("\0").filter(Boolean);
      files.push(...untracked.map(p => p.replace(/\\/g, "/")));
    } catch {}
  }

  // Also include any uncommitted working tree modifications
  try {
    const wtDiff = await execFileAsync("git", ["diff", "-M", "--name-status", "-z", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
    const wtFiles = parseNameStatusZ(wtDiff.stdout, renames);
    files.push(...wtFiles);
  } catch {}

  const unique = Array.from(new Set(files.map(p => p.replace(/\\/g, "/"))));
  unique.renames = renames;
  return unique;
}

// Prisma keeps each migration in its own folder: prisma/migrations/<timestamp>_<name>/migration.sql. A changed
// migration.sql must be replayed with every sibling migration under the `migrations` folder, not only its own folder,
// or the base schema looks empty and index/type findings disappear on the PR path.
function prismaMigrationsRootFor(relPath) {
  const parts = String(relPath || "").replace(/\\/g, "/").split("/");
  if (parts.length < 3) return null;
  if (parts[parts.length - 1] !== "migration.sql") return null;
  const folder = parts[parts.length - 2];
  const parent = parts[parts.length - 3];
  if (!folder || parent !== "migrations") return null;
  return parts.slice(0, -2).join("/");
}

// A real Prisma migrations folder holds migration_lock.toml or at least one <timestamp>_<name>/migration.sql.
async function hasPrismaMigrationsEvidence(repoDir, mergeBase, root) {
  const headRoot = path.join(repoDir, ...root.split("/"));
  try {
    if (fs.existsSync(path.join(headRoot, "migration_lock.toml"))) return true;
    if (fs.existsSync(headRoot)) {
      for (const entry of fs.readdirSync(headRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(headRoot, entry.name, "migration.sql"))) return true;
      }
    }
  } catch {}
  try {
    const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", mergeBase, "--", root], {
      cwd: repoDir,
      encoding: "utf8"
    });
    const files = stdout.split("\0").filter(Boolean).map(f => f.replace(/\\/g, "/"));
    if (files.includes(`${root}/migration_lock.toml`)) return true;
    if (files.some(f => f.endsWith("/migration.sql"))) return true;
  } catch {}
  return false;
}

/**
 * Expands candidates for formats requiring directory-level cumulative replay (SQL migrations)
 * or directory-level SDL schema composition (GraphQL).
 */
export async function expandDirectoryCandidates(repoDir, mergeBase, candidatePaths, opts = {}) {
  const resultPaths = new Set(candidatePaths);

  const sqlDirs = new Set();
  const graphqlDirs = new Set();
  const prismaDirs = new Set();
  const prismaMigrationRoots = new Set();

  for (const p of candidatePaths) {
    const filename = p.split("/").pop();
    if (isSqlMigrationCandidate(p, path.join(repoDir, p), filename)) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
      sqlDirs.add(dir);
      const prismaRoot = prismaMigrationsRootFor(p);
      if (prismaRoot) prismaMigrationRoots.add(prismaRoot);
    }
    if (opts.renames && opts.renames.has(p)) {
      const oldP = opts.renames.get(p);
      const oldFilename = oldP.split("/").pop();
      if (isSqlMigrationCandidate(oldP, path.join(repoDir, oldP), oldFilename)) {
        const oldDir = oldP.includes("/") ? oldP.slice(0, oldP.lastIndexOf("/")) : ".";
        sqlDirs.add(oldDir);
        const oldPrismaRoot = prismaMigrationsRootFor(oldP);
        if (oldPrismaRoot) prismaMigrationRoots.add(oldPrismaRoot);
      }
    }
    if (isGraphQLFile(p)) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
      graphqlDirs.add(dir);
    }
    // T-107b: Prisma may split the schema into prisma/schema/*.prisma. A field's type can be a model declared in a
    // sibling file, so every .prisma file in the same directory must be parsed to know the model names.
    if (/\.prisma$/i.test(p)) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
      prismaDirs.add(dir);
    }
  }

  // 1. SQL Migration directories: find all migration files in each directory on base and head
  for (const dir of sqlDirs) {
    // Base: git ls-tree
    try {
      const lsArgs = ["ls-tree", "-r", "--name-only", "-z", mergeBase];
      if (dir !== ".") lsArgs.push("--", dir);
      const { stdout } = await execFileAsync("git", lsArgs, { cwd: repoDir, encoding: "utf8" });
      for (const f of stdout.split("\0").filter(Boolean)) {
        const norm = f.replace(/\\/g, "/");
        const fname = norm.split("/").pop();
        if (isCandidateSource(norm, opts) && isSqlMigrationCandidate(norm, norm, fname)) {
          resultPaths.add(norm);
        }
      }
    } catch {}

    // Head: disk
    const diskDir = dir === "." ? repoDir : path.join(repoDir, dir);
    if (fs.existsSync(diskDir)) {
      try {
        const entries = fs.readdirSync(diskDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const relP = (dir === "." ? entry.name : `${dir}/${entry.name}`).replace(/\\/g, "/");
            const fullP = path.join(diskDir, entry.name);
            if (isCandidateSource(relP, opts) && isSqlMigrationCandidate(relP, fullP, entry.name)) {
              resultPaths.add(relP);
            }
          }
        }
      } catch {}
    }
  }

  // 1b. Prisma per-folder migrations: every <folder>/migration.sql under the migrations root, in folder-name order
  // (the final sort is numeric, so timestamp folder names replay in order).
  for (const root of prismaMigrationRoots) {
    if (!(await hasPrismaMigrationsEvidence(repoDir, mergeBase, root))) continue;

    // Base: git ls-tree over the migrations root
    try {
      const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", mergeBase, "--", root], {
        cwd: repoDir,
        encoding: "utf8"
      });
      const depth = root.split("/").length + 2;
      for (const f of stdout.split("\0").filter(Boolean)) {
        const norm = f.replace(/\\/g, "/");
        const parts = norm.split("/");
        if (parts.length !== depth || parts[parts.length - 1] !== "migration.sql") continue;
        if (isCandidateSource(norm, opts)) resultPaths.add(norm);
      }
    } catch {}

    // Head: disk
    const diskRoot = path.join(repoDir, ...root.split("/"));
    if (fs.existsSync(diskRoot)) {
      try {
        for (const entry of fs.readdirSync(diskRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const fullP = path.join(diskRoot, entry.name, "migration.sql");
          const relP = `${root}/${entry.name}/migration.sql`;
          if (fs.existsSync(fullP) && isCandidateSource(relP, opts)) resultPaths.add(relP);
        }
      } catch {}
    }
  }

  // 2. GraphQL directories
  for (const dir of graphqlDirs) {
    // Base: git ls-tree
    try {
      const lsArgs = ["ls-tree", "-r", "--name-only", "-z", mergeBase];
      if (dir !== ".") lsArgs.push("--", dir);
      const { stdout } = await execFileAsync("git", lsArgs, { cwd: repoDir, encoding: "utf8" });
      for (const f of stdout.split("\0").filter(Boolean)) {
        const norm = f.replace(/\\/g, "/");
        if (isCandidateSource(norm, opts) && isGraphQLFile(norm)) {
          resultPaths.add(norm);
        }
      }
    } catch {}

    // Head: disk
    const diskDir = dir === "." ? repoDir : path.join(repoDir, dir);
    if (fs.existsSync(diskDir)) {
      try {
        const entries = fs.readdirSync(diskDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const relP = (dir === "." ? entry.name : `${dir}/${entry.name}`).replace(/\\/g, "/");
            if (isCandidateSource(relP, opts) && isGraphQLFile(relP)) {
              resultPaths.add(relP);
            }
          }
        }
      } catch {}
    }
  }

  // 3. Prisma schema directories (prismaSchemaFolder): same-directory sibling .prisma files only
  for (const dir of prismaDirs) {
    // Base: git ls-tree
    try {
      const lsArgs = ["ls-tree", "-r", "--name-only", "-z", mergeBase];
      if (dir !== ".") lsArgs.push("--", dir);
      const { stdout } = await execFileAsync("git", lsArgs, { cwd: repoDir, encoding: "utf8" });
      for (const f of stdout.split("\0").filter(Boolean)) {
        const norm = f.replace(/\\/g, "/");
        const normDir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : ".";
        if (normDir === dir && isCandidateSource(norm, opts) && /\.prisma$/i.test(norm)) {
          resultPaths.add(norm);
        }
      }
    } catch {}

    // Head: disk
    const diskDir = dir === "." ? repoDir : path.join(repoDir, dir);
    if (fs.existsSync(diskDir)) {
      try {
        const entries = fs.readdirSync(diskDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const relP = (dir === "." ? entry.name : `${dir}/${entry.name}`).replace(/\\/g, "/");
            if (isCandidateSource(relP, opts) && /\.prisma$/i.test(entry.name)) {
              resultPaths.add(relP);
            }
          }
        }
      } catch {}
    }
  }

  return Array.from(resultPaths).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
}

/**
 * Extracts facts for a set of candidate files with cache support.
 * Standalone files (Prisma, Compose, OpenAPI, K8s, Proto) are cached per blob SHA.
 * SQL migrations and GraphQL are parsed per directory.
 */
export async function extractFactsWithCache(files, cache = null, opts = {}) {
  const entities = [];
  const relations = [];
  const sources = [];
  const errors = [];
  const parseErrors = [];
  const skipped = [];
  const graphqlSchemas = [];

  const standaloneFiles = [];
  const sqlFiles = [];
  const graphqlFilesByDir = new Map();

  for (const f of files) {
    if (f.error) {
      const errEntry = { file: f.path, path: f.path, line: 1, error: f.error, message: f.error };
      errors.push(errEntry);
      parseErrors.push(errEntry);
      continue;
    }
    const filename = f.path.split("/").pop();
    if (isSqlMigrationCandidate(f.path, f.fullPath, filename)) {
      sqlFiles.push(f);
    } else if (isGraphQLFile(f.path)) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
      if (!graphqlFilesByDir.has(dir)) graphqlFilesByDir.set(dir, []);
      graphqlFilesByDir.get(dir).push(f);
    } else {
      standaloneFiles.push(f);
    }
  }

  // 1. Standalone candidate files
  for (const f of standaloneFiles) {
    let facts = null;
    if (cache && f.sha) {
      facts = cache.get(f.sha, f.path);
    }
    if (!facts) {
      facts = extractFacts([f], opts);
      if (cache && f.sha) {
        cache.set(f.sha, facts);
      }
    }
    entities.push(...(facts.entities || []));
    relations.push(...(facts.relations || []));
    sources.push(...(facts.sources || []));
    errors.push(...(facts.errors || []));
    if (facts.parseErrors) parseErrors.push(...facts.parseErrors);
    // Skipped files (size cap, Helm templates) must reach the rule evaluator in --changed-from mode too, or a new
    // manifest skipped as a Helm template passes silently.
    if (facts.skipped) skipped.push(...facts.skipped);
  }

  // 2. Cumulative SQL migration files
  if (sqlFiles.length > 0) {
    sqlFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
    const sqlRes = extractFacts(sqlFiles, opts);
    entities.push(...(sqlRes.entities || []));
    relations.push(...(sqlRes.relations || []));
    sources.push(...(sqlRes.sources || []));
    errors.push(...(sqlRes.errors || []));
    if (sqlRes.parseErrors) parseErrors.push(...sqlRes.parseErrors);
    if (sqlRes.skipped) skipped.push(...sqlRes.skipped);
  }

  // 3. GraphQL schema files
  for (const [dir, gFiles] of graphqlFilesByDir.entries()) {
    gFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
    const gRes = extractFacts(gFiles, opts);
    entities.push(...(gRes.entities || []));
    relations.push(...(gRes.relations || []));
    sources.push(...(gRes.sources || []));
    errors.push(...(gRes.errors || []));
    if (gRes.parseErrors) parseErrors.push(...gRes.parseErrors);
    if (gRes.skipped) skipped.push(...gRes.skipped);
    if (gRes._graphqlSchemas) graphqlSchemas.push(...gRes._graphqlSchemas);
  }

  return {
    entities,
    relations,
    sources,
    errors,
    parseErrors,
    skipped,
    _graphqlSchemas: graphqlSchemas
  };
}

/**
 * Reads multiple git objects using a single `git cat-file --batch` process.
 * queries: array of `<rev>:<path>` strings.
 * Returns Map of query -> { sha, size, content, buffer } | null (null when missing).
 */
export async function batchCatFile(repoDir, queries) {
  if (!queries || queries.length === 0) return new Map();

  // De-duplicate first: results are keyed by query, so the same query twice would collapse into one answer while the
  // integrity check below counts answers, not requests.
  const uniqueQueries = Array.from(new Set(queries));

  // Split queries into two groups: paths whose git object reference contains no newline/CR
  // (safe for line-based cat-file --batch) and paths that contain them (must use per-file fallback).
  const safeQueries = [];
  const problemQueries = [];
  for (const q of uniqueQueries) {
    const colonIdx = q.indexOf(":");
    const pathPart = colonIdx === -1 ? q : q.slice(colonIdx + 1);
    if (pathPart.includes("\n") || pathPart.includes("\r")) {
      problemQueries.push(q);
    } else {
      safeQueries.push(q);
    }
  }

  const results = new Map();

  // Read the safe batch first. Every requested query must come back with an answer (an entry, possibly null for a
  // path that is missing in that revision). No answer means the batch was misaligned and every later answer may
  // belong to another file, which would silently turn a changed migration into a new one.
  if (safeQueries.length > 0) {
    const batchResults = await batchCatFileSafe(repoDir, safeQueries);
    for (const q of safeQueries) {
      if (!batchResults.has(q)) {
        throw new Error(`git cat-file --batch returned no entry for "${q}" (read ${batchResults.size} of ${safeQueries.length} requested objects)`);
      }
      results.set(q, batchResults.get(q));
    }
  }

  // Read problem paths with the per-file fallback: git show <rev>:<path> with the path as one argv element.
  for (const q of problemQueries) {
    try {
      const { stdout } = await execFileAsync("git", ["show", q], {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 100 * 1024 * 1024
      });
      const content = stdout.replace(/^\uFEFF/, "");
      const sha = computeBlobSha(content);
      results.set(q, { sha, size: Buffer.byteLength(content, "utf8"), buffer: Buffer.from(content, "utf8"), content });
    } catch (err) {
      const msg = String(err.message || err.stderr || "");
      if (msg.includes("not found") || msg.includes("does not exist") || msg.includes("but not in") || msg.includes("unknown revision") || msg.includes("bad object")) {
        results.set(q, null);
      } else {
        throw new Error(`git show ${q} failed: ${msg}`);
      }
    }
  }

  // Fail closed: the number of answers must equal the number of distinct objects requested.
  if (results.size !== uniqueQueries.length) {
    throw new Error(`git cat-file batch integrity failure: read ${results.size} of ${uniqueQueries.length} requested objects`);
  }

  return results;
}

/**
 * Parses the stdout of `git cat-file --batch` for the given queries.
 * Throws when the stream does not contain exactly one answer per query: an answer that belongs to another file would
 * otherwise be trusted, turning a changed applied migration into a new one.
 */
export function parseCatFileBatchOutput(queries, fullBuf) {
  const results = new Map();
  let offset = 0;

  for (const query of queries) {
    if (offset >= fullBuf.length) {
      throw new Error(`git cat-file --batch returned ${results.size} objects for ${queries.length} requested (stream ended early)`);
    }

    const nlIdx = fullBuf.indexOf(0x0A, offset);
    if (nlIdx === -1) {
      throw new Error(`git cat-file --batch returned ${results.size} objects for ${queries.length} requested (truncated header)`);
    }

    const header = fullBuf.toString("utf8", offset, nlIdx);
    if (header.endsWith(" missing")) {
      results.set(query, null);
      offset = nlIdx + 1;
    } else {
      const parts = header.split(" ");
      const sha = parts[0];
      const size = parseInt(parts[2], 10);
      const start = nlIdx + 1;
      const end = start + size;
      if (!sha || !Number.isInteger(size) || end > fullBuf.length) {
        throw new Error(`git cat-file --batch returned a malformed answer for "${query}"`);
      }
      const contentBuf = fullBuf.subarray(start, end);
      results.set(query, {
        sha,
        size,
        buffer: contentBuf,
        content: contentBuf.toString("utf8").replace(/^\uFEFF/, "")
      });
      offset = end + 1; // skip trailing \n
    }
  }

  if (results.size !== queries.length) {
    throw new Error(`git cat-file --batch returned ${results.size} objects for ${queries.length} requested`);
  }
  if (offset < fullBuf.length) {
    throw new Error(`git cat-file --batch returned more answers than requested (${queries.length} requested)`);
  }

  return results;
}

/**
 * Reads multiple git objects using a single `git cat-file --batch` process.
 * queries: array of `<rev>:<path>` strings that are known to contain no `\n` or `\r` in the path part.
 * Returns Map of query -> { sha, size, content, buffer } | null (null when missing).
 * Rejects when the process does not return exactly one answer per requested object.
 */
export async function batchCatFileSafe(repoDir, queries) {
  if (!queries || queries.length === 0) return new Map();

  // One line of stdin per query: duplicates would produce two answers but only one map entry.
  const uniqueQueries = Array.from(new Set(queries));

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", chunk => stdoutChunks.push(chunk));
    child.stderr.on("data", chunk => stderrChunks.push(chunk));

    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && stdoutChunks.length === 0) {
        const err = Buffer.concat(stderrChunks).toString("utf8");
        return reject(new Error(`git cat-file --batch exited with code ${code}: ${err}`));
      }

      const fullBuf = Buffer.concat(stdoutChunks);
      try {
        resolve(parseCatFileBatchOutput(uniqueQueries, fullBuf));
      } catch (err) {
        reject(err);
      }
    });

    const inputStr = uniqueQueries.map(q => `${q}\n`).join("");
    child.stdin.end(inputStr);
  });
}

/**
 * Loads changed facts for both base (via git show or batched git cat-file) and head (from disk).
 */
export async function getChangedFacts(repoDir, changedFromRef, opts = {}, cache = null) {
  const rootDir = await getGitRoot(repoDir);
  const mergeBase = await getMergeBase(rootDir, changedFromRef);
  // The scanned folder inside the repo ("" = repo root). Only files under it count, and fact paths are relative to it,
  // exactly like a full scan of that folder (dev compose ids and exceptions use these paths).
  const scope = repoScope(rootDir, repoDir);
  const inScope = (p) => !scope || p.startsWith(scope + "/");
  const display = (p) => (scope ? p.slice(scope.length + 1) : p);

  const renames = new Map();
  // 1. List changed files under the scanned folder
  const allChanged = await getChangedFiles(rootDir, mergeBase, { ...opts, renames });
  const rawChanged = allChanged.filter(inScope);

  // 2. Filter to candidate sources
  let candidateChanged = rawChanged.filter(p => isCandidateSource(display(p), opts));

  // If a migration was renamed or moved out of scope, add the old path to candidateChanged
  for (const [newPath, oldPath] of renames) {
    if (inScope(oldPath) && isCandidateSource(display(oldPath), opts) &&
        !(inScope(newPath) && isCandidateSource(display(newPath), opts))) {
      if (!candidateChanged.includes(oldPath)) {
        candidateChanged.push(oldPath);
      }
      renames.delete(newPath);
    }
  }

  // 3. Expand cumulative SQL migration and GraphQL directories
  const candidatePaths = (await expandDirectoryCandidates(rootDir, mergeBase, candidateChanged, { ...opts, renames })).filter(inScope);

  const baseFiles = [];
  const headFiles = [];

  // Head version from disk
  for (const relPath of candidatePaths) {
    const fullPath = path.resolve(rootDir, relPath);
    const shown = display(relPath);

    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
        const sha = computeBlobSha(content);
        headFiles.push({ path: shown, fullPath, content, sha });
      } catch (err) {
        headFiles.push({ path: shown, fullPath, content: "", error: err.message });
      }
    }
  }

  // Base version from git cat-file --batch (missing in base = added in head)
  // For a renamed non-migration file: read from old path, show under new path
  const batchQueries = [];
  const queryMeta = [];

  for (const relPath of candidatePaths) {
    const fullPath = path.resolve(rootDir, relPath);
    const shown = display(relPath);
    const filename = path.basename(relPath);
    const isMigration = isSqlMigrationCandidate(relPath, fullPath, filename);
    const oldPath = renames.get(relPath);
    const gitPath = (!isMigration && oldPath && inScope(oldPath) && isCandidateSource(display(oldPath), opts)) ? oldPath : relPath;
    const query = `${mergeBase}:${gitPath}`;

    batchQueries.push(query);
    queryMeta.push({ shown, fullPath, query });
  }

  const batchResults = await batchCatFile(rootDir, batchQueries);

  for (const meta of queryMeta) {
    const res = batchResults.get(meta.query);
    if (res && res.content != null) {
      const content = res.content;
      const sha = computeBlobSha(content);
      baseFiles.push({ path: meta.shown, fullPath: meta.fullPath, content, sha });
    }
  }

  // Build addedCharts: Chart.yaml/Chart.yml files added by the change. Look at every changed file, not only the scanned
  // folder: a Chart.yaml added above it (e.g. at the repo root) is still an ancestor of the files under it.
  const addedCharts = new Set();
  const chartQueries = [];
  const chartQueryMeta = [];
  for (const p of allChanged) {
    const filename = path.basename(p);
    if (filename === "Chart.yaml" || filename === "Chart.yml") {
      const query = `${mergeBase}:${p}`;
      chartQueries.push(query);
      chartQueryMeta.push({ p, query });
    }
  }

  if (chartQueries.length > 0) {
    const chartResults = await batchCatFile(rootDir, chartQueries);
    for (const meta of chartQueryMeta) {
      const res = chartResults.get(meta.query);
      if (!res || res.content == null) {
        // Chart.yaml/Chart.yml does not exist in merge base, so it was added
        const fullPath = path.resolve(rootDir, meta.p);
        addedCharts.add(fullPath);
      }
    }
  }

  const baseFacts = await extractFactsWithCache(baseFiles, cache, { rootDir, addedCharts });
  const headFacts = await extractFactsWithCache(headFiles, cache, { rootDir, addedCharts });

  // Add folder skip notices: files in rawChanged that are not candidates but whose basename is a candidate
  // and are excluded only by default skipped folders (not user --ignore)
  for (const p of rawChanged) {
    const displayP = display(p);
    const isCandidate = isCandidateSource(displayP, opts);
    if (isCandidate) continue; // Already in candidatePaths

    // Check if the basename alone is a candidate (file name is checkable)
    const filename = path.basename(p);
    const isNameCandidate = isCandidateSource(filename, opts);
    if (!isNameCandidate) continue; // Not a candidate file

    // Check if it's excluded only by default skipped folder
    const segments = displayP.split(/[\/\\]/);
    segments.pop(); // Remove filename
    let excludedByDefaultFolder = false;
    for (const seg of segments) {
      if (shouldSkipDir(seg)) {
        excludedByDefaultFolder = true;
        break;
      }
      if (!opts.includeTests && (DEFAULT_TEST_DIR_NAMES.has(seg) || DEFAULT_TEST_DIR_NAMES.has(seg.toLowerCase()))) {
        // Check if user explicitly included this path
        const userIgnoreList = opts.ignore ? (Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore]) : [];
        const normalizedUserIgnores = userIgnoreList
          .map(s => String(s).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
          .filter(Boolean);
        const hasUserIgnoreUnderDir = normalizedUserIgnores.some(upth => upth.startsWith(seg + "/"));
        if (!hasUserIgnoreUnderDir) {
          excludedByDefaultFolder = true;
          break;
        }
      }
    }

    if (excludedByDefaultFolder) {
      // Find which segment is the skip folder
      let skipFolder = null;
      for (const seg of segments) {
        if (shouldSkipDir(seg)) {
          skipFolder = seg;
          break;
        }
        if (!opts.includeTests && (DEFAULT_TEST_DIR_NAMES.has(seg) || DEFAULT_TEST_DIR_NAMES.has(seg.toLowerCase()))) {
          skipFolder = seg;
          break;
        }
      }
      if (!headFacts.skipped) headFacts.skipped = [];
      headFacts.skipped.push({
        path: displayP,
        reason: `in a folder Archtour skips by default (${skipFolder}/); use --include-tests or the paths input to check it`,
        folderSkip: true
      });
    }
  }

  baseFacts._renames = renames;
  headFacts._renames = renames;

  return { baseFacts, headFacts, mergeBase, candidatePaths, rootDir };
}

// Repo-relative, forward-slash path of dir inside rootDir ("" for the root itself).
// Real paths on both sides: git reports the resolved root, while the folder may be given through a symlink (macOS /var ->
// /private/var) or an 8.3 short name (Windows runners: C:\Users\RUNNER~1). Comparing unresolved paths put every file "outside"
// the scope, so the check passed without looking at anything.
function repoScope(rootDir, dir) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(rootDir), real(dir)).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`the scanned folder ${dir} is not inside the git repository ${rootDir}`);
  }
  return rel === "" || rel === "." ? "" : rel.replace(/\/+$/, "");
}

/**
 * Resolves the base policy directory.
 * If policyFrom is base, extracts base .archtour files from mergeBase if needed.
 */
export async function resolveBasePolicy(repoDir, mergeBase, policyFrom = "base") {
  const rootDir = await getGitRoot(repoDir);
  const realPath = (p) => {
    try {
      return fs.realpathSync.native(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  if (policyFrom === "head") {
    // A subfolder scan uses the nearest .archtour/ on disk above it, up to the git root (the PR cannot escape its own policy)
    const startDir = path.resolve(repoDir);
    const realRoot = realPath(rootDir);
    let dir = realPath(startDir);
    while (true) {
      if (fs.existsSync(path.join(dir, ".archtour"))) {
        if (dir !== realPath(startDir)) {
          const rel = path.relative(realRoot, dir).split(path.sep).join("/") || ".";
          console.error(`notice: using the policy in ${rel}/.archtour/ from the PR (head)`);
        }
        return { policyDir: dir, isBootstrap: false, cleanup: () => {} };
      }
      const relToRoot = path.relative(realRoot, dir);
      if (relToRoot === "" || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { policyDir: startDir, isBootstrap: false, cleanup: () => {} };
  }
  const scope = repoScope(rootDir, repoDir);
  let prefix = scope ? `${scope}/` : "";
  const git = (args) => execFileAsync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });

  // A ref that does not resolve is a config error, never "no base policy" (that would silently use the PR's own policy)
  await git(["rev-parse", "--verify", `${mergeBase}^{commit}`]);

  let policyFiles = [];
  try {
    const { stdout } = await git(["ls-tree", "-r", "--name-only", "-z", mergeBase, "--", `${prefix}.archtour`]);
    policyFiles = stdout.split("\0").filter(Boolean);
  } catch {}

  // A subfolder without its own policy uses the nearest one on the base branch, up to the repo root.
  if (policyFiles.length === 0 && scope) {
    const parts = scope.split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      const parentScope = parts.slice(0, i).join("/");
      const tryPrefix = parentScope ? `${parentScope}/` : "";
      let files = [];
      try {
        const { stdout } = await git(["ls-tree", "-r", "--name-only", "-z", mergeBase, "--", `${tryPrefix}.archtour`]);
        files = stdout.split("\0").filter(Boolean);
      } catch {}
      if (files.length > 0) {
        policyFiles = files;
        prefix = tryPrefix;
        console.error(`notice: using the policy in ${parentScope || "."}/.archtour/ from the base branch`);
        break;
      }
    }
  }

  if (policyFiles.length === 0) {
    console.error("notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)");
    const tmpPolicyDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-base-policy-"));
    const cleanup = () => {
      try {
        fs.rmSync(tmpPolicyDir, { recursive: true, force: true });
      } catch {}
    };
    return { policyDir: tmpPolicyDir, isBootstrap: true, cleanup };
  }

  // The base policy is written to a temp folder laid out like the scanned folder (<tmp>/.archtour/...).
  const tmpPolicyDir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-base-policy-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmpPolicyDir, { recursive: true, force: true });
    } catch {}
  };

  const written = new Set();
  const fetchFile = async (repoPath) => {
    if (written.has(repoPath)) return false;
    written.add(repoPath);
    const { stdout } = await git(["show", `${mergeBase}:${repoPath}`]);
    const dest = path.join(tmpPolicyDir, ...repoPath.slice(prefix.length).split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, stdout);
    return stdout;
  };

  try {
    const queue = [];
    for (const p of policyFiles) {
      const content = await fetchFile(p);
      if (/\.ya?ml$/i.test(p)) queue.push({ repoPath: p, content });
    }
    // Follow relative `extends` (string or list, any YAML style). Files outside the scanned folder cannot be laid out in the
    // temp folder; they are left out and loadRules then fails with a config error (exit 3) instead of using other rules.
    while (queue.length > 0) {
      const { repoPath, content } = queue.shift();
      let doc;
      try {
        doc = YAML.parse(content);
      } catch {
        continue; // loadRules reports the parse error
      }
      const ext = doc && doc.extends;
      const items = Array.isArray(ext) ? ext : (typeof ext === "string" ? [ext] : []);
      for (const item of items) {
        if (typeof item !== "string" || item.trim().startsWith("archtour:")) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), item.trim()));
        if (target.startsWith("../") || (prefix && !target.startsWith(prefix))) continue;
        try {
          const extContent = await fetchFile(target);
          if (extContent !== false) queue.push({ repoPath: target, content: extContent });
        } catch {}
      }
    }
  } catch {
    cleanup();
    throw new Error(`could not read the base policy (${prefix}.archtour) at ${mergeBase}`);
  }

  return { policyDir: tmpPolicyDir, isBootstrap: false, cleanup };
}
