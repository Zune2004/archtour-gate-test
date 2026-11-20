import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadRulesFile } from "./rules.mjs";
import { RECOMMENDED_RULES } from "./rules-recommended.mjs";

/**
 * Parses an override comment looking for:
 * /archtour override <ruleId> <sha> <reason>
 * <ruleId> can be comma-separated: rule-1,rule-2
 * <sha> is parsed from 7 hex characters so a short one can be refused with a clear reason; resolveOverride accepts
 * only 12 or more.
 */
export function parseOverrideComment(commentBody) {
  if (typeof commentBody !== "string") return null;
  const lines = commentBody.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(/^\/archtour\s+override\s+([^\s]+)\s+([0-9a-fA-F]{7,})\s+(.+)$/);
    if (match) {
      const ruleId = match[1].trim();
      const sha = match[2].trim().toLowerCase();
      const reason = match[3].trim();
      return { ruleId, sha, reason };
    }
  }
  return null;
}

/**
 * Checks a collaborator's repository permission via GitHub REST API.
 * Permitted roles: "write", "maintain", "admin".
 */
export async function checkUserPermission({ owner, repo, username, token, fetchImpl = fetch }) {
  if (!owner || !repo || !username) {
    return { allowed: false, permission: "none", error: "Missing required parameters" };
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/collaborators/${username}/permission`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "User-Agent": "archtour-action"
      }
    });
    if (!res.ok) {
      return { allowed: false, permission: "none", status: res.status };
    }
    const data = await res.json();
    const perm = data?.permission || data?.role_name || "none";
    const allowed = ["write", "maintain", "admin"].includes(String(perm).toLowerCase());
    return { allowed, permission: perm };
  } catch (err) {
    return { allowed: false, permission: "none", error: err.message };
  }
}

export function getRulesForOverride(rulesOpt, rulesFileOpt, pathsOpt) {
  if (Array.isArray(rulesOpt)) return rulesOpt;
  if (rulesOpt && typeof rulesOpt === "object" && Array.isArray(rulesOpt.rules)) return rulesOpt.rules;
  if (rulesFileOpt && fs.existsSync(rulesFileOpt)) {
    try {
      const res = loadRulesFile(rulesFileOpt);
      if (res && Array.isArray(res.rules)) return res.rules;
    } catch {}
  }
  // Root-level .archtour/rules.yml (workspace root of the PR checkout)
  const defaultPath = path.resolve(".archtour/rules.yml");
  let rootRules = null;
  if (fs.existsSync(defaultPath)) {
    try {
      const res = loadRulesFile(defaultPath);
      if (res && Array.isArray(res.rules) && res.rules.length > 0) {
        rootRules = res.rules;
      }
    } catch {}
  }
  // Also look under each paths: input for slice policies (sub-folder .archtour/)
  if (pathsOpt) {
    const pathList = Array.isArray(pathsOpt) ? pathsOpt : String(pathsOpt).split(",").map(s => s.trim()).filter(Boolean);
    for (const p of pathList) {
      if (!p) continue;
      const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
      const rulesPath = path.resolve(norm, ".archtour", "rules.yml");
      if (fs.existsSync(rulesPath)) {
        try {
          const res = loadRulesFile(rulesPath);
          if (res && Array.isArray(res.rules) && res.rules.length > 0) return res.rules;
        } catch {}
      }
      const rulesYamlPath = path.resolve(norm, ".archtour", "rules.yaml");
      if (fs.existsSync(rulesYamlPath)) {
        try {
          const res = loadRulesFile(rulesYamlPath);
          if (res && Array.isArray(res.rules) && res.rules.length > 0) return res.rules;
        } catch {}
      }
    }
  }
  // Return root rules if found, otherwise fall back to recommended
  return rootRules || RECOMMENDED_RULES;
}

/**
 * Checks organization team memberships for a user for specific named teams.
 * Only the teams named by the rules being overridden are queried.
 */
export async function getUserTeams({ org, username, teams = [], rules = [], token, fetchImpl = fetch }) {
  if (!username || !token) return [];
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "archtour-action"
  };

  const candidateTeams = new Set();
  const addCandidate = (t) => {
    if (typeof t === "string" && t.trim()) {
      candidateTeams.add(t.trim());
    }
  };

  if (typeof teams === "string") {
    teams.split(",").forEach(addCandidate);
  } else if (Array.isArray(teams)) {
    teams.forEach(addCandidate);
  }

  if (Array.isArray(rules)) {
    for (const r of rules) {
      const owners = Array.isArray(r.owners) ? r.owners : (r.owners ? [r.owners] : []);
      for (const o of owners) {
        if (typeof o === "string") {
          const trimmed = o.trim();
          if (trimmed.startsWith("@") || trimmed.includes("/")) {
            addCandidate(trimmed);
          }
        }
      }
    }
  }

  if (candidateTeams.size === 0) return [];

  const memberTeams = [];

  for (const teamItem of candidateTeams) {
    let raw = teamItem.startsWith("@") ? teamItem.slice(1) : teamItem;
    let teamOrg = org;
    let teamSlug = raw;
    if (raw.includes("/")) {
      const parts = raw.split("/");
      teamOrg = parts[0];
      teamSlug = parts.slice(1).join("/");
    }
    if (!teamOrg || !teamSlug) continue;

    const url = `https://api.github.com/orgs/${encodeURIComponent(teamOrg)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`;
    if (!url.startsWith("https://api.github.com/")) continue;

    try {
      const memRes = await fetchImpl(url, { headers });
      if (memRes.ok) {
        const memData = await memRes.json();
        if (memData && memData.state === "active") {
          memberTeams.push(`${teamOrg}/${teamSlug}`);
          memberTeams.push(teamSlug);
          memberTeams.push(`@${teamOrg}/${teamSlug}`);
        }
      }
    } catch {
      // Ignore single team membership check failures
    }
  }

  return Array.from(new Set(memberTeams));
}

/**
 * Resolves PR override settings from event payload and comments.
 */
export async function resolveOverride({
  event,
  comments,
  issueEvents,
  events,
  fetchImpl = fetch,
  token,
  repo,
  labelAuthor,
  headSha,
  requireLabel = true,
  rules,
  rulesFile,
  teams,
  paths
} = {}) {
  if (!event || (!event.pull_request && !event.issue?.pull_request)) {
    return { active: false, reason: "not_a_pull_request" };
  }

  const pr = event.pull_request || event.issue;
  const labels = pr.labels || [];
  const hasLabel = labels.some(l => (typeof l === "string" ? l : l?.name) === "archtour-override");

  if (requireLabel && !hasLabel) {
    return { active: false, hasLabel: false, reason: "no_override_label" };
  }

  let fullRepo = "";
  if (typeof repo === "string" && repo) {
    fullRepo = repo;
  } else if (repo?.full_name) {
    fullRepo = repo.full_name;
  } else if (repo?.owner?.login && repo?.name) {
    fullRepo = `${repo.owner.login}/${repo.name}`;
  } else if (event.repository?.full_name) {
    fullRepo = event.repository.full_name;
  } else if (process.env.GITHUB_REPOSITORY) {
    fullRepo = process.env.GITHUB_REPOSITORY;
  }

  const [owner, repoName] = fullRepo.split("/");
  const prNumber = pr.number;

  const currentHeadSha = (headSha || event.pull_request?.head?.sha || pr.head?.sha || process.env.ARCHTOUR_PR_HEAD_SHA || "").trim().toLowerCase();

  const parseNextLink = (linkHeader) => {
    if (!linkHeader || typeof linkHeader !== "string") return null;
    for (const part of linkHeader.split(",")) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/i);
      if (match && match[2].toLowerCase() === "next") {
        const next = match[1].trim();
        // The token goes with every request: follow only GitHub API links
        return next.startsWith("https://api.github.com/") ? next : null;
      }
    }
    return null;
  };

  // 1. Fetch issue events to identify the actor of the most recent labeled event for archtour-override
  let eventsList = issueEvents || (Array.isArray(events) ? events : null);
  if (!Array.isArray(eventsList)) {
    if (!owner || !repoName || !prNumber) {
      return { active: false, hasLabel, reason: "cannot_fetch_events" };
    }
    const allEvents = [];
    let eventsUrl = `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/events?per_page=100`;
    let pageCount = 0;
    const maxPages = 30;

    try {
      while (eventsUrl && pageCount < maxPages) {
        pageCount++;
        const res = await fetchImpl(eventsUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "User-Agent": "archtour-action"
          }
        });
        if (!res.ok) {
          return { active: false, hasLabel, reason: `fetch_events_failed_${res.status}` };
        }
        const pageItems = await res.json();
        if (Array.isArray(pageItems)) {
          allEvents.push(...pageItems);
        }
        const linkHeader = typeof res.headers?.get === "function"
          ? res.headers.get("link")
          : (res.headers?.link || res.headers?.Link || null);
        eventsUrl = parseNextLink(linkHeader);
      }
      eventsList = allEvents;
    } catch (err) {
      return { active: false, hasLabel, reason: `fetch_events_error: ${err.message}` };
    }
  }

  const labeledEvents = (eventsList || []).filter(e => {
    const isLabeled = e.event === "labeled";
    const lblName = typeof e.label === "string" ? e.label : e.label?.name;
    return isLabeled && lblName === "archtour-override";
  });

  labeledEvents.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : (a.id || 0);
    const db = b.created_at ? new Date(b.created_at).getTime() : (b.id || 0);
    return da - db;
  });

  const latestLabeledEvent = labeledEvents[labeledEvents.length - 1];
  const latestLabeller = latestLabeledEvent?.actor?.login || (typeof latestLabeledEvent?.actor === "string" ? latestLabeledEvent.actor : null);

  let expectedAuthor = latestLabeller || null;
  if (labelAuthor) {
    if (latestLabeller && latestLabeller !== labelAuthor) {
      return { active: false, hasLabel, reason: "label_author_mismatch" };
    }
    if (!expectedAuthor) expectedAuthor = labelAuthor;
  }
  if (!expectedAuthor) {
    return { active: false, hasLabel, reason: "no_labeled_event" };
  }

  // 2. Fetch comments if not provided
  let commentsList = comments;
  if (!Array.isArray(commentsList)) {
    if (!owner || !repoName || !prNumber) {
      return { active: false, hasLabel, reason: "cannot_fetch_comments" };
    }
    const allComments = [];
    let commentsUrl = `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`;
    let pageCount = 0;
    const maxPages = 30;

    try {
      while (commentsUrl && pageCount < maxPages) {
        pageCount++;
        const res = await fetchImpl(commentsUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "User-Agent": "archtour-action"
          }
        });
        if (!res.ok) {
          return { active: false, hasLabel, reason: `fetch_comments_failed_${res.status}` };
        }
        const pageItems = await res.json();
        if (Array.isArray(pageItems)) {
          allComments.push(...pageItems);
        }
        const linkHeader = typeof res.headers?.get === "function"
          ? res.headers.get("link")
          : (res.headers?.link || res.headers?.Link || null);
        commentsUrl = parseNextLink(linkHeader);
      }
      commentsList = allComments;
    } catch (err) {
      return { active: false, hasLabel, reason: `fetch_comments_error: ${err.message}` };
    }
  }

  if (!Array.isArray(commentsList) || commentsList.length === 0) {
    return { active: false, hasLabel, reason: "no_comments" };
  }

  // Sort comments ascending so reverse iteration visits newest first
  const sorted = [...commentsList].sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : (a.id || 0);
    const db = b.created_at ? new Date(b.created_at).getTime() : (b.id || 0);
    return da - db;
  });

  for (let idx = sorted.length - 1; idx >= 0; idx--) {
    const comment = sorted[idx];

    // Reject edited comments: updated_at must equal created_at
    if (comment?.created_at && comment?.updated_at && comment.created_at !== comment.updated_at) {
      continue;
    }

    const author = comment?.user?.login;
    if (!author) continue;
    if (author !== expectedAuthor) continue;

    // The PR author can never approve their own findings, even with the label and a well-formed comment.
    const prAuthorLogin = (pr.user && (typeof pr.user === "string" ? pr.user : pr.user.login)) || "";
    if (prAuthorLogin && String(author).toLowerCase() === String(prAuthorLogin).toLowerCase()) {
      return { active: false, hasLabel, reason: "pr_author_cannot_override" };
    }

    const parsed = parseOverrideComment(comment?.body);
    if (!parsed) continue;

    if (!currentHeadSha) {
      continue;
    }
    // Only the full head SHA binds an approval; a shorter prefix (even 12 characters) can be matched by a generated commit.
    if (parsed.sha.length < currentHeadSha.length || !/^[0-9a-f]+$/.test(parsed.sha)) {
      return { active: false, hasLabel, reason: "sha_too_short", sha: parsed.sha };
    }
    if (parsed.sha !== currentHeadSha) {
      continue;
    }

    const permResult = await checkUserPermission({
      owner,
      repo: repoName,
      username: author,
      token,
      fetchImpl
    });

    if (permResult.allowed) {
      const overriddenRuleIds = parsed.ruleId.split(",").map(r => r.trim()).filter(Boolean);
      const allRules = getRulesForOverride(rules, rulesFile, paths);
      // A rule id that is not in the loaded policy can never be an override target (it used to reach the CLI only as
      // free text; `help` there used to print usage and exit 0).
      const knownRuleIds = new Set(allRules.map(r => r.id));
      const unknownRuleIds = overriddenRuleIds.filter(id => !knownRuleIds.has(id));
      if (unknownRuleIds.length > 0) {
        return { active: false, hasLabel, reason: `unknown_rule_id: ${unknownRuleIds.join(",")}` };
      }
      const candidateRules = allRules.filter(r => overriddenRuleIds.includes(r.id));
      const candidateTeams = new Set();
      if (teams) {
        (Array.isArray(teams) ? teams : [teams]).forEach(t => candidateTeams.add(t));
      }
      for (const r of candidateRules) {
        const owners = Array.isArray(r.owners) ? r.owners : (r.owners ? [r.owners] : []);
        for (const o of owners) {
          if (typeof o === "string" && o.trim()) candidateTeams.add(o.trim());
        }
      }
      const userTeams = await getUserTeams({
        org: owner,
        username: author,
        teams: Array.from(candidateTeams),
        token,
        fetchImpl
      });
      return {
        active: true,
        hasLabel,
        ruleId: parsed.ruleId,
        sha: parsed.sha,
        reason: parsed.reason,
        overrideBy: author,
        overridePermission: permResult.permission,
        prAuthor: pr.user?.login || "",
        ownerTeams: userTeams,
        commentId: comment.id,
        createdAt: comment.created_at
      };
    }
  }

  return { active: false, hasLabel, reason: "no_valid_override_comment" };
}

function writeGitHubEnv(name, value) {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) return;
  const valStr = String(value);
  if (valStr.includes("\n") || valStr.includes("\r")) {
    const delimiter = "EOF_" + crypto.randomBytes(8).toString("hex");
    fs.appendFileSync(envFile, `${name}<<${delimiter}\n${valStr}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(envFile, `${name}=${valStr}\n`);
  }
}

function writeGitHubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const valStr = String(value);
  if (valStr.includes("\n") || valStr.includes("\r")) {
    const delimiter = "EOF_" + crypto.randomBytes(8).toString("hex");
    fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${valStr}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(outputFile, `${name}=${valStr}\n`);
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log("No GITHUB_EVENT_PATH found; skipping override resolution.");
    writeGitHubOutput("has_override", "false");
    writeGitHubEnv("ARCHTOUR_HAS_OVERRIDE", "false");
    return;
  }

  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch (err) {
    console.error("Failed to parse event JSON:", err.message);
    writeGitHubOutput("has_override", "false");
    writeGitHubEnv("ARCHTOUR_HAS_OVERRIDE", "false");
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const headSha = process.env.ARCHTOUR_PR_HEAD_SHA || event.pull_request?.head?.sha || "";

  const paths = process.env.INPUT_PATHS || process.env.ARCHTOUR_INPUT_PATHS || "";
  const result = await resolveOverride({ event, token, repo, headSha, paths });
  if (result.active) {
    writeGitHubOutput("has_override", "true");
    writeGitHubOutput("override_rule", result.ruleId);
    writeGitHubOutput("override_sha", result.sha);
    writeGitHubOutput("override_by", result.overrideBy);
    writeGitHubOutput("override_permission", result.overridePermission || "");
    writeGitHubOutput("owner_teams", (result.ownerTeams || []).join(","));
    writeGitHubOutput("override_reason", result.reason);

    writeGitHubEnv("ARCHTOUR_HAS_OVERRIDE", "true");
    writeGitHubEnv("ARCHTOUR_OVERRIDE_RULE", result.ruleId);
    writeGitHubEnv("ARCHTOUR_OVERRIDE_SHA", result.sha);
    writeGitHubEnv("ARCHTOUR_OVERRIDE_BY", result.overrideBy);
    writeGitHubEnv("ARCHTOUR_OVERRIDE_PERMISSION", result.overridePermission || "");
    writeGitHubEnv("ARCHTOUR_PR_AUTHOR", result.prAuthor || "");
    writeGitHubEnv("ARCHTOUR_OWNER_TEAMS", (result.ownerTeams || []).join(","));
    writeGitHubEnv("ARCHTOUR_OVERRIDE_REASON", result.reason);

    console.log(`Archtour override active: rule(s)=${result.ruleId}, sha=${result.sha}, by=${result.overrideBy}`);
  } else {
    writeGitHubOutput("has_override", "false");
    writeGitHubEnv("ARCHTOUR_HAS_OVERRIDE", "false");
    console.log(`Archtour override inactive (${result.reason || "none"})`);
  }
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isMain) {
  main().catch((err) => {
    console.error("Override resolution failed:", err);
    writeGitHubOutput("has_override", "false");
    writeGitHubEnv("ARCHTOUR_HAS_OVERRIDE", "false");
    process.exit(0); // Non-fatal for override step
  });
}
