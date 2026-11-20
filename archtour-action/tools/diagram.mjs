#!/usr/bin/env node
// Archtour: architecture guardrails for pull requests.
//
//   node diagram.mjs check [<base> <head>] [--changed-from <ref>] [--state <dir>] [options]
//   node diagram.mjs baseline [<dir>] [-o <file>]
//   node diagram.mjs audit-history [<repoDir>] [--max-commits <n>] [--since <date>]
//   node diagram.mjs diff-repo <baseDir> <headDir> [-o diff.md|diff.json] [--format markdown|json]
//   node diagram.mjs facts [<dir>|<file>] [--json]
//   node diagram.mjs changes <baseDir> <headDir> [--json]
//   node diagram.mjs scan [<dir>] [-o out.json]
//
// Everything runs offline. The diagram toolkit that used to ship here is now a separate project.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, discoverFiles } from "./scan.mjs";
import { extractFacts } from "./facts.mjs";
import { diffFacts } from "./facts-diff.mjs";
import { isInsideGitRepo, getChangedFacts, resolveBasePolicy } from "./changed.mjs";
import { FactsCache } from "./facts-cache.mjs";
import {
  loadRules,
  evaluateRules,
  formatMarkdownReport,
  formatJobLogLines,
  getExitCode,
  extractStateEvents,
  loadExceptionsFile,
  applyExceptions,
  applyOverrides,
  diffPolicy
} from "./rules.mjs";
import { diffRepo } from "./diff-repo.mjs";
import { auditHistory } from "./history.mjs";
import { setSettings } from "./settings.mjs";

// ---------------------------------------------------------------- helpers

function die(msg, code = 1) {
  if (process.env.ARCHTOUR_DEBUG === "1") {
    console.error(new Error(msg));
    process.exit(code);
  }
  const formatted = msg.startsWith("archtour: ") ? msg : `archtour: ${msg}`;
  console.error(formatted);
  process.exit(code);
}

function ensureDir(dirPath) {
  if (!dirPath || dirPath === "." || dirPath === "") return;
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
      die(`cannot create output directory "${dirPath}": ${err.message}`);
    }
  }
}

function normalizePath(p) {
  if (!p) return "";
  let resolved = path.resolve(p);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    try {
      const dir = fs.realpathSync(path.dirname(resolved));
      resolved = path.join(dir, path.basename(resolved));
    } catch {}
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertNoOverwrite(outputs, inputs) {
  const outList = (Array.isArray(outputs) ? outputs : [outputs]).filter(Boolean);
  const inList = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);

  const resolvedInputs = inList.map((inp) => ({ original: inp, normalized: normalizePath(inp) }));

  for (const out of outList) {
    const normOut = normalizePath(out);
    for (const inp of resolvedInputs) {
      if (normOut === inp.normalized) {
        die(`output file would overwrite input file: ${inp.original}`);
      }
    }
  }
}

function checkOutExt(outPath, allowedExts) {
  if (!outPath) return null;
  const rawExt = path.extname(outPath);
  const ext = rawExt.toLowerCase();
  if (!allowedExts.includes(ext)) {
    const list = allowedExts.length === 1
      ? allowedExts[0]
      : `${allowedExts.slice(0, -1).join(", ")} or ${allowedExts.at(-1)}`;
    die(`-o must end in ${list} (got ${rawExt || "no extension"})`);
  }
  return ext;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out.out = argv[++i];
    else if (a === "--theme") out.theme = argv[++i];
    else if (a === "--bg") out.bg = argv[++i];
    else if (a === "--scale") out.scale = Number(argv[++i]);
    else if (a === "--shot") out.shot = argv[++i];
    else if (a === "--preset") out.preset = argv[++i];
    else if (a === "--styles") out.styles = argv[++i];
    else if (a === "--project") out.project = true;
    else if (a === "--dark") out.dark = true;
    else if (a === "--open") out.open = true;
    else if (a === "--text") out.text = true;
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--github") out.github = true;
    else if (a === "--serve") out.serve = true;
    else if (a === "--visibility") out.visibility = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--strict") out.strict = true;
    else if (a === "--ci") out.ci = true;
    else if (a === "--no-brand") out.noBrand = true;
    else if (a === "--from") out.from = argv[++i];
    else if (a.startsWith("--from=")) out.from = a.slice("--from=".length);
    else if (a === "--frames") out.frames = true;
    else if (a === "--vtt") out.vtt = true;
    else if (a === "--player") out.player = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-split") out.noSplit = true;
    else if (a === "--max-nodes") out.maxNodes = Number(argv[++i]);
    else if (a.startsWith("--max-nodes=")) out.maxNodes = Number(a.slice("--max-nodes=".length));
    else if (a === "--max-files") out.maxFiles = Number(argv[++i]);
    else if (a.startsWith("--max-files=")) out.maxFiles = Number(a.slice("--max-files=".length));
    else if (a === "--migration-dir" || a.startsWith("--migration-dir=")) {
      const val = a === "--migration-dir" ? argv[++i] : a.slice("--migration-dir=".length);
      if (!out.migrationDirs) out.migrationDirs = [];
      for (const piece of String(val == null ? "" : val).split(",")) out.migrationDirs.push(piece);
    }
    else if (a === "--max-file-size") out.maxFileSize = Number(argv[++i]);
    else if (a.startsWith("--max-file-size=")) out.maxFileSize = Number(a.slice("--max-file-size=".length));
    else if (a === "--max-depth") out.maxDepth = Number(argv[++i]);
    else if (a.startsWith("--max-depth=")) out.maxDepth = Number(a.slice("--max-depth=".length));
    else if (a === "--include-tests") out.includeTests = true;
    else if (a === "--ignore") {
      const val = argv[++i];
      if (!out.ignore) out.ignore = [];
      else if (!Array.isArray(out.ignore)) out.ignore = [out.ignore];
      out.ignore.push(val);
    } else if (a.startsWith("--ignore=")) {
      const val = a.slice("--ignore=".length);
      if (!out.ignore) out.ignore = [];
      else if (!Array.isArray(out.ignore)) out.ignore = [out.ignore];
      out.ignore.push(val);
    } else if (a === "--rules") {
      out.rules = argv[++i];
    } else if (a.startsWith("--rules=")) {
      out.rules = a.slice("--rules=".length);
    } else if (a === "--md") {
      out.md = argv[++i];
    } else if (a.startsWith("--md=")) {
      out.md = a.slice("--md=".length);
    } else if (a === "--markdown") {
      out.markdown = argv[++i];
    } else if (a.startsWith("--markdown=")) {
      out.markdown = a.slice("--markdown=".length);
    } else if (a === "--server") {
      out.server = argv[++i];
    } else if (a.startsWith("--server=")) {
      out.server = a.slice("--server=".length);
    } else if (a === "--workspace") {
      out.workspace = argv[++i];
    } else if (a.startsWith("--workspace=")) {
      out.workspace = a.slice("--workspace=".length);
    } else if (a === "--repo") {
      out.repo = argv[++i];
    } else if (a.startsWith("--repo=")) {
      out.repo = a.slice("--repo=".length);
    } else if (a === "--sha") {
      out.sha = argv[++i];
    } else if (a.startsWith("--sha=")) {
      out.sha = a.slice("--sha=".length);
    } else if (a === "--branch") {
      out.branch = argv[++i];
    } else if (a.startsWith("--branch=")) {
      out.branch = a.slice("--branch=".length);
    } else if (a === "--pr") {
      out.pr = argv[++i];
    } else if (a.startsWith("--pr=")) {
      out.pr = a.slice("--pr=".length);
    } else if (a === "--spec") {
      out.spec = argv[++i];
    } else if (a.startsWith("--spec=")) {
      out.spec = a.slice("--spec=".length);
    } else if (a === "--summary-json") {
      out.summaryJson = argv[++i];
    } else if (a.startsWith("--summary-json=")) {
      out.summaryJson = a.slice("--summary-json=".length);
    } else if (a === "--summary") {
      out.summary = argv[++i];
    } else if (a.startsWith("--summary=")) {
      out.summary = a.slice("--summary=".length);
    } else if (a === "--state") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        out.state = argv[++i];
      } else {
        out.state = true;
      }
    } else if (a.startsWith("--state=")) {
      out.state = a.slice("--state=".length);
    } else if (a === "--baseline") {
      out.baseline = argv[++i];
    } else if (a.startsWith("--baseline=")) {
      out.baseline = a.slice("--baseline=".length);
    } else if (a === "--exceptions") {
      out.exceptions = argv[++i];
    } else if (a.startsWith("--exceptions=")) {
      out.exceptions = a.slice("--exceptions=".length);
    } else if (a === "--override") {
      const val = argv[++i];
      if (!out.override) out.override = [];
      else if (!Array.isArray(out.override)) out.override = [out.override];
      out.override.push(val);
    } else if (a.startsWith("--override=")) {
      const val = a.slice("--override=".length);
      if (!out.override) out.override = [];
      else if (!Array.isArray(out.override)) out.override = [out.override];
      out.override.push(val);
    } else if (a === "--override-by") {
      out.overrideBy = argv[++i];
    } else if (a.startsWith("--override-by=")) {
      out.overrideBy = a.slice("--override-by=".length);
    } else if (a === "--pr-author") {
      out.prAuthor = argv[++i];
    } else if (a.startsWith("--pr-author=")) {
      out.prAuthor = a.slice("--pr-author=".length);
    } else if (a === "--override-permission") {
      out.overridePermission = argv[++i];
    } else if (a.startsWith("--override-permission=")) {
      out.overridePermission = a.slice("--override-permission=".length);
    } else if (a === "--override-reason") {
      out.overrideReason = argv[++i];
    } else if (a.startsWith("--override-reason=")) {
      out.overrideReason = a.slice("--override-reason=".length);
    } else if (a === "--owner-teams") {
      out.ownerTeams = argv[++i];
    } else if (a.startsWith("--owner-teams=")) {
      out.ownerTeams = a.slice("--owner-teams=".length);
    } else if (a === "--now") {
      out.now = argv[++i];
    } else if (a.startsWith("--now=")) {
      out.now = a.slice("--now=".length);
    } else if (a === "--policy-from") {
      out.policyFrom = argv[++i];
    } else if (a.startsWith("--policy-from=")) {
      out.policyFrom = a.slice("--policy-from=".length);
    } else if (a === "--max-commits") {
      out.maxCommits = Number(argv[++i]);
    } else if (a.startsWith("--max-commits=")) {
      out.maxCommits = Number(a.slice("--max-commits=".length));
    } else if (a === "--since") {
      out.since = argv[++i];
    } else if (a.startsWith("--since=")) {
      out.since = a.slice("--since=".length);
    } else if (a === "--repo-url") {
      out.repoUrl = argv[++i];
    } else if (a.startsWith("--repo-url=")) {
      out.repoUrl = a.slice("--repo-url=".length);
    } else if (a === "--changed-from") {
      out.changedFrom = argv[++i];
    } else if (a.startsWith("--changed-from=")) {
      out.changedFrom = a.slice("--changed-from=".length);
    } else if (a === "--cache-dir") {
      out.cacheDir = argv[++i];
    } else if (a.startsWith("--cache-dir=")) {
      out.cacheDir = a.slice("--cache-dir=".length);
    } else if (a === "--include-untracked") {
      out.includeUntracked = true;
    } else if (a === "--head-sha") {
      out.headSha = argv[++i];
    } else if (a.startsWith("--head-sha=")) {
      out.headSha = a.slice("--head-sha=".length);
    } else if (a === "--log-all") {
      out.logAll = true;
    } else if (a === "--override-sha") {
      out.overrideSha = argv[++i];
    } else if (a.startsWith("--override-sha=")) {
      out.overrideSha = a.slice("--override-sha=".length);
    } else if (a === "--help" || a === "-h") {
      // Only flags set help here. A bare `help` is only a help request in the first position after the subcommand (see
      // isHelpRequest), never when it is an option value or a later positional.
      out.help = true;
    }
    else out._.push(a);
  }
  return out;
}

async function handleDiffRepoCommand(baseDir, headDir, opts = {}) {
  if (!baseDir || !headDir) {
    die("missing inputs: node tools/diagram.mjs diff-repo <baseDir> <headDir> [-o diff.md] [--format markdown|json] [--ignore <path>]");
  }
  if (!fs.existsSync(baseDir)) die(`no such file: ${baseDir}`);
  if (!fs.existsSync(headDir)) die(`no such file: ${headDir}`);

  const result = diffRepo(baseDir, headDir, opts);
  const allInputs = [path.resolve(baseDir), path.resolve(headDir)];
  for (const f of result.baseFound || []) allInputs.push(path.resolve(baseDir, f.path));
  for (const f of result.headFound || []) allInputs.push(path.resolve(headDir, f.path));

  if (opts.out) {
    const rawOut = path.resolve(opts.out);
    const companionMd = rawOut.endsWith(".md") ? null : rawOut + ".md";
    assertNoOverwrite([rawOut, companionMd], allInputs);
  }

  const ext = checkOutExt(opts.out, [".md", ".json"]);

  const hasNewParseErrors = Array.isArray(result.parseErrors) && result.parseErrors.length > 0;
  if (hasNewParseErrors) {
    process.exitCode = 3;
  }

  if (result.truncated) {
    console.error(`⚠️ Partial scan: ${String(result.reason || "").replace(/\.+$/, "")}. Removed/added sources are not reported; narrow 'paths' or raise --max-files.`);
  }

  const summaryJsonPath = opts.summaryJson || opts["summary-json"];
  if (summaryJsonPath) {
    const summaryDir = path.dirname(path.resolve(summaryJsonPath));
    if (!fs.existsSync(summaryDir)) {
      fs.mkdirSync(summaryDir, { recursive: true });
    }
    fs.writeFileSync(path.resolve(summaryJsonPath), JSON.stringify(result.summary, null, 2) + "\n");
  }

  if (opts.markdown) {
    const mdOut = path.resolve(opts.markdown);
    assertNoOverwrite([mdOut], allInputs);
    ensureDir(path.dirname(mdOut));
    fs.writeFileSync(mdOut, result.markdown + "\n");
  }

  if (ext === ".md") {
    const out = path.resolve(opts.out);
    assertNoOverwrite([out], allInputs);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, result.markdown + "\n");
    console.log(`wrote ${out}`);
    if (hasNewParseErrors) process.exit(3);
    return out;
  }

  if (ext === ".json") {
    const out = path.resolve(opts.out);
    assertNoOverwrite([out], allInputs);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, JSON.stringify(result.overviewSpec, null, 2) + "\n");
    console.log(`wrote ${out}`);
    if (hasNewParseErrors) process.exit(3);
    return out;
  }

  if (opts.format === "json") {
    console.log(JSON.stringify(result, null, 2));
    if (hasNewParseErrors) process.exit(3);
    return;
  }

  console.log(result.markdown);
  if (hasNewParseErrors) process.exit(3);
}

async function handleScanCommand(dirArg = ".", opts = {}) {
  const dir = dirArg || ".";

  let result;
  try {
    result = scanRepo(dir, opts);
  } catch (err) {
    die(err.message);
  }
  const { spec, found, skipped, truncated, reason, defaultIgnoredDirs } = result;

  const allInputs = [path.resolve(dir)];
  for (const f of found) {
    allInputs.push(path.resolve(dir, f.path));
  }

  if (opts.out) {
    assertNoOverwrite([path.resolve(opts.out)], allInputs);
  }

  const ext = checkOutExt(opts.out, [".json"]);

  if (truncated) {
    console.error(`⚠️ Partial scan: ${String(reason || "").replace(/\.+$/, "")}. Removed/added sources are not reported; narrow 'paths' or raise --max-files.`);
  }

  for (const f of found) {
    console.log(`found ${f.path}`);
  }
  for (const s of skipped) {
    if (s.reason === "default-ignored") {
      continue;
    }
    if (s.reason === "ignored" || s.reason === "(ignored)") {
      console.log(`skipped (ignored): ${s.path}`);
    } else {
      console.log(`skipped ${s.path}: ${s.reason}`);
    }
  }

  if (defaultIgnoredDirs > 0) {
    console.log(`ignored by default: ${defaultIgnoredDirs} dirs (use --include-tests to scan them)`);
  }

  const folderName = path.basename(path.resolve(dir)) || "repo";
  const out = path.resolve(opts.out || `${folderName}-architecture${ext || ".json"}`);
  assertNoOverwrite([out], allInputs);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
  console.log(`wrote ${out}`);
  return out;
}

async function handleFactsCommand(targetArg = ".", opts = {}) {
  const target = targetArg || ".";
  if (!fs.existsSync(target)) die(`no such file or directory: ${target}`);

  const stat = fs.statSync(target);
  let files = [];
  let truncated = false;
  let reason = null;

  if (stat.isFile()) {
    let content = "";
    try {
      content = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    } catch (err) {
      die(`failed to read file: ${err.message}`);
    }
    files.push({ path: path.basename(target), content, fullPath: path.resolve(target) });
  } else {
    const disc = discoverFiles(target, opts);
    files = disc.files;
    truncated = disc.truncated;
    reason = disc.reason;
    if (disc.truncated) {
      console.error(`notice: ${disc.unexaminedCount || 0} candidate files were not checked; raise --max-files`);
    }
  }

  const facts = extractFacts(files, { truncated, reason });

  if (opts.json) {
    console.log(JSON.stringify(facts, null, 2));
    return;
  }

  console.log(`Architecture Facts: ${path.resolve(target)}`);
  console.log(`  Sources: ${facts.sources.length}`);
  console.log(`  Entities: ${facts.entities.length}`);
  const byKind = {};
  for (const e of facts.entities) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  }
  for (const [k, count] of Object.entries(byKind)) {
    console.log(`    ${k}: ${count}`);
  }
  console.log(`  Relations: ${facts.relations.length}`);
  if (facts.errors.length > 0) {
    console.log(`  Warnings/Errors: ${facts.errors.length}`);
    for (const err of facts.errors) {
      console.log(`    ⚠️ ${err.message || err}`);
    }
  }
}

async function handleChangesCommand(baseDir, headDir, opts = {}) {
  if (!baseDir || !headDir) {
    die("missing inputs: archtour changes <baseDir> <headDir> [--json]");
  }
  if (!fs.existsSync(baseDir)) die(`base directory does not exist: ${baseDir}`);
  if (!fs.existsSync(headDir)) die(`head directory does not exist: ${headDir}`);

  const baseDisc = discoverFiles(baseDir, opts);
  const baseFacts = extractFacts(baseDisc.files, { truncated: baseDisc.truncated, reason: baseDisc.reason });

  const headDisc = discoverFiles(headDir, opts);
  const headFacts = extractFacts(headDisc.files, { truncated: headDisc.truncated, reason: headDisc.reason });

  if (baseDisc.truncated || headDisc.truncated) {
    const unexamined = (baseDisc.unexaminedCount || 0) + (headDisc.unexaminedCount || 0);
    console.error(`notice: ${unexamined} candidate files were not checked; raise --max-files`);
  }

  const diff = diffFacts(baseFacts, headFacts);

  if (opts.json) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  console.log(`Architecture Changes (${diff.events.length} events):`);
  if (diff.events.length === 0) {
    console.log("  No architecture changes");
  } else {
    for (const ev of diff.events) {
      console.log(`  - [${ev.type}] ${ev.message}`);
    }
  }
}

async function handleBaselineCommand(targetArg, opts = {}) {
  const targetDir = targetArg || ".";
  if (!fs.existsSync(targetDir)) die(`no such file or directory: ${targetDir}`, 3);

  const outPath = opts.out || opts.o || path.join(targetDir, ".archtour", "baseline.json");

  let rulesResult;
  try {
    rulesResult = loadRules(opts.rules, { headDir: targetDir });
  } catch (err) {
    die(err.message, 3);
  }

  const disc = discoverFiles(targetDir, opts);
  if (disc.truncated) {
    const unexamined = disc.unexaminedCount || 0;
    die(`${unexamined} candidate files were not checked; raise --max-files`, 3);
  }

  const facts = extractFacts(disc.files, { truncated: disc.truncated, reason: disc.reason });
  const events = extractStateEvents(facts);
  const { findings } = evaluateRules(rulesResult.rules, { events }, {}, facts, opts);

  const counts = {};
  for (const f of findings) {
    if (f.level === "off") continue;
    counts[f.ruleId] = (counts[f.ruleId] || 0) + 1;
  }

  const sortedCounts = {};
  for (const k of Object.keys(counts).sort()) {
    sortedCounts[k] = counts[k];
  }

  ensureDir(path.dirname(path.resolve(outPath)));
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(sortedCounts, null, 2) + "\n");
  console.log(`wrote baseline to ${outPath}`);
}

async function handleCheckCommand(baseDir, headDir, opts = {}) {
  const isStateMode = Boolean(opts.state);
  const isChangedMode = Boolean(opts.changedFrom);
  const stateDir = (typeof opts.state === "string" ? opts.state : null) || baseDir;
  const targetDir = baseDir || ".";

  let inGit = false;
  if (isChangedMode) {
    inGit = await isInsideGitRepo(targetDir);
    if (!inGit) {
      console.error("notice: not in a git repository; falling back to full scan");
    }
  }

  if (isStateMode) {
    if (!stateDir || typeof stateDir !== "string" || !stateDir.trim()) {
      die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
    }
    if (!fs.existsSync(stateDir)) {
      die(`directory does not exist: ${stateDir}`, 3);
    }
  } else if (isChangedMode && inGit) {
    if (!opts.changedFrom || typeof opts.changedFrom !== "string" || !opts.changedFrom.trim()) {
      die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
    }
    if (!fs.existsSync(targetDir)) {
      die(`directory does not exist: ${targetDir}`, 3);
    }
  } else {
    if (!baseDir || !headDir || typeof baseDir !== "string" || typeof headDir !== "string" || !baseDir.trim() || !headDir.trim()) {
      die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
    }
    if (!fs.existsSync(baseDir)) die(`base directory does not exist: ${baseDir}`, 3);
    if (fs.statSync(baseDir).isFile()) die(`base is a file, expected a directory: ${baseDir}`, 3);
    if (!fs.existsSync(headDir)) die(`head directory does not exist: ${headDir}`, 3);
    if (fs.statSync(headDir).isFile()) die(`head is a file, expected a directory: ${headDir}`, 3);
  }

  const policyFrom = opts.policyFrom || "base";
  if (policyFrom !== "base" && policyFrom !== "head") {
    die(`invalid --policy-from: "${policyFrom}". Must be "base" or "head"`, 3);
  }

  let policyDir;
  let isBootstrap = false;
  let policyCleanup = () => {};

  if (isStateMode) {
    policyDir = stateDir;
  } else if (isChangedMode && inGit) {
    let res;
    try {
      res = await resolveBasePolicy(targetDir, opts.changedFrom, policyFrom);
    } catch (err) {
      die(`--changed-from: ${err.message}`, 3);
    }
    policyDir = res.policyDir;
    isBootstrap = res.isBootstrap;
    policyCleanup = res.cleanup;
  } else if (policyFrom === "head") {
    policyDir = headDir || targetDir;
  } else {
    // policyFrom === "base"
    const baseHasArchtour = fs.existsSync(path.join(baseDir, ".archtour"));
    if (!baseHasArchtour) {
      policyDir = baseDir;
      isBootstrap = true;
      console.error("notice: base has no .archtour/, using the built-in recommended rules (a new policy applies after merge)");
    } else {
      policyDir = baseDir;
    }
  }

  let rulesResult;
  try {
    rulesResult = loadRules(opts.rules, { headDir: policyDir, basePath: policyDir, policyDir });
  } catch (err) {
    policyCleanup();
    die(err.message, 3);
  }

  if (rulesResult.warnings && rulesResult.warnings.length > 0) {
    for (const w of rulesResult.warnings) {
      console.error(w.message || w);
    }
  }

  let baseFacts = { entities: [], relations: [] };
  let headFacts = { entities: [], relations: [] };
  let findings = [];
  let events = [];
  let candidateFilesCount = 0;

  const cache = opts.cacheDir ? new FactsCache(opts.cacheDir) : null;

  if (isStateMode) {
    const headDisc = discoverFiles(stateDir, opts);
    candidateFilesCount = headDisc.files ? headDisc.files.length : 0;
    headFacts = extractFacts(headDisc.files, { truncated: headDisc.truncated, reason: headDisc.reason, rootDir: stateDir });
    events = extractStateEvents(headFacts);
    const evalRes = evaluateRules(rulesResult.rules, { events }, {}, headFacts, opts);
    findings = evalRes.findings;
    if (headDisc.truncated) {
      const unexamined = headDisc.unexaminedCount || 0;
      console.error(`notice: ${unexamined} candidate files were not checked; raise --max-files`);
      findings.push({
        ruleId: "scan-truncated",
        level: "hard",
        adjustable: false,
        message: `${unexamined} candidate files were not checked; raise --max-files`,
        owners: [],
        docs: null,
        source: { file: stateDir, line: 1 },
        event: { entityId: "scan:truncated", kind: "scan" }
      });
    }
  } else if (isChangedMode && inGit) {
    let changedRes;
    try {
      changedRes = await getChangedFacts(targetDir, opts.changedFrom, opts, cache);
    } catch (err) {
      policyCleanup();
      die(`--changed-from ${opts.changedFrom}: ${String(err.stderr || err.message).trim()}`, 3);
    }
    candidateFilesCount = changedRes.candidatePaths ? changedRes.candidatePaths.length : 0;
    baseFacts = changedRes.baseFacts;
    headFacts = changedRes.headFacts;
    const diff = diffFacts(baseFacts, headFacts);
    events = diff.events;
    const evalRes = evaluateRules(rulesResult.rules, diff, baseFacts, headFacts, opts);
    findings = evalRes.findings;
  } else {
    const baseDisc = discoverFiles(baseDir, opts);
    baseFacts = extractFacts(baseDisc.files, { truncated: baseDisc.truncated, reason: baseDisc.reason, rootDir: baseDir });

    const headDisc = discoverFiles(headDir, opts);
    headFacts = extractFacts(headDisc.files, { truncated: headDisc.truncated, reason: headDisc.reason, rootDir: headDir });

    candidateFilesCount = (baseDisc.files ? baseDisc.files.length : 0) + (headDisc.files ? headDisc.files.length : 0);

    const diff = diffFacts(baseFacts, headFacts);
    events = diff.events;
    const evalRes = evaluateRules(rulesResult.rules, diff, baseFacts, headFacts, opts);
    findings = evalRes.findings;

    if (baseDisc.truncated || headDisc.truncated) {
      const unexamined = (baseDisc.unexaminedCount || 0) + (headDisc.unexaminedCount || 0);
      console.error(`notice: ${unexamined} candidate files were not checked; raise --max-files`);
      findings.push({
        ruleId: "scan-truncated",
        level: "hard",
        adjustable: false,
        message: `${unexamined} candidate files were not checked; raise --max-files`,
        owners: [],
        docs: null,
        source: { file: headDisc.truncated ? headDir : baseDir, line: 1 },
        event: { entityId: "scan:truncated", kind: "scan" }
      });
    }
  }

  // Policy diff (PR changes to .archtour/ files)
  let policyChanges = [];
  const headPolicyDir = isChangedMode && inGit ? targetDir : headDir;
  if (!isStateMode && policyFrom !== "head" && headPolicyDir) {
    if (isBootstrap) {
      const headArchtour = path.join(headPolicyDir, ".archtour");
      let headHasPolicy = false;
      try {
        headHasPolicy = fs.existsSync(headArchtour) && fs.readdirSync(headArchtour).length > 0;
      } catch {}
      if (headHasPolicy) {
        // Validate head policy files (rules, exceptions) so invalid configs exit 3
        const headRulesFile = [
          path.join(headArchtour, "rules.yml"),
          path.join(headArchtour, "rules.yaml")
        ].find(f => fs.existsSync(f));
        if (headRulesFile) {
          try {
            loadRules(null, { headDir: headPolicyDir, basePath: headPolicyDir, policyDir: headPolicyDir });
          } catch (err) {
            policyCleanup();
            die(err.message, err.exitCode || 3);
          }
        }
        const headExcFile = [
          path.join(headArchtour, "exceptions.yml"),
          path.join(headArchtour, "exceptions.yaml")
        ].find(f => fs.existsSync(f));
        if (headExcFile) {
          try {
            loadExceptionsFile(headExcFile, opts);
          } catch (err) {
            policyCleanup();
            die(err.message, err.exitCode || 3);
          }
        }

        policyChanges = ["A new policy takes effect after merge"];
        findings.push({
          ruleId: "policy-changed",
          level: "soft",
          message: "Policy changed in this PR: a new policy takes effect after merge",
          owners: [],
          docs: null,
          event: { entityId: "policy:.archtour", kind: "policy" },
          source: { file: ".archtour", line: 1 },
          changes: policyChanges
        });
      }
    } else {
      try {
        const diffRes = diffPolicy(policyDir, headPolicyDir, { ...opts, baseRules: rulesResult.rules });
        policyChanges = diffRes.allChanges;
        if (diffRes.loosening.length > 0) {
          const ownersSet = new Set();
          for (const item of diffRes.loosening) {
            const itemOwners = Array.isArray(item.owners) ? item.owners : (item.owners ? [item.owners] : []);
            for (const o of itemOwners) {
              if (o) ownersSet.add(o);
            }
          }
          const descriptions = diffRes.loosening.map(l => l.description).join("; ");
          findings.push({
            ruleId: "policy-changed",
            level: "soft",
            message: `Policy changed in this PR: ${descriptions}`,
            owners: Array.from(ownersSet),
            docs: null,
            event: { entityId: "policy:.archtour", kind: "policy" },
            source: { file: ".archtour", line: 1 },
            changes: policyChanges
          });
        }
      } catch (err) {
        policyCleanup();
        die(err.message, err.exitCode || 3);
      }
    }
  }

  // Baseline ratchet
  const baselinePath = opts.baseline || path.join(policyDir, ".archtour", "baseline.json");
  const celebrations = [];
  if (fs.existsSync(baselinePath)) {
    let baselineData;
    try {
      baselineData = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    } catch (err) {
      policyCleanup();
      die(`failed to parse baseline file "${baselinePath}": ${err.message}`, 3);
    }
    const baselineCounts = (baselineData && typeof baselineData === "object" && baselineData.rules && typeof baselineData.rules === "object")
      ? baselineData.rules
      : (baselineData || {});

    let currentFacts;
    let currentEvents;
    if (isStateMode) {
      currentFacts = headFacts;
      currentEvents = events;
    } else if (isChangedMode && inGit) {
      const disc = discoverFiles(targetDir, opts);
      currentFacts = extractFacts(disc.files, { truncated: disc.truncated, reason: disc.reason });
      currentEvents = extractStateEvents(currentFacts);
    } else {
      currentFacts = headFacts;
      currentEvents = extractStateEvents(currentFacts);
    }
    const { findings: stateFindings } = evaluateRules(rulesResult.rules, { events: currentEvents }, {}, currentFacts, opts);

    const currentCounts = {};
    for (const f of stateFindings) {
      if (f.level === "off") continue;
      currentCounts[f.ruleId] = (currentCounts[f.ruleId] || 0) + 1;
    }

    for (const rule of rulesResult.rules) {
      const ruleId = rule.id;
      const baseCount = baselineCounts[ruleId] || 0;
      const currCount = currentCounts[ruleId] || 0;

      if (currCount > baseCount) {
        findings.push({
          ruleId,
          level: rule.level,
          message: `ratchet: ${ruleId} ${baseCount} -> ${currCount}`,
          owners: Array.isArray(rule.owners) ? [...rule.owners] : (rule.owners ? [rule.owners] : []),
          docs: rule.docs || null,
          source: { file: path.relative(process.cwd(), baselinePath) || baselinePath, line: 1 }
        });
      } else if (currCount < baseCount) {
        celebrations.push(`🎉 ratchet: ${ruleId} dropped from ${baseCount} to ${currCount}! Run \`archtour baseline\` to lock it in.`);
      }
    }
  }

  // Exceptions
  let excFile = opts.exceptions || path.join(policyDir, ".archtour", "exceptions.yml");
  if (!fs.existsSync(excFile)) {
    const altFile = path.join(policyDir, ".archtour", "exceptions.yaml");
    if (fs.existsSync(altFile)) excFile = altFile;
  }
  if (fs.existsSync(excFile)) {
    try {
      const { exceptions } = loadExceptionsFile(excFile, opts);
      applyExceptions(findings, exceptions);
    } catch (err) {
      die(err.message, err.exitCode || 3);
    }
  }

  // Overrides
  const { auditOverrides } = applyOverrides(findings, rulesResult.rules, opts);

  // Exit code calculation
  let exitCode = getExitCode(findings);
  if (isStateMode && !opts.strict) {
    exitCode = 0;
  }

  const mdReport = formatMarkdownReport(findings, {
    celebrations,
    policyChanges,
    headSha: opts.headSha || "",
    candidateFilesExamined: candidateFilesCount,
    noCandidateFiles: candidateFilesCount === 0
  });

  // Detect if the markdown was capped: both the per-rule line and the 60,000-character line say "(see the job log".
  const mdWasCapped = mdReport.includes("(see the job log");
  const logAll = Boolean(opts.logAll);
  const shouldPrintFullFindings = logAll || mdWasCapped;

  const mdOutPath = opts.md || opts.markdown;
  if (mdOutPath) {
    try {
      ensureDir(path.dirname(path.resolve(mdOutPath)));
      fs.writeFileSync(path.resolve(mdOutPath), mdReport);
    } catch (err) {
      die(`failed to write markdown report to ${mdOutPath}: ${err.message}`, 3);
    }
  }

  // Full findings go to stderr, so they reach the GitHub Actions job log in every output mode (the Action runs with
  // --json and redirects stdout to a file, so nothing printed there is visible in the log).
  if (shouldPrintFullFindings) {
    const logLines = formatJobLogLines(findings);
    if (logLines.length > 0) {
      console.error("# Full findings");
      for (const line of logLines) {
        console.error(line);
      }
    }
  }

  if (opts.json) {
    const activeFindings = findings.filter(f => !f.excepted && !f.overridden);
    const counts = {
      total: findings.length,
      blocking: activeFindings.filter(f => f.level === "hard" || f.level === "soft").length,
      overridden: findings.filter(f => f.overridden).length,
      excepted: findings.filter(f => f.excepted).length,
      warnings: activeFindings.filter(f => f.level === "warn" || f.level === "advisory").length,
      hard: activeFindings.filter(f => f.level === "hard").length,
      soft: activeFindings.filter(f => f.level === "soft").length,
      warn: activeFindings.filter(f => f.level === "warn").length,
      advisory: activeFindings.filter(f => f.level === "advisory").length
    };
    const verdict = exitCode === 1 ? "failed" : exitCode === 2 ? "warning" : "passed";
    console.log(JSON.stringify({
      verdict,
      exitCode,
      summary: counts,
      findings,
      overrides: auditOverrides,
      celebrations,
      warnings: rulesResult.warnings || []
    }, null, 2));
  } else {
    console.log(mdReport.trimEnd());
    if (celebrations.length > 0 && !mdReport.includes(celebrations[0])) {
      for (const c of celebrations) {
        console.log(c);
      }
    }
  }

  policyCleanup();
  process.exit(exitCode);
}

async function handleAuditHistoryCommand(repoDirArg, opts = {}) {
  const repoDir = repoDirArg || ".";
  let result;
  try {
    result = await auditHistory(repoDir, opts);
  } catch (err) {
    die(err.message, 3);
  }

  const mdOutPath = opts.md || opts.markdown;
  if (mdOutPath) {
    try {
      ensureDir(path.dirname(path.resolve(mdOutPath)));
      fs.writeFileSync(path.resolve(mdOutPath), result.markdown);
    } catch (err) {
      die(`failed to write markdown report to ${mdOutPath}: ${err.message}`, 3);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.markdown.trimEnd());
  }
}

// ---------------------------------------------------------------- main

function printUsage() {
  console.log("usage: archtour <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  check [<base> <head>]        Architecture guardrails for a change (the CI gate)");
  console.log("  baseline [<dir>]             Lock in current architecture debt counts");
  console.log("  audit-history [<repoDir>]    Audit violations across git commit history");
  console.log("  diff-repo <baseDir> <headDir>  Architecture changes between two directories");
  console.log("  facts [<dir>|<file>]         Show normalized architecture facts");
  console.log("  changes <baseDir> <headDir>  Show architecture change events between two directories");
  console.log("  scan [<dir>]                 List architecture sources and write a spec JSON");
  console.log("");
  console.log("Run 'archtour help <command>' for the options of a command.");
}

function printCheckHelp() {
  console.log("usage: archtour check [<base> <head>] [--changed-from <ref>] [--state <dir>] [options]");
  console.log("");
  console.log("Options:");
  console.log("  --changed-from <ref>        Compare working tree against git ref");
  console.log("  --state <dir>               Check current state of directory");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
  console.log("  --migration-dir <path>      Extra folder whose .sql files are migrations (repeatable)");
  console.log("  --max-file-size <MB>        Skip files larger than this (default: 5; Terraform plan JSON: 50)");
  console.log("  --json                      Output machine-readable JSON");
  console.log("  --md, --markdown <file>     Write markdown report to file");
  console.log("  --log-all                   Print every finding to stderr (job log), even if the report is not capped");
  console.log("  --rules <file>              Custom rules file");
  console.log("  --include-untracked         Include untracked files with --changed-from");
  console.log("  --cache-dir <dir>           Directory to cache extracted facts");
  console.log("  --override*, --override     Override soft findings (--override-by, --override-reason, --override-sha)");
  console.log("  --pr-author <user>          PR author");
  console.log("  --policy-from <base|head>   Base or head policy to use");
  console.log("  --head-sha <sha>            Head commit SHA");
}

function printBaselineHelp() {
  console.log("usage: archtour baseline [<dir>] [-o <file>] [--rules <file>] [--max-files <n>]");
  console.log("");
  console.log("Lock in current architecture debt counts to baseline.json.");
  console.log("");
  console.log("Options:");
  console.log("  -o, --out <file>            Output path for baseline (default: <dir>/.archtour/baseline.json)");
  console.log("  --rules <file>              Custom rules file");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
  console.log("  --migration-dir <path>      Extra folder whose .sql files are migrations (repeatable)");
  console.log("  --max-file-size <MB>        Skip files larger than this (default: 5; Terraform plan JSON: 50)");
}

function printFactsHelp() {
  console.log("usage: archtour facts [<dir>|<file>] [--json] [--max-files <n>]");
  console.log("");
  console.log("Extract and display normalized architecture facts.");
  console.log("");
  console.log("Options:");
  console.log("  --json                      Output machine-readable JSON");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
  console.log("  --migration-dir <path>      Extra folder whose .sql files are migrations (repeatable)");
  console.log("  --max-file-size <MB>        Skip files larger than this (default: 5; Terraform plan JSON: 50)");
}

function printChangesHelp() {
  console.log("usage: archtour changes <baseDir> <headDir> [--json] [--max-files <n>]");
  console.log("");
  console.log("Show architecture changes and events between two directories.");
  console.log("");
  console.log("Options:");
  console.log("  --json                      Output machine-readable JSON");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
  console.log("  --migration-dir <path>      Extra folder whose .sql files are migrations (repeatable)");
  console.log("  --max-file-size <MB>        Skip files larger than this (default: 5; Terraform plan JSON: 50)");
}

function printAuditHistoryHelp() {
  console.log("usage: archtour audit-history [<repoDir>] [--max-commits <n>] [--since <date>] [--md <file>] [--json]");
  console.log("");
  console.log("Audit architectural violations across git commit history.");
  console.log("");
  console.log("Options:");
  console.log("  --max-commits <n>           Maximum commits to inspect (default: 200)");
  console.log("  --since <date>              Audit commits since date");
  console.log("  --md, --markdown <file>     Write markdown report to file");
  console.log("  --json                      Output machine-readable JSON");
}

function printDiffRepoHelp() {
  console.log("usage: archtour diff-repo <baseDir> <headDir> [-o diff.md|diff.json] [--format markdown|json] [options]");
  console.log("");
  console.log("Show architecture changes between two directories (sources, not a diagram).");
  console.log("");
  console.log("Options:");
  console.log("  -o, --out <file>            Write the report to a .md or .json file");
  console.log("  --format markdown|json      Print the report in the given format");
  console.log("  --markdown <file>           Write the markdown report to a file");
  console.log("  --summary-json <file>       Write a small machine-readable summary");
  console.log("  --ignore <path>             Path or folder to ignore (repeatable)");
  console.log("  --include-tests             Scan test, fixture and example directories");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
}

function printScanHelp() {
  console.log("usage: archtour scan [<dir>] [-o out.json] [options]");
  console.log("");
  console.log("List the architecture sources found and write a normalized spec JSON.");
  console.log("");
  console.log("Options:");
  console.log("  -o, --out <file>            Output path (must end in .json)");
  console.log("  --json                      Write JSON (the default output)");
  console.log("  --ignore <path>             Path or folder to ignore (repeatable)");
  console.log("  --include-tests             Scan test, fixture and example directories");
  console.log("  --max-files <n>             Maximum candidate files to examine (default: 20000)");
  console.log("  --migration-dir <path>      Extra folder whose .sql files are migrations (repeatable)");
  console.log("  --max-file-size <MB>        Skip files larger than this (default: 5; Terraform plan JSON: 50)");
  console.log("  --max-nodes <n>             Split large specs at n nodes (default: 15)");
}

// A run is a help request only when help sits in an option position: --help/-h seen by parseArgs as a flag, the leading
// help subcommand, or the first argument after the subcommand. An option VALUE (`--override help`, `--override-reason -h`)
// is never a help request: the GitHub Action passes PR-comment text as option values, so treating a value as help turned
// a failing check green.
function isHelpRequest(cmd, rest, opts) {
  if (opts && opts.help) return true;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return true;
  return rest[0] === "help";
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    return;
  }
  const opts = parseArgs(rest);

  const isHelp = isHelpRequest(cmd, rest, opts);
  if (isHelp) {
    const helpTarget = (cmd === "--help" || cmd === "-h" || cmd === "help") ? (rest[0] || "") : (cmd || "");
    if (helpTarget === "check") { printCheckHelp(); return; }
    if (helpTarget === "baseline") { printBaselineHelp(); return; }
    if (helpTarget === "facts") { printFactsHelp(); return; }
    if (helpTarget === "changes") { printChangesHelp(); return; }
    if (helpTarget === "audit-history") { printAuditHistoryHelp(); return; }
    if (helpTarget === "diff-repo") { printDiffRepoHelp(); return; }
    if (helpTarget === "scan") { printScanHelp(); return; }
    printUsage();
    return;
  }
  if (opts.maxFileSize !== undefined) {
    if (!Number.isFinite(opts.maxFileSize) || opts.maxFileSize <= 0 || opts.maxFileSize > 1024) {
      die("--max-file-size must be a number of MB between 0 and 1024", 3);
    }
  }
  setSettings({ migrationDirs: opts.migrationDirs, maxFileSizeMb: opts.maxFileSize });

  const input = opts._[0];
  if (cmd === "scan") await handleScanCommand(input, opts);
  else if (cmd === "diff-repo") await handleDiffRepoCommand(opts._[0], opts._[1], opts);
  // `check` is ONLY the guardrails command.
  else if (cmd === "check") {
    const isState = opts.state !== undefined && opts.state !== false;
    const isChanged = opts.changedFrom !== undefined && opts.changedFrom !== false;
    if (isState) {
      const stateDir = (typeof opts.state === "string" ? opts.state : null) || opts._[0];
      if (!stateDir || typeof stateDir !== "string" || !stateDir.trim()) {
        die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
      }
    } else if (isChanged) {
      if (typeof opts.changedFrom !== "string" || !opts.changedFrom.trim()) {
        die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
      }
    } else {
      if (!opts._[0] || !opts._[1] || typeof opts._[0] !== "string" || typeof opts._[1] !== "string" || !opts._[0].trim() || !opts._[1].trim()) {
        die("check needs <base> <head>, --changed-from <ref> or --state <dir>", 3);
      }
    }
    await handleCheckCommand(opts._[0], opts._[1], opts);
  }
  else if (cmd === "baseline") await handleBaselineCommand(opts._[0], opts);
  else if (cmd === "facts") await handleFactsCommand(input, opts);
  else if (cmd === "changes") await handleChangesCommand(opts._[0], opts._[1], opts);
  else if (cmd === "audit-history") await handleAuditHistoryCommand(input, opts);
  else die("usage: archtour <check|baseline|audit-history|diff-repo|facts|changes|scan> [options]  (run 'archtour help')");
}

function handleError(err) {
  if (process.env.ARCHTOUR_DEBUG === "1") {
    console.error(err);
  } else {
    let msg = err?.message || String(err);
    if (err?.code === "EISDIR") {
      msg = `"${err.path || "input"}" is a directory, expected a file`;
    } else if (err?.code === "ENOENT") {
      msg = `no such file or directory: ${err.path || ""}`.trim();
    }
    msg = msg.replace(/^Error:\s*/, "");
    if (msg.startsWith("archtour: ")) {
      console.error(msg);
    } else {
      console.error(`archtour: ${msg}`);
    }
  }
  process.exit(1);
}

// npm installs the bin as a symlink on Linux/macOS (node_modules/.bin/archtour -> tools/diagram.mjs): compare real paths,
// or the command does nothing and exits 0.
const realArgv1 = (() => {
  try {
    return fs.realpathSync(process.argv[1]);
  } catch {
    return process.argv[1] ? path.resolve(process.argv[1]) : "";
  }
})();
const isMain = process.argv[1] && (
  realArgv1 === fs.realpathSync(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith("diagram.mjs")
);
if (isMain) {
  process.on("uncaughtException", handleError);
  process.on("unhandledRejection", handleError);
  main().catch(handleError);
}
