// Archtour History Audit Engine
// Runs guardrails over repository history and reports what would have been flagged.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import { extractFacts } from "./facts.mjs";
import { diffFacts } from "./facts-diff.mjs";
import { loadRules, evaluateRules, LEVEL_SEVERITY } from "./rules.mjs";
import { isSqlMigrationCandidate } from "./facts-sql.mjs";
import { mdText } from "./diff.mjs";

const execFileAsync = promisify(execFile);

const HEAVY_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "bower_components",
  "Pods"
]);

const DEFAULT_TEST_DIR_NAMES = new Set([
  "fixtures",
  "__fixtures__",
  "testdata",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "examples",
  "example",
  "samples",
  "sample"
]);

export function isIgnoredPath(filePath) {
  if (!filePath || typeof filePath !== "string") return true;
  const norm = filePath.replace(/\\/g, "/");
  const parts = norm.split("/");
  parts.pop(); // remove filename
  for (const part of parts) {
    if (part.startsWith(".")) return true;
    const lower = part.toLowerCase();
    if (HEAVY_DIR_NAMES.has(part) || HEAVY_DIR_NAMES.has(lower)) return true;
    if (DEFAULT_TEST_DIR_NAMES.has(part) || DEFAULT_TEST_DIR_NAMES.has(lower)) return true;
  }
  return false;
}

export function isCandidateSource(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  if (isIgnoredPath(filePath)) return false;

  const norm = filePath.replace(/\\/g, "/");
  const filename = norm.split("/").pop();
  if (filename.startsWith(".")) return false;

  return (
    /^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename) ||
    /\.ya?ml$/i.test(filename) ||
    /\.prisma$/i.test(filename) ||
    /\.json$/i.test(filename) ||
    isSqlMigrationCandidate(norm, norm, filename) ||
    /\.(?:graphql|gql)$/i.test(filename) ||
    /^schema\.graphqls$/i.test(filename) ||
    /\.proto$/i.test(filename)
  );
}

export function getBlobSha(content) {
  const buf = Buffer.from(content, "utf8");
  return crypto
    .createHash("sha1")
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest("hex");
}

function getFactsForFile(file, blobCache) {
  const sha = getBlobSha(file.content);
  if (blobCache.has(sha)) {
    const cached = blobCache.get(sha);
    if (!cached.sources?.[0]?.path || cached.sources[0].path === file.path) {
      return cached;
    }
    return {
      entities: cached.entities.map(e => ({
        ...e,
        source: e.source ? { ...e.source, file: file.path } : { file: file.path }
      })),
      relations: cached.relations.map(r => ({ ...r })),
      sources: cached.sources.map(s => ({ ...s, path: file.path })),
      errors: cached.errors.map(err => ({ ...err, file: file.path })),
      parseErrors: (cached.parseErrors || []).map(err => ({ ...err, file: file.path, path: file.path }))
    };
  }
  const facts = extractFacts([{ path: file.path, content: file.content, fullPath: file.fullPath || file.path }]);
  blobCache.set(sha, facts);
  return facts;
}

function getFactsForFiles(files, blobCache) {
  if (!files || files.length === 0) {
    return { entities: [], relations: [], sources: [], errors: [], parseErrors: [] };
  }
  const entities = [];
  const relations = [];
  const sources = [];
  const errors = [];
  const parseErrors = [];
  for (const f of files) {
    const res = getFactsForFile(f, blobCache);
    entities.push(...res.entities);
    relations.push(...res.relations);
    sources.push(...res.sources);
    errors.push(...res.errors);
    if (res.parseErrors) parseErrors.push(...res.parseErrors);
  }
  return { entities, relations, sources, errors, parseErrors };
}

async function runGit(repoDir, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout;
  } catch (err) {
    if (err.code === "ENOENT") {
      const e = new Error("git is not installed or not found on PATH");
      e.code = "ENOENT";
      throw e;
    }
    throw err;
  }
}

async function readGitFile(repoDir, ref, filePath) {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${filePath}`], {
      cwd: repoDir,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout;
  } catch {
    return null;
  }
}

async function getCommitMetadata(repoDir, sha) {
  try {
    const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%cI%x00%s", sha], {
      cwd: repoDir,
      encoding: "utf8"
    });
    const parts = stdout.trim().split("\0");
    const date = parts[0] || "";
    const subject = parts[1] || "";
    return { date, subject };
  } catch {
    return { date: "", subject: "" };
  }
}

export function parseDiffTreeZ(output) {
  if (!output) return [];
  const tokens = output.split("\0");
  const files = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i++;
      continue;
    }
    const statusCode = status[0];
    if (statusCode === "R" || statusCode === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath && newPath) {
        files.push({ status: statusCode, oldPath, newPath, path: newPath });
      }
      i += 3;
    } else {
      const filePath = tokens[i + 1];
      if (filePath) {
        files.push({ status: statusCode, path: filePath });
      }
      i += 2;
    }
  }
  return files;
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const count = Math.min(limit, items.length);
  const workers = Array.from({ length: count }, () => worker());
  await Promise.all(workers);
  return results;
}

export function formatHistoryMarkdownReport(result, opts = {}) {
  const { summary, rules = [], topFindings = [] } = result;
  const repoUrl = opts.repoUrl || result.repoUrl || null;

  const countStr = `${summary.hard} hard, ${summary.soft} soft, ${summary.warn} warn, ${summary.advisory} advisory`;

  const lines = [
    `## 🏛️ Architecture History Audit`,
    ``,
    `- **Commits scanned**: ${summary.commitsScanned}`,
    `- **Commits with architecture changes**: ${summary.commitsWithArchitectureChanges}`,
    `- **Findings**: ${summary.totalFindings} (${countStr})`,
    ``
  ];

  function commitLink(commit) {
    if (!commit) return "unknown";
    const shortSha = commit.shortSha || (commit.sha ? commit.sha.slice(0, 7) : "unknown");
    if (commit.url || (repoUrl && commit.sha)) {
      const url = commit.url || `${repoUrl.replace(/\/+$/, "")}/commit/${commit.sha}`;
      return `[${shortSha}](${url})`;
    }
    return shortSha;
  }

  lines.push(`### Rule Summary`);
  lines.push(``);
  if (rules.length === 0) {
    lines.push(`No architecture rule violations detected in scanned history.`);
    lines.push(``);
  } else {
    lines.push(`| Rule | Level | Count | First Commit | Last Commit |`);
    lines.push(`|---|---|---|---|---|`);
    for (const r of rules) {
      const firstStr = commitLink(r.firstCommit);
      const lastStr = commitLink(r.lastCommit);
      lines.push(`| \`${mdText(r.ruleId)}\` | ${r.level} | ${r.count} | ${firstStr} | ${lastStr} |`);
    }
    lines.push(``);
  }

  if (topFindings.length > 0) {
    lines.push(`### Top Findings (up to 20)`);
    lines.push(``);
    for (let idx = 0; idx < topFindings.length; idx++) {
      const f = topFindings[idx];
      const icon = f.level === "hard" ? "⛔" : f.level === "soft" ? "⚠️" : f.level === "warn" ? "⚠️" : "ℹ️";
      const msg = mdText(f.message || "");
      const clink = commitLink(f);
      const datePart = f.date ? ` (${mdText(f.date.slice(0, 10))}${f.subject ? `: ${mdText(f.subject)}` : ""})` : (f.subject ? ` (${mdText(f.subject)})` : "");
      const fileStr = f.source?.file ? (f.source.line ? `${f.source.file}:${f.source.line}` : f.source.file) : "unknown";

      lines.push(`${idx + 1}. ${icon} **${msg}** (\`${mdText(f.ruleId)}\`, ${f.level})`);
      lines.push(`   - Commit: ${clink}${datePart}`);
      lines.push(`   - File: \`${mdText(fileStr)}\``);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function auditHistory(targetDir = ".", opts = {}) {
  const repoDir = path.resolve(targetDir);
  const maxCommits = opts.maxCommits != null ? Number(opts.maxCommits) : 500;
  const branch = opts.branch || "HEAD";
  const repoUrl = opts.repoUrl ? String(opts.repoUrl).replace(/\/+$/, "") : null;

  const revListArgs = ["rev-list", "--first-parent", "--parents", branch, "-n", String(maxCommits)];
  if (opts.since) {
    revListArgs.push(`--since=${opts.since}`);
  }

  let revListOutput;
  try {
    revListOutput = await runGit(repoDir, revListArgs);
  } catch (err) {
    if (err.code === "ENOENT") throw err;
    throw new Error(`git rev-list failed: ${err.message}`);
  }

  const lines = revListOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const commitEntries = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      const sha = parts[0];
      const parent = parts[1] || null;
      commitEntries.push({ sha, parent });
    }
  }

  let rulesResult;
  try {
    rulesResult = loadRules(opts.rules, { headDir: repoDir, basePath: repoDir });
  } catch (err) {
    throw new Error(`Failed to load rules: ${err.message}`);
  }
  const rules = rulesResult.rules || [];

  const blobCache = new Map();
  const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let commitsWithArchitectureChanges = 0;
  const allFindings = [];
  const scannedCommits = [];

  const auditResults = await mapConcurrent(commitEntries, 12, async ({ sha, parent }) => {
    const parentRef = parent || EMPTY_TREE_SHA;

    let diffTreeOut;
    try {
      diffTreeOut = await runGit(repoDir, [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--name-status",
        "-z",
        parentRef,
        sha
      ]);
    } catch {
      return { sha, parent, skipped: true, hasArchitectureChanges: false, findings: [] };
    }

    const changedFiles = parseDiffTreeZ(diffTreeOut);
    const candidateChanges = changedFiles.filter(
      f => isCandidateSource(f.path) || (f.oldPath && isCandidateSource(f.oldPath))
    );

    if (candidateChanges.length === 0) {
      return { sha, parent, skipped: true, hasArchitectureChanges: false, findings: [] };
    }

    const baseFiles = [];
    const headFiles = [];

    for (const change of candidateChanges) {
      const status = change.status;
      const curPath = change.path;
      const oldPath = change.oldPath || curPath;

      if (status === "A") {
        const headContent = await readGitFile(repoDir, sha, curPath);
        if (headContent !== null) {
          headFiles.push({ path: curPath, content: headContent, fullPath: path.resolve(repoDir, curPath) });
        }
      } else if (status === "D") {
        if (parent) {
          const baseContent = await readGitFile(repoDir, parent, curPath);
          if (baseContent !== null) {
            baseFiles.push({ path: curPath, content: baseContent, fullPath: path.resolve(repoDir, curPath) });
          }
        }
      } else if (status === "R") {
        if (parent) {
          const baseContent = await readGitFile(repoDir, parent, oldPath);
          if (baseContent !== null) {
            baseFiles.push({ path: oldPath, content: baseContent, fullPath: path.resolve(repoDir, oldPath) });
          }
        }
        const headContent = await readGitFile(repoDir, sha, curPath);
        if (headContent !== null) {
          headFiles.push({ path: curPath, content: headContent, fullPath: path.resolve(repoDir, curPath) });
        }
      } else {
        if (parent) {
          const baseContent = await readGitFile(repoDir, parent, curPath);
          if (baseContent !== null) {
            baseFiles.push({ path: curPath, content: baseContent, fullPath: path.resolve(repoDir, curPath) });
          }
        }
        const headContent = await readGitFile(repoDir, sha, curPath);
        if (headContent !== null) {
          headFiles.push({ path: curPath, content: headContent, fullPath: path.resolve(repoDir, curPath) });
        }
      }
    }

    const baseFacts = getFactsForFiles(baseFiles, blobCache);
    const headFacts = getFactsForFiles(headFiles, blobCache);

    const diff = diffFacts(baseFacts, headFacts);
    const hasArchitectureChanges = diff.events.length > 0;

    const commitFindings = [];
    if (hasArchitectureChanges) {
      const evalRes = evaluateRules(rules, diff, baseFacts, headFacts, opts);
      const activeFindings = (evalRes.findings || []).filter(f => f.level !== "off");

      if (activeFindings.length > 0) {
        const metadata = await getCommitMetadata(repoDir, sha);
        const shortSha = sha.slice(0, 7);
        const url = repoUrl ? `${repoUrl}/commit/${sha}` : null;

        for (const f of activeFindings) {
          commitFindings.push({
            ruleId: f.ruleId,
            level: f.level,
            message: f.message,
            source: f.source,
            event: f.event,
            owners: f.owners || [],
            docs: f.docs || null,
            sha,
            commit: sha,
            shortSha,
            date: metadata.date,
            subject: metadata.subject,
            url
          });
        }
      }
    }

    return {
      sha,
      parent,
      skipped: false,
      hasArchitectureChanges,
      findings: commitFindings
    };
  });

  for (const item of auditResults) {
    if (item.hasArchitectureChanges) {
      commitsWithArchitectureChanges++;
    }
    allFindings.push(...item.findings);
    scannedCommits.push({
      sha: item.sha,
      shortSha: item.sha.slice(0, 7),
      parent: item.parent,
      hasArchitectureChanges: item.hasArchitectureChanges,
      findingsCount: item.findings.length
    });
  }

  const findingsByLevel = {
    hard: 0,
    soft: 0,
    warn: 0,
    advisory: 0
  };
  for (const f of allFindings) {
    if (f.level in findingsByLevel) {
      findingsByLevel[f.level]++;
    }
  }

  const ruleMap = new Map();
  for (const f of allFindings) {
    if (!ruleMap.has(f.ruleId)) {
      ruleMap.set(f.ruleId, {
        ruleId: f.ruleId,
        level: f.level,
        count: 0,
        commits: []
      });
    }
    const entry = ruleMap.get(f.ruleId);
    entry.count++;
    entry.commits.push({
      sha: f.sha,
      shortSha: f.shortSha,
      date: f.date,
      subject: f.subject,
      url: f.url
    });
  }

  const rulesTable = [];
  const rulesById = {};
  for (const [ruleId, entry] of ruleMap.entries()) {
    const sortedCommits = [...entry.commits].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });

    const firstCommit = sortedCommits[0];
    const lastCommit = sortedCommits[sortedCommits.length - 1];

    const ruleSummary = {
      ruleId,
      level: entry.level,
      count: entry.count,
      firstCommit,
      lastCommit
    };
    rulesTable.push(ruleSummary);
    rulesById[ruleId] = ruleSummary;
  }

  rulesTable.sort((a, b) => {
    const sa = LEVEL_SEVERITY[a.level] || 0;
    const sb = LEVEL_SEVERITY[b.level] || 0;
    if (sb !== sa) return sb - sa;
    return b.count - a.count;
  });

  const sortedFindings = [...allFindings].sort((a, b) => {
    const sa = LEVEL_SEVERITY[a.level] || 0;
    const sb = LEVEL_SEVERITY[b.level] || 0;
    if (sb !== sa) return sb - sa;
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });
  const topFindings = sortedFindings.slice(0, 20);

  const summary = {
    commitsScanned: commitEntries.length,
    commitsWithArchitectureChanges,
    totalFindings: allFindings.length,
    findingsByLevel,
    hard: findingsByLevel.hard,
    soft: findingsByLevel.soft,
    warn: findingsByLevel.warn,
    advisory: findingsByLevel.advisory
  };

  const totals = {
    commitsScanned: commitEntries.length,
    commitsWithArchitectureChanges,
    totalFindings: allFindings.length,
    findingsByLevel
  };

  const result = {
    summary,
    totals,
    rules: rulesTable,
    rulesById,
    findings: allFindings,
    topFindings,
    commits: scannedCommits,
    repoUrl,
    branch,
    maxCommits,
    since: opts.since || null
  };

  result.markdown = formatHistoryMarkdownReport(result, { repoUrl });

  return result;
}
