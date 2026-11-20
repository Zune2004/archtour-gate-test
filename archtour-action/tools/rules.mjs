// Architecture Rules Engine
// Validates, loads, extends, merges, and evaluates guardrail rules over architecture diff events.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RECOMMENDED_RULES } from "./rules-recommended.mjs";
import { mdText } from "./diff.mjs";
import { isSqlMigrationCandidate } from "./facts-sql.mjs";

export const LEVELS = ["off", "advisory", "warn", "soft", "hard"];

export const LEVEL_SEVERITY = {
  off: 0,
  advisory: 1,
  warn: 2,
  soft: 3,
  hard: 4
};

/**
 * Matches a string value against a glob pattern.
 * Supports `*`, `?`, `**`, and leading `!` negation.
 */
export function matchGlob(value, pattern) {
  if (value == null) return false;
  const str = String(value).replace(/\\/g, "/");
  if (typeof pattern !== "string") return false;

  const isNegated = pattern.startsWith("!");
  const rawPattern = (isNegated ? pattern.slice(1) : pattern).replace(/\\/g, "/");

  let regexStr = "^";
  let i = 0;
  while (i < rawPattern.length) {
    const c = rawPattern[i];
    if (c === "*" && rawPattern[i + 1] === "*" && rawPattern[i + 2] === "/") {
      regexStr += "(?:.*\\/)?";
      i += 3;
    } else if (c === "/" && rawPattern[i + 1] === "*" && rawPattern[i + 2] === "*") {
      regexStr += "(?:\\/.*)?";
      i += 3;
    } else if (c === "*" && rawPattern[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += ".";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";

  const regex = new RegExp(regexStr);
  const matched = regex.test(str);
  return isNegated ? !matched : matched;
}

/**
 * Validates a single rule schema.
 * Throws an error with rule id and field name if invalid.
 */
export function validateRule(rule, isNewRule = true) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error('Rule must be an object');
  }

  if (typeof rule.id !== "string" || !rule.id.trim()) {
    throw new Error('Rule is missing required field "id"');
  }

  const id = rule.id.trim();

  if (typeof rule.level !== "string" || !LEVELS.includes(rule.level)) {
    throw new Error(`Rule "${id}" has invalid field "level": "${rule.level}". Must be one of: ${LEVELS.join(", ")}`);
  }

  if (isNewRule && rule.on == null) {
    throw new Error(`Rule "${id}" is missing required field "on"`);
  }

  if (rule.on != null) {
    if (typeof rule.on === "string") {
      if (!rule.on.trim()) {
        throw new Error(`Rule "${id}" has invalid field "on": cannot be empty`);
      }
    } else if (Array.isArray(rule.on)) {
      if (rule.on.length === 0 || rule.on.some(item => typeof item !== "string" || !item.trim())) {
        throw new Error(`Rule "${id}" has invalid field "on": must contain non-empty string event types`);
      }
    } else {
      throw new Error(`Rule "${id}" has invalid field "on": must be a string or array of strings`);
    }
  }

  if (rule.where != null) {
    if (typeof rule.where !== "object" || Array.isArray(rule.where)) {
      throw new Error(`Rule "${id}" has invalid field "where": must be an object`);
    }
    for (const [key, pat] of Object.entries(rule.where)) {
      if (typeof pat !== "string" && (!Array.isArray(pat) || pat.some(p => typeof p !== "string"))) {
        throw new Error(`Rule "${id}" has invalid field "where.${key}": matcher must be a string glob or array of string globs`);
      }
    }
  }

  if (rule.owners != null) {
    if (typeof rule.owners !== "string" && (!Array.isArray(rule.owners) || rule.owners.some(o => typeof o !== "string"))) {
      throw new Error(`Rule "${id}" has invalid field "owners": must be a string or array of strings`);
    }
  }

  if (rule.docs != null && typeof rule.docs !== "string") {
    throw new Error(`Rule "${id}" has invalid field "docs": must be a string`);
  }

  if (rule.message != null && typeof rule.message !== "string") {
    throw new Error(`Rule "${id}" has invalid field "message": must be a string`);
  }

  if (rule.adjustable != null && typeof rule.adjustable !== "boolean") {
    throw new Error(`Rule "${id}" has invalid field "adjustable": must be a boolean`);
  }

  if (rule.enforce_from != null) {
    if (typeof rule.enforce_from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rule.enforce_from) || isNaN(Date.parse(rule.enforce_from))) {
      throw new Error(`Rule "${id}" has invalid field "enforce_from": "${rule.enforce_from}". Must be YYYY-MM-DD`);
    }
  }
}

/**
 * Validates the top-level rules document configuration.
 */
export function validateRulesConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error('Invalid rules configuration: document must be an object');
  }

  if (config.version !== 1) {
    throw new Error('Invalid rules configuration: "version" must be 1');
  }

  if (config.extends != null) {
    if (typeof config.extends !== "string" && !Array.isArray(config.extends)) {
      throw new Error('Invalid rules configuration: "extends" must be an array of strings or a string');
    }
    const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const item of extendsList) {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error('Invalid rules configuration: "extends" entries must be non-empty strings');
      }
      const trimmed = item.trim();
      if (/^(https?:|\/\/|git:\/\/|ssh:\/\/|ftp:\/\/)/i.test(trimmed)) {
        throw new Error(`Invalid rules configuration: "extends" contains network URL "${trimmed}". Network imports are not allowed`);
      }
    }
  }

  if (config.rules != null) {
    if (!Array.isArray(config.rules)) {
      throw new Error('Invalid rules configuration: "rules" must be an array');
    }
    const seenIds = new Set();
    for (const rule of config.rules) {
      validateRule(rule, false);
      if (seenIds.has(rule.id)) {
        throw new Error(`Duplicate rule id "${rule.id}" in rules file`);
      }
      seenIds.add(rule.id);
    }
  }
}

function mergeRuleIntoMap(rulesMap, incomingRule, sourceName, warnings) {
  if (rulesMap.has(incomingRule.id)) {
    const existing = rulesMap.get(incomingRule.id);
    const oldLevel = existing.level;
    const newLevel = incomingRule.level;

    if (existing.adjustable === false) {
      if (incomingRule.where !== undefined) {
        const err = new Error(`Rule "${incomingRule.id}" has invalid field "where": cannot override "where" on non-adjustable rule (adjustable: false)`);
        err.exitCode = 3;
        throw err;
      }
      if (incomingRule.enforce_from !== undefined) {
        const err = new Error(`Rule "${incomingRule.id}" has invalid field "enforce_from": cannot override "enforce_from" on non-adjustable rule (adjustable: false)`);
        err.exitCode = 3;
        throw err;
      }
      if (incomingRule.on !== undefined) {
        const err = new Error(`Rule "${incomingRule.id}" has invalid field "on": cannot override "on" on non-adjustable rule (adjustable: false)`);
        err.exitCode = 3;
        throw err;
      }
      if (incomingRule.owners !== undefined) {
        const err = new Error(`Rule "${incomingRule.id}" has invalid field "owners": cannot override "owners" on non-adjustable rule (adjustable: false)`);
        err.exitCode = 3;
        throw err;
      }
    }

    let finalLevel = oldLevel;
    if (newLevel != null) {
      const oldSev = LEVEL_SEVERITY[oldLevel] ?? 0;
      const newSev = LEVEL_SEVERITY[newLevel] ?? 0;

      if (newSev >= oldSev) {
        // Stricter or equal: always allowed
        finalLevel = newLevel;
      } else {
        // Loosening: only allowed if existing.adjustable === true
        if (existing.adjustable === true) {
          finalLevel = newLevel;
        } else {
          // Loosening ignored with warning
          finalLevel = oldLevel;
          warnings.push({
            ruleId: incomingRule.id,
            source: sourceName,
            oldLevel,
            newLevel,
            message: `Warning: Rule "${incomingRule.id}" level cannot be loosened from "${oldLevel}" to "${newLevel}" in "${sourceName}" because adjustable is false; loosening ignored.`
          });
        }
      }
    }

    rulesMap.set(incomingRule.id, {
      ...existing,
      ...incomingRule,
      level: finalLevel,
      adjustable: existing.adjustable === false ? false : (incomingRule.adjustable !== undefined ? incomingRule.adjustable : existing.adjustable),
      on: incomingRule.on !== undefined ? incomingRule.on : existing.on,
      where: incomingRule.where !== undefined ? incomingRule.where : existing.where,
      message: incomingRule.message !== undefined ? incomingRule.message : existing.message,
      owners: incomingRule.owners !== undefined ? incomingRule.owners : existing.owners,
      docs: incomingRule.docs !== undefined ? incomingRule.docs : existing.docs,
      enforce_from: incomingRule.enforce_from !== undefined ? incomingRule.enforce_from : existing.enforce_from
    });
  } else {
    // New rule
    if (incomingRule.on == null) {
      throw new Error(`Rule "${incomingRule.id}" is missing required field "on"`);
    }
    rulesMap.set(incomingRule.id, {
      adjustable: incomingRule.adjustable !== undefined ? incomingRule.adjustable : true,
      ...incomingRule
    });
  }
}

/**
 * Loads a rules file from disk, resolving extends recursively in order and merging rules.
 */
export function loadRulesFile(filePath, visited = new Set(), warnings = []) {
  const resolvedPath = path.resolve(filePath);
  if (visited.has(resolvedPath)) {
    throw new Error(`Circular dependency detected in "extends": "${resolvedPath}"`);
  }
  visited.add(resolvedPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Invalid rules configuration: Cannot find rules file at "${filePath}"`);
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  let doc;
  try {
    doc = YAML.parse(content, { merge: true, logLevel: "error" });
  } catch (err) {
    throw new Error(`Failed to parse YAML in rules file "${filePath}": ${err.message}`);
  }

  validateRulesConfig(doc);

  const rulesMap = new Map();

  if (doc.extends) {
    const extendsList = Array.isArray(doc.extends) ? doc.extends : [doc.extends];
    for (const item of extendsList) {
      const trimmed = item.trim();
      if (trimmed === "archtour:recommended") {
        for (const rule of RECOMMENDED_RULES) {
          rulesMap.set(rule.id, { ...rule });
        }
      } else if (trimmed.startsWith("archtour:")) {
        throw new Error(`Invalid rules configuration: Unknown built-in pack "${trimmed}" in "extends"`);
      } else {
        const parentDir = path.dirname(resolvedPath);
        const extPath = path.resolve(parentDir, trimmed);
        if (!fs.existsSync(extPath)) {
          throw new Error(`Invalid rules configuration: Extended rules file "${trimmed}" not found at "${extPath}"`);
        }
        const extResult = loadRulesFile(extPath, new Set(visited), warnings);
        for (const r of extResult.rules) {
          mergeRuleIntoMap(rulesMap, r, trimmed, warnings);
        }
      }
    }
  }

  if (doc.rules && Array.isArray(doc.rules)) {
    for (const r of doc.rules) {
      mergeRuleIntoMap(rulesMap, r, filePath, warnings);
    }
  }

  return {
    rules: Array.from(rulesMap.values()),
    warnings,
    config: doc
  };
}

/**
 * Loads rules from an explicit file path, head directory, or object.
 * Falls back to archtour:recommended if no rules file exists.
 */
export function loadRules(rulesInput, opts = {}) {
  const warnings = [];

  if (typeof rulesInput === "object" && rulesInput !== null) {
    validateRulesConfig(rulesInput);
    const rulesMap = new Map();
    if (rulesInput.extends) {
      const extendsList = Array.isArray(rulesInput.extends) ? rulesInput.extends : [rulesInput.extends];
      for (const item of extendsList) {
        const trimmed = item.trim();
        if (trimmed === "archtour:recommended") {
          for (const rule of RECOMMENDED_RULES) {
            rulesMap.set(rule.id, { ...rule });
          }
        } else if (trimmed.startsWith("archtour:")) {
          throw new Error(`Invalid rules configuration: Unknown built-in pack "${trimmed}" in "extends"`);
        } else {
          const basePath = opts.basePath || process.cwd();
          const extPath = path.resolve(basePath, trimmed);
          const extResult = loadRulesFile(extPath, new Set(), warnings);
          for (const r of extResult.rules) {
            mergeRuleIntoMap(rulesMap, r, trimmed, warnings);
          }
        }
      }
    }
    if (rulesInput.rules && Array.isArray(rulesInput.rules)) {
      for (const r of rulesInput.rules) {
        mergeRuleIntoMap(rulesMap, r, "inline", warnings);
      }
    }
    return {
      rules: Array.from(rulesMap.values()),
      warnings,
      config: rulesInput
    };
  }

  let targetPath = rulesInput;
  if (!targetPath) {
    const headDir = opts.policyDir || opts.headDir || ".";
    const defaultYml = path.join(headDir, ".archtour", "rules.yml");
    const defaultYaml = path.join(headDir, ".archtour", "rules.yaml");
    if (fs.existsSync(defaultYml)) {
      targetPath = defaultYml;
    } else if (fs.existsSync(defaultYaml)) {
      targetPath = defaultYaml;
    } else {
      // Default to archtour:recommended
      return {
        rules: RECOMMENDED_RULES.map(r => ({ ...r })),
        warnings: [],
        config: {
          version: 1,
          extends: ["archtour:recommended"],
          rules: []
        }
      };
    }
  }

  return loadRulesFile(targetPath, new Set(), warnings);
}

/**
 * Generates diff events from current facts as if everything were added.
 */
export function extractStateEvents(facts = {}) {
  const events = [];
  const entities = facts.entities || [];
  const relations = facts.relations || [];

  if (Array.isArray(facts.parseErrors)) {
    for (const pe of facts.parseErrors) {
      events.push({
        type: "parse.error_head",
        entityId: `file:${pe.file}`,
        kind: "file",
        after: pe.error,
        source: { file: pe.file, line: pe.line || 1 },
        message: `Failed to parse '${pe.file}': ${pe.error}`
      });
    }
  }

  for (const ent of entities) {
    if (ent.kind === "api.route") {
      events.push({
        type: "api.route_added",
        entityId: ent.id,
        kind: ent.kind,
        after: ent.name,
        source: ent.source,
        message: `API route '${ent.name}' was added`
      });
    } else {
      events.push({
        type: "entity.added",
        entityId: ent.id,
        kind: ent.kind,
        after: ent.name,
        source: ent.source,
        message: `${ent.kind} '${ent.name}' was added`
      });
    }

    if (ent.kind === "service") {
      const attrs = ent.attrs || {};
      if (attrs.privileged) {
        events.push({
          type: "service.privileged_enabled",
          entityId: ent.id,
          kind: "service",
          before: false,
          after: true,
          source: ent.source,
          message: `Service '${ent.name}' enabled privileged mode`
        });
      }
      if (attrs.networkModeHost) {
        events.push({
          type: "service.host_network_enabled",
          entityId: ent.id,
          kind: "service",
          before: false,
          after: true,
          source: ent.source,
          message: `Service '${ent.name}' enabled host network mode`
        });
      }
      if (attrs.dockerSocket) {
        events.push({
          type: "service.docker_socket_mounted",
          entityId: ent.id,
          kind: "service",
          before: false,
          after: true,
          source: ent.source,
          message: `Service '${ent.name}' mounted docker socket`
        });
      }
      if (Array.isArray(attrs.hostMounts)) {
        for (const m of attrs.hostMounts) {
          events.push({
            type: "service.host_mount_added",
            entityId: ent.id,
            kind: "service",
            after: m,
            source: ent.source,
            message: `Service '${ent.name}' added host mount '${m}'`
          });
        }
      }
      if (Array.isArray(attrs.ports)) {
        for (const p of attrs.ports) {
          if (p && p.published && p.bindAll) {
            events.push({
              type: "service.port_published",
              entityId: ent.id,
              kind: "service",
              after: p,
              source: ent.source,
              message: `Service '${ent.name}' published port ${p.host}:${p.container}/${p.protocol}${p.bindAll ? " (all interfaces)" : ""}`
            });
          }
        }
      }
      if (attrs.registry && attrs.registry !== "docker.io") {
        events.push({
          type: "service.registry_changed",
          entityId: ent.id,
          kind: "service",
          before: null,
          after: attrs.registry,
          source: ent.source,
          message: `Service '${ent.name}' registry changed from 'null' to '${attrs.registry}'`
        });
      }
    }
  }

  for (const r of relations) {
    if (r.kind === "service.depends_on") {
      const serviceId = `service:${r.from}`;
      const ent = entities.find(e => e.id === serviceId);
      events.push({
        type: "service.dependency_added",
        entityId: serviceId,
        kind: "service",
        after: r.to,
        source: ent?.source,
        message: `Service '${r.from}' added dependency on '${r.to}'`
      });
    }
  }

  return events;
}

/**
 * Loads and validates .archtour/exceptions.yml.
 * Throws an Error with exitCode = 3 on invalid entries.
 */
export function loadExceptionsFile(filePath, opts = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return { exceptions: [] };
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  const lineCounter = new YAML.LineCounter();
  let doc;
  try {
    doc = YAML.parseDocument(content, { lineCounter });
  } catch (err) {
    const line = err.linePos?.[0]?.line || 1;
    const error = new Error(`Invalid exceptions configuration in "${filePath}" at line ${line}: ${err.message}`);
    error.exitCode = 3;
    throw error;
  }

  if (doc.errors && doc.errors.length > 0) {
    const err = doc.errors[0];
    const line = err.linePos?.[0]?.line || 1;
    const error = new Error(`Invalid exceptions configuration in "${filePath}" at line ${line}: ${err.message}`);
    error.exitCode = 3;
    throw error;
  }

  const rawJson = doc.toJSON();
  let entries = [];
  let seqNode = null;

  if (Array.isArray(rawJson)) {
    entries = rawJson;
    seqNode = doc.contents;
  } else if (rawJson && typeof rawJson === "object" && Array.isArray(rawJson.exceptions)) {
    entries = rawJson.exceptions;
    seqNode = doc.contents?.get ? doc.contents.get("exceptions", true) : null;
  } else if (rawJson == null) {
    return { exceptions: [] };
  } else {
    const error = new Error(`Invalid exceptions configuration in "${filePath}" at line 1: exceptions must be an array`);
    error.exitCode = 3;
    throw error;
  }

  const now = opts.now ? new Date(opts.now) : new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const exceptions = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const item = entries[idx];
    const itemNode = seqNode?.items ? seqNode.items[idx] : null;
    const line = (itemNode && itemNode.range) ? lineCounter.linePos(itemNode.range[0]).line : (idx + 1);

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: entry must be an object`);
      error.exitCode = 3;
      throw error;
    }

    if (typeof item.rule !== "string" || !item.rule.trim()) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: missing or empty required field "rule"`);
      error.exitCode = 3;
      throw error;
    }

    if (typeof item.target !== "string" || !item.target.trim()) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: missing or empty required field "target"`);
      error.exitCode = 3;
      throw error;
    }

    const ruleStr = item.rule.trim();
    const targetStr = item.target.trim();

    // N7: An exception whose rule is * (or glob matching > 1 rule) or whose target is * is rejected (exit 3)
    // unless it names exactly one rule and the rule is not hard. Hard rules can only be excepted per target (no * target).
    const allRules = (Array.isArray(opts.rules) && opts.rules.length > 0) ? opts.rules : RECOMMENDED_RULES;
    const isRuleGlob = ruleStr.includes("*") || ruleStr.includes("?");
    const matchingRules = allRules.filter(r => r.id === ruleStr || (isRuleGlob && matchGlob(r.id, ruleStr)));

    if (ruleStr === "*" || (isRuleGlob && matchingRules.length > 1)) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: exception rule "${ruleStr}" cannot be "*" or match multiple rules`);
      error.exitCode = 3;
      throw error;
    }

    if (targetStr === "*") {
      const ruleObj = matchingRules.length === 1 ? matchingRules[0] : allRules.find(r => r.id === ruleStr);
      if (!ruleObj || ruleObj.level === "hard") {
        const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: hard rule "${ruleObj ? ruleObj.id : ruleStr}" cannot have wildcard target "*"`);
        error.exitCode = 3;
        throw error;
      }
    }

    if (typeof item.reason !== "string" || !item.reason.trim()) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: missing or empty required field "reason"`);
      error.exitCode = 3;
      throw error;
    }

    if (typeof item.owner !== "string" || !item.owner.trim()) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: missing or empty required field "owner"`);
      error.exitCode = 3;
      throw error;
    }

    if (typeof item.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.expires) || isNaN(Date.parse(item.expires))) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: "expires" is required and must be YYYY-MM-DD`);
      error.exitCode = 3;
      throw error;
    }

    // Check max 365 days ahead
    const expiresDate = new Date(`${item.expires}T23:59:59.999Z`);
    const diffMs = expiresDate.getTime() - now.getTime();
    const maxMs = 365 * 24 * 60 * 60 * 1000;
    if (diffMs > maxMs) {
      const error = new Error(`Invalid exception entry in "${filePath}" at line ${line}: "expires" (${item.expires}) exceeds maximum 365 days ahead`);
      error.exitCode = 3;
      throw error;
    }

    const isExpired = item.expires < todayStr;

    exceptions.push({
      rule: item.rule.trim(),
      target: item.target.trim(),
      reason: item.reason.trim(),
      owner: item.owner.trim(),
      expires: item.expires.trim(),
      line,
      file: filePath,
      expired: isExpired
    });
  }

  return { exceptions };
}

/**
 * Applies exceptions to findings:
 * - Unexpired exception turns a matching finding into excepted.
 * - Expired exception adds an exception-expired finding (level warn).
 */
export function applyExceptions(findings = [], exceptions = []) {
  for (const ex of exceptions) {
    if (ex.expired) {
      findings.push({
        ruleId: "exception-expired",
        level: "warn",
        message: `Exception for rule '${ex.rule}' and target '${ex.target}' expired on ${ex.expires}`,
        detail: `Exception for rule '${ex.rule}' and target '${ex.target}' expired on ${ex.expires}`,
        owners: [ex.owner],
        docs: null,
        source: { file: ex.file, line: ex.line }
      });
    } else {
      for (const f of findings) {
        if (f.excepted) continue;
        const ruleMatch = ex.rule === "*" || ex.rule === f.ruleId || (Array.isArray(f.alsoMatched) && f.alsoMatched.includes(ex.rule));
        if (!ruleMatch) continue;

        const entityId = f.event?.entityId || "";
        const entityName = (typeof f.event?.after === "string" ? f.event.after : typeof f.event?.before === "string" ? f.event.before : "") || entityId.replace(/^[^:]+:/, "");

        const targetMatch = ex.target === "*" || matchGlob(entityId, ex.target) || matchGlob(entityName, ex.target);
        if (targetMatch) {
          f.excepted = true;
          f.exception = ex;
        }
      }
    }
  }
}

/**
 * Checks whether overrideBy matches any owner in owners list (or team).
 * When owners is empty, accepts users with write access (write, maintain, admin) other than the PR author:
 * without named owners, the second pair of eyes is the point of the override.
 */
export function isOwnerMatch(owners = [], overrideBy = "", ownerTeams = [], overridePermission = "", prAuthor = "") {
  if (!overrideBy) return false;
  const user = String(overrideBy).trim().toLowerCase().replace(/^@/, "");
  const author = String(prAuthor || "").trim().toLowerCase().replace(/^@/, "");

  // With --pr-author set, the PR author can never override, even when listed as an owner
  if (author && author === user) return false;

  const userTeams = (Array.isArray(ownerTeams) ? ownerTeams : String(ownerTeams || "").split(","))
    .map(t => String(t).trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

  const ownerList = Array.isArray(owners) ? owners : (owners ? [owners] : []);

  if (ownerList.length === 0) {
    if (overridePermission) {
      const perm = String(overridePermission).trim().toLowerCase();
      return ["write", "maintain", "admin"].includes(perm);
    }
    return false;
  }

  for (const rawOwner of ownerList) {
    const owner = String(rawOwner).trim().toLowerCase().replace(/^@/, "");
    if (owner.includes("/")) {
      if (userTeams.includes(owner)) return true;
    } else {
      if (owner === user) return true;
    }
  }
  return false;
}

/**
 * Applies overrides to soft findings.
 */
export function applyOverrides(findings = [], rules = [], opts = {}) {
  const auditOverrides = [];
  if (!opts.override) return { auditOverrides };

  const rawOverride = Array.isArray(opts.override) ? opts.override.join(",") : String(opts.override || "");
  const targetRuleIds = rawOverride.split(",").map(s => s.trim()).filter(Boolean);
  if (targetRuleIds.length === 0) return { auditOverrides };

  const overrideSha = opts.overrideSha ? String(opts.overrideSha).trim().toLowerCase() : "";
  const headSha = opts.headSha ? String(opts.headSha).trim().toLowerCase() : "";

  if (overrideSha) {
    if (!/^[0-9a-fA-F]{12,}$/.test(overrideSha)) {
      console.error(`archtour: override refused: sha "${opts.overrideSha}" must be the full head commit SHA`);
      return { auditOverrides };
    }
    if (headSha && overrideSha !== headSha) {
      console.error(`archtour: override refused: sha "${opts.overrideSha}" does not match head commit "${opts.headSha}"`);
      return { auditOverrides };
    }
  }

  const overrideBy = opts.overrideBy || "";
  const overrideReason = opts.overrideReason || "";
  const ownerTeams = opts.ownerTeams || [];
  const overridePermission = opts.overridePermission || "";
  const prAuthor = opts.prAuthor || "";

  for (const ruleId of targetRuleIds) {
    const rule = rules.find(r => r.id === ruleId);
    const ruleFindings = findings.filter(f => (f.ruleId === ruleId || (Array.isArray(f.alsoMatched) && f.alsoMatched.includes(ruleId))) && !f.excepted);

    // Hard rules can never be overridden
    if (rule?.level === "hard" || ruleFindings.some(f => f.level === "hard")) {
      console.error(`archtour: hard rule "${ruleId}" can never be overridden`);
      continue;
    }

    // Check soft level
    const softFindings = ruleFindings.filter(f => f.level === "soft");
    if (softFindings.length === 0) {
      continue;
    }

    // Check owner match
    const owners = rule?.owners || softFindings[0]?.owners || [];
    if (!isOwnerMatch(owners, overrideBy, ownerTeams, overridePermission, prAuthor)) {
      console.error(`archtour: override of rule "${ruleId}" refused: "${overrideBy}" is not an owner of this rule`);
      continue;
    }

    if (!overrideReason) {
      console.error(`archtour: override of rule "${ruleId}" refused: missing --override-reason`);
      continue;
    }

    // Apply override
    for (const f of softFindings) {
      f.overridden = true;
      f.overriddenBy = overrideBy;
      f.overrideReason = overrideReason;

      auditOverrides.push({
        ruleId,
        entityId: f.event?.entityId,
        sha: overrideSha || undefined,
        overriddenBy: overrideBy,
        reason: overrideReason,
        timestamp: (opts.now ? new Date(opts.now) : new Date()).toISOString()
      });
    }
  }

  return { auditOverrides };
}

/**
 * Evaluates rules against diff events.
 */
export function evaluateRules(rules = [], diffResult = {}, baseFacts = {}, headFacts = {}, opts = {}) {
  const findings = [];
  const events = diffResult.events || [];
  const headEntities = new Map((headFacts.entities || []).map(e => [e.id, e]));
  const baseEntities = new Map((baseFacts.entities || []).map(e => [e.id, e]));

  const now = opts.now ? new Date(opts.now) : new Date();
  const todayStr = now.toISOString().slice(0, 10);

  for (const ev of events) {
    const headEnt = headEntities.get(ev.entityId);
    const baseEnt = baseEntities.get(ev.entityId);
    const entity = headEnt || baseEnt;

    for (const rule of rules) {
      if (rule.level === "off") continue;

      const onList = Array.isArray(rule.on) ? rule.on : [rule.on];
      if (!onList.includes(ev.type)) continue;

      if (rule.where && typeof rule.where === "object") {
        let matched = true;
        for (const [key, pattern] of Object.entries(rule.where)) {
          let val = undefined;
          if (key === "name") {
            val = entity?.name ?? (typeof ev.after === "string" ? ev.after : typeof ev.before === "string" ? ev.before : (ev.entityId ? ev.entityId.replace(/^[^:]+:/, "") : undefined));
          } else if (key === "file" || key === "source") {
            val = ev.source?.file || entity?.source?.file;
          } else if (key === "kind") {
            val = ev.kind || entity?.kind;
          } else if (key === "environment") {
            // Support environment attribute on services (e.g. "dev", "!dev")
            val = entity?.attrs?.environment;
          } else if (entity?.attrs && key in entity.attrs) {
            val = entity.attrs[key];
          } else if (ev && key in ev) {
            val = ev[key];
          } else if (ev.after && typeof ev.after === "object" && key in ev.after) {
            val = ev.after[key];
          }

          const patterns = Array.isArray(pattern) ? pattern : [pattern];
          const patternMatched = patterns.some(p => {
            // Support negation patterns like "!dev" - matches when value is NOT dev
            if (typeof p === "string" && p.startsWith("!")) {
              const negatedPattern = p.slice(1);
              // Match if value is undefined OR doesn't match the negated pattern
              return val === undefined || !matchGlob(val, negatedPattern);
            }
            // Regular pattern: value must match (undefined doesn't match)
            return val !== undefined && matchGlob(val, p);
          });
          if (!patternMatched) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
      }

      let level = rule.level;
      const eventDetail = ev.message || ev.description || null;
      let msg = rule.message
        ? (eventDetail && rule.message !== eventDetail ? `${rule.message} - ${eventDetail}` : rule.message)
        : (eventDetail || "");

      if (rule.enforce_from && (level === "soft" || level === "hard")) {
        if (todayStr < rule.enforce_from) {
          const originalLevel = level;
          level = "warn";
          msg = `${msg} (becomes ${originalLevel} on ${rule.enforce_from})`;
        }
      }

      const src = ev.source || entity?.source || null;
      findings.push({
        ruleId: rule.id,
        level,
        event: ev,
        message: msg,
        detail: eventDetail,
        owners: Array.isArray(rule.owners) ? [...rule.owners] : (rule.owners ? [rule.owners] : []),
        docs: rule.docs || null,
        source: src ? { file: src.file, line: src.line } : null
      });
    }
  }

  // Handle candidate architecture files skipped in head (e.g. Helm templates or file size cap)
  const normPath = p => (p || "").replace(/\\/g, "/");
  const skippedList = [];
  if (Array.isArray(headFacts?.skipped)) {
    for (const s of headFacts.skipped) {
      if (s) skippedList.push({ file: s.path || s.file, reason: s.reason || s.message, helmChart: s.helmChart === true, folderSkip: s.folderSkip === true });
    }
  }
  if (Array.isArray(headFacts?.errors)) {
    for (const e of headFacts.errors) {
      if (e?.skipped) {
        skippedList.push({ file: e.file || e.path, reason: e.reason || e.message, helmChart: e.helmChart === true });
      }
    }
  }

  const uniqueSkipped = new Map();
  for (const s of skippedList) {
    if (!s.file) continue;
    const n = normPath(s.file);
    if (!uniqueSkipped.has(n)) {
      uniqueSkipped.set(n, s);
    }
  }

  // Skipped in base with the same fingerprint = unchanged, still not checked: nothing new to tell this PR
  const baseSkippedFingerprints = new Map();
  for (const s of Array.isArray(baseFacts?.skipped) ? baseFacts.skipped : []) {
    if (s && s.fingerprint) baseSkippedFingerprints.set(normPath(s.path || s.file), s.fingerprint);
  }
  for (const s of Array.isArray(headFacts?.skipped) ? headFacts.skipped : []) {
    const n = normPath(s?.path || s?.file);
    if (s?.fingerprint && baseSkippedFingerprints.get(n) === s.fingerprint) uniqueSkipped.delete(n);
  }

  if (uniqueSkipped.size > 0) {
    const fileNotCheckedRule = rules.find(r => r.id === "file-not-checked");
    const changedFileNotCheckedRule = rules.find(r => r.id === "changed-file-not-checked");
    const parseErrorHeadRule = rules.find(r => r.id === "parse-error-head");
    const baseSources = baseFacts?.sources || [];
    const baseEntitiesList = baseFacts?.entities || [];

    const skippedParsedInBaseFiles = new Set();

    for (const [normF, s] of uniqueSkipped) {
      // 2. Check if file was parsed (had entities) in base
      const wasParsedInBase = baseSources.some(src => normPath(src.path) === normF && (src.entityCount > 0 || src.entityCount == null)) ||
        baseEntitiesList.some(ent => normPath(ent.source?.file) === normF);

      // 1. Which rule reports the skip:
      //    - a changed file in a folder skipped by default: advisory file-not-checked (a notice, never blocking);
      //    - a new or edited file the check could not read (Helm template, size cap), when there is a base to compare
      //      with: changed-file-not-checked, soft by default and lowerable only in the base-branch policy. Every trick
      //      that made a manifest look like a template (a Chart.yaml above it, a token in a value) lands here, so "could
      //      not read it" is never reported as "nothing found";
      //    - a file that parsed in base (also gets parse-error-head below), or a state scan with no base: file-not-checked.
      const hasBase = Array.isArray(baseFacts?.sources);
      const useChangedRule = hasBase && !s.folderSkip && !wasParsedInBase;
      const reportRule = useChangedRule ? changedFileNotCheckedRule : fileNotCheckedRule;
      const reportId = useChangedRule ? "changed-file-not-checked" : "file-not-checked";
      const findingLevel = s.folderSkip ? "advisory" : (reportRule ? reportRule.level : (useChangedRule ? "soft" : "advisory"));
      if (findingLevel !== "off" && !(s.folderSkip && fileNotCheckedRule && fileNotCheckedRule.level === "off")) {
        findings.push({
          ruleId: reportRule ? reportRule.id : reportId,
          level: findingLevel,
          event: {
            type: "file.not_checked",
            entityId: `file:${s.file}`,
            kind: "file",
            source: { file: s.file, line: 1 },
            after: s.reason,
            reason: s.reason,
            message: `Candidate architecture file '${s.file}' was not checked: ${s.reason}`
          },
          message: `Candidate architecture file '${s.file}' was not checked: ${s.reason}`,
          detail: s.reason,
          owners: reportRule?.owners || [],
          docs: reportRule?.docs || "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#file-not-checked",
          source: { file: s.file, line: 1 }
        });
      }

      if (wasParsedInBase) {
        skippedParsedInBaseFiles.add(normF);
        if (!parseErrorHeadRule || parseErrorHeadRule.level !== "off") {
          findings.push({
            ruleId: parseErrorHeadRule ? parseErrorHeadRule.id : "parse-error-head",
            level: parseErrorHeadRule ? parseErrorHeadRule.level : "soft",
            event: {
              type: "parse.error_head",
              entityId: `file:${s.file}`,
              kind: "file",
              source: { file: s.file, line: 1 },
              after: s.reason,
              error: s.reason,
              message: `File '${s.file}' parsed in base but failed to parse in head: ${s.reason}`
            },
            message: `File '${s.file}' parsed in base but failed to parse in head: ${s.reason}`,
            detail: s.reason,
            owners: parseErrorHeadRule?.owners || [],
            docs: parseErrorHeadRule?.docs || "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#parse-errors",
            source: { file: s.file, line: 1 }
          });
        }
      }
    }

    // Suppress removal findings for entities originating from skipped files that parsed in base
    if (skippedParsedInBaseFiles.size > 0) {
      for (let i = findings.length - 1; i >= 0; i--) {
        const f = findings[i];
        if (f.ruleId === "file-not-checked" || f.ruleId === "parse-error-head") continue;
        const evType = f.event?.type || "";
        const fFile = normPath(f.source?.file || f.event?.source?.file);
        const entFile = normPath(baseEntities.get(f.event?.entityId)?.source?.file);
        const matchFile = fFile || entFile;
        if (matchFile && skippedParsedInBaseFiles.has(matchFile)) {
          if (evType.endsWith("_removed") || evType === "entity.removed" || evType.startsWith("sql.drop_") || evType.includes("removed") || evType.includes("deleted")) {
            findings.splice(i, 1);
          }
        }
      }
    }
  }

  // A candidate file whose BASE version was skipped for size or could not be parsed, while the head version parsed:
  // removals cannot be detected (review-6 N6: a 6 MB OpenAPI base cut to 2,000 routes passed with no finding). Emit a
  // soft file-not-checked naming the base reason instead of staying silent.
  {
    const fileNotCheckedRule = rules.find(r => r.id === "file-not-checked");
    if (!fileNotCheckedRule || fileNotCheckedRule.level !== "off") {
      const headParsed = new Set();
      for (const src of headFacts?.sources || []) {
        if (src?.path && (src.entityCount == null || src.entityCount > 0)) headParsed.add(normPath(src.path));
      }
      for (const ent of headFacts?.entities || []) {
        if (ent?.source?.file) headParsed.add(normPath(ent.source.file));
      }
      const baseChecked = new Set((baseFacts?.sources || []).map(src => normPath(src.path)));
      const baseProblems = new Map();
      for (const s of Array.isArray(baseFacts?.skipped) ? baseFacts.skipped : []) {
        if (s?.path) baseProblems.set(normPath(s.path), s.reason || "skipped");
      }
      for (const e of Array.isArray(baseFacts?.errors) ? baseFacts.errors : []) {
        if (e && !e.skipped && e.error && (e.file || e.path)) {
          baseProblems.set(normPath(e.file || e.path), e.error);
        }
      }
      const alreadyReported = new Set(
        findings.filter(f => f.ruleId === "file-not-checked").map(f => normPath(f.event?.source?.file))
      );
      for (const [file, reason] of baseProblems) {
        if (!headParsed.has(file) || baseChecked.has(file) || alreadyReported.has(file)) continue;
        const message = `The base version of '${file}' was not checked (${reason}), so removals cannot be detected.`;
        findings.push({
          ruleId: fileNotCheckedRule ? fileNotCheckedRule.id : "file-not-checked",
          level: "soft",
          event: {
            type: "file.not_checked",
            entityId: `file:${file}`,
            kind: "file",
            source: { file, line: 1 },
            after: reason,
            reason,
            baseNotChecked: true,
            message
          },
          message,
          detail: reason,
          owners: fileNotCheckedRule?.owners || [],
          docs: fileNotCheckedRule?.docs || "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#file-not-checked",
          source: { file, line: 1 }
        });
      }
    }
  }

  // Deduplicate pairs of findings about the same entity and underlying change:
  // db.field_removed ~ sql.drop_column
  // db.field_type_changed ~ sql.type_narrowed
  // entity.removed of db.table ~ sql.drop_table
  // Keep the more specific one (the sql.* one) at the HIGHER of the two levels,
  // and list the other rule id under "also matched".
  const DEDUPE_PAIRS = [
    {
      generic: "db.field_removed",
      specific: "sql.drop_column",
      matchEntity: (g, s) => {
        const gId = (g.event?.entityId || "").toLowerCase();
        const sId = (s.event?.entityId || "").toLowerCase();
        if (gId && sId && gId === sId) return true;
        const gBefore = (g.event?.before || "").toLowerCase();
        const sBefore = (s.event?.before || "").toLowerCase();
        return Boolean(gBefore && sBefore && gBefore === sBefore);
      }
    },
    {
      generic: "db.field_type_changed",
      specific: "sql.type_narrowed",
      matchEntity: (g, s) => {
        const gId = (g.event?.entityId || "").toLowerCase();
        const sId = (s.event?.entityId || "").toLowerCase();
        if (gId && sId && gId === sId) return true;
        const gEntity = (g.event?.entityId || g.event?.before || "").toLowerCase();
        const sEntity = (s.event?.entityId || s.event?.before || "").toLowerCase();
        return Boolean(gEntity && sEntity && gEntity === sEntity);
      }
    },
    {
      generic: "entity.removed",
      specific: "sql.drop_table",
      matchEntity: (g, s) => {
        const isTable = g.event?.kind === "db.table" || g.event?.entityId?.startsWith("db.table:");
        if (!isTable) return false;
        const gId = (g.event?.entityId || "").toLowerCase();
        const sId = (s.event?.entityId || "").toLowerCase();
        if (gId && sId && gId === sId) return true;
        const gBefore = (g.event?.before || "").toLowerCase();
        const sBefore = (s.event?.before || "").toLowerCase();
        return Boolean(gBefore && sBefore && gBefore === sBefore);
      }
    }
  ];

  const droppedGeneric = new Set();

  for (const s of findings) {
    for (const pair of DEDUPE_PAIRS) {
      if (s.event?.type === pair.specific) {
        for (const g of findings) {
          if (droppedGeneric.has(g)) continue;
          if (g.event?.type === pair.generic && pair.matchEntity(g, s)) {
            droppedGeneric.add(g);
            const gSev = LEVEL_SEVERITY[g.level] ?? 0;
            const sSev = LEVEL_SEVERITY[s.level] ?? 0;
            if (gSev > sSev) {
              s.level = g.level;
            }
            if (!s.alsoMatched) {
              s.alsoMatched = [];
            }
            if (!s.alsoMatched.includes(g.ruleId)) {
              s.alsoMatched.push(g.ruleId);
            }
            if (Array.isArray(g.alsoMatched)) {
              for (const am of g.alsoMatched) {
                if (!s.alsoMatched.includes(am)) s.alsoMatched.push(am);
              }
            }
            if (Array.isArray(g.owners) && g.owners.length > 0) {
              const currentOwners = Array.isArray(s.owners) ? s.owners : [];
              s.owners = [...new Set([...currentOwners, ...g.owners])];
            }
            if (!s.docs && g.docs) {
              s.docs = g.docs;
            }
            mergeSources(s, g);
          }
        }
      }
    }
  }

  const finalFindings = findings.filter(f => !droppedGeneric.has(f));

  // Same rule + same logical target in one check (a Prisma schema and its migration, one service in two files):
  // collapse into one finding at the highest level that lists every source file. Findings without a target are kept as is.
  const byTarget = new Map();
  const result = [];
  for (const f of finalFindings) {
    const target = findingTarget(f);
    if (!target) {
      result.push(f);
      continue;
    }
    // The changed value is part of the key: two different ports on one service stay two findings
    const key = `${f.ruleId}\u0000${target}\u0000${JSON.stringify(f.event?.after ?? null).toLowerCase()}`;
    const existing = byTarget.get(key);
    if (!existing) {
      byTarget.set(key, f);
      result.push(f);
      continue;
    }
    if ((LEVEL_SEVERITY[f.level] ?? 0) > (LEVEL_SEVERITY[existing.level] ?? 0)) existing.level = f.level;
    for (const am of f.alsoMatched || []) {
      existing.alsoMatched = existing.alsoMatched || [];
      if (!existing.alsoMatched.includes(am)) existing.alsoMatched.push(am);
    }
    if (Array.isArray(f.owners) && f.owners.length > 0) {
      existing.owners = [...new Set([...(existing.owners || []), ...f.owners])];
    }
    mergeSources(existing, f);
  }

  return { findings: result };
}

// Logical target of a finding: the entity without its kind prefix, case-insensitive
// ("db.field:User.name" and "db.column:user.name" are both "user.name").
function findingTarget(f) {
  const raw = f.event?.entityId || (typeof f.event?.before === "string" ? f.event.before : "");
  if (!raw) return "";
  const colon = raw.indexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

// Adds b's source files to a.sources (a.source stays the primary location).
function mergeSources(a, b) {
  const norm = (file) => String(file || "").replace(/\\/g, "/");
  if (!a.sources) a.sources = a.source?.file ? [{ file: a.source.file, line: a.source.line }] : [];
  const seen = new Set(a.sources.map(x => norm(x.file)));
  const incoming = b.sources || (b.source?.file ? [b.source] : []);
  for (const s of incoming) {
    if (s?.file && !seen.has(norm(s.file))) {
      seen.add(norm(s.file));
      a.sources.push({ file: s.file, line: s.line });
    }
  }
}

/**
 * Calculates exit code from findings:
 * 0 = no active findings at soft/hard
 * 2 = active soft findings only (overridable)
 * 1 = any active hard finding
 */
export function getExitCode(findings = []) {
  const active = findings.filter(f => !f.excepted && !f.overridden);
  if (active.some(f => f.level === "hard")) return 1;
  if (active.some(f => f.level === "soft")) return 2;
  return 0;
}

/**
 * Diffs policy configuration under .archtour/ between base and head directories.
 * Returns { loosening: [], allChanges: [] }.
 */
export function diffPolicy(baseDir, headDir, opts = {}) {
  const loosening = [];
  const allChanges = [];

  const baseArchtour = path.join(baseDir, ".archtour");
  const headArchtour = path.join(headDir, ".archtour");

  if (!fs.existsSync(baseArchtour)) {
    return { loosening, allChanges };
  }

  // 1. Rules diff
  let baseRules = [];
  let headRules = [];
  let baseConfig = null;
  let headConfig = null;

  const baseRulesFile = [
    path.join(baseArchtour, "rules.yml"),
    path.join(baseArchtour, "rules.yaml")
  ].find(f => fs.existsSync(f));

  const headRulesFile = [
    path.join(headArchtour, "rules.yml"),
    path.join(headArchtour, "rules.yaml")
  ].find(f => fs.existsSync(f));

  if (baseRulesFile) {
    try {
      const res = loadRules(null, { headDir: baseDir, basePath: baseDir, policyDir: baseDir });
      baseRules = res.rules;
      baseConfig = res.config;
    } catch {}
  } else {
    baseRules = (opts.baseRules && opts.baseRules.length > 0) ? opts.baseRules : RECOMMENDED_RULES.map(r => ({ ...r }));
    baseConfig = { version: 1, extends: ["archtour:recommended"], rules: [] };
  }

  if (headRulesFile) {
    try {
      const res = loadRules(null, { headDir: headDir, basePath: headDir, policyDir: headDir });
      headRules = res.rules;
      headConfig = res.config;
    } catch (err) {
      const error = new Error(`Invalid rules configuration in "${headRulesFile}": ${err.message}`);
      error.exitCode = 3;
      throw error;
    }
  } else {
    headRules = (!baseRulesFile && opts.baseRules && opts.baseRules.length > 0)
      ? opts.baseRules.map(r => ({ ...r }))
      : RECOMMENDED_RULES.map(r => ({ ...r }));
    headConfig = { version: 1, extends: ["archtour:recommended"], rules: [] };
  }

  // Check top-level config extends change
  const normExtends = (cfg) => {
    if (!cfg || !cfg.extends) return [];
    return (Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends]).map(s => String(s).trim());
  };
  const bExt = normExtends(baseConfig);
  const hExt = normExtends(headConfig);
  if (baseConfig && headConfig && JSON.stringify(bExt) !== JSON.stringify(hExt)) {
    loosening.push({
      type: "extends-changed",
      ruleId: "policy:.archtour",
      description: `Config "extends" changed`,
      owners: []
    });
    allChanges.push(`Config "extends" changed`);
  }

  const baseRulesMap = new Map(baseRules.map(r => [r.id, r]));
  const headRulesMap = new Map(headRules.map(r => [r.id, r]));

  // Rules removed & changed
  for (const [id, baseRule] of baseRulesMap) {
    const headRule = headRulesMap.get(id);
    const baseOwners = Array.isArray(baseRule.owners) ? baseRule.owners : (baseRule.owners ? [baseRule.owners] : []);
    if (!headRule) {
      loosening.push({
        type: "rule-removed",
        ruleId: id,
        description: `Rule "${id}" removed`,
        owners: baseOwners
      });
      allChanges.push(`Rule "${id}" removed`);
    } else {
      const baseLevel = baseRule.level;
      const headLevel = headRule.level;
      const baseSev = LEVEL_SEVERITY[baseLevel] ?? 0;
      const headSev = LEVEL_SEVERITY[headLevel] ?? 0;

      const changedFields = [];

      let levelLoosened = false;
      let levelTightened = false;
      if (baseLevel !== headLevel) {
        if (headSev < baseSev) {
          levelLoosened = true;
          changedFields.push(`level loosened from ${baseLevel} to ${headLevel}`);
        } else {
          levelTightened = true;
          changedFields.push(`level tightened from ${baseLevel} to ${headLevel}`);
        }
      }

      // Check owners
      const normOwners = (o) => (Array.isArray(o) ? o : (o ? [o] : [])).map(s => String(s).trim().toLowerCase()).sort();
      if (JSON.stringify(normOwners(baseRule.owners)) !== JSON.stringify(normOwners(headRule.owners))) {
        changedFields.push("owners");
      }

      // Check where
      if (JSON.stringify(baseRule.where || null) !== JSON.stringify(headRule.where || null)) {
        if (!baseRule.where && headRule.where) {
          changedFields.push("where added");
        } else if (baseRule.where && !headRule.where) {
          changedFields.push("where removed");
        } else {
          changedFields.push("where changed");
        }
      }

      // Check enforce_from
      const bEnforce = baseRule.enforce_from || null;
      const hEnforce = headRule.enforce_from || null;
      if (bEnforce !== hEnforce) {
        if (!bEnforce && hEnforce) {
          changedFields.push(`enforce_from added (${hEnforce})`);
        } else if (bEnforce && hEnforce && hEnforce > bEnforce) {
          changedFields.push(`enforce_from moved later (${bEnforce} -> ${hEnforce})`);
        } else {
          changedFields.push("enforce_from");
        }
      }

      // Check on
      const normOn = (o) => (Array.isArray(o) ? o : (o ? [o] : [])).map(s => String(s).trim()).sort();
      if (JSON.stringify(normOn(baseRule.on)) !== JSON.stringify(normOn(headRule.on))) {
        changedFields.push("on");
      }

      // Check adjustable
      const bAdj = baseRule.adjustable !== undefined ? Boolean(baseRule.adjustable) : true;
      const hAdj = headRule.adjustable !== undefined ? Boolean(headRule.adjustable) : true;
      if (bAdj !== hAdj) {
        changedFields.push("adjustable");
      }

      // Check message
      if ((baseRule.message || "") !== (headRule.message || "")) {
        changedFields.push("message");
      }

      // Check docs
      if ((baseRule.docs || "") !== (headRule.docs || "")) {
        changedFields.push("docs");
      }

      // Check extends on rule (if any)
      if (JSON.stringify(baseRule.extends || null) !== JSON.stringify(headRule.extends || null)) {
        changedFields.push("extends");
      }

      if (changedFields.length > 0) {
        const isPureTightening = levelTightened && changedFields.length === 1;
        if (isPureTightening) {
          allChanges.push(`Rule "${id}" level tightened from ${baseLevel} to ${headLevel}`);
        } else {
          let desc = `Rule "${id}" changed: ${changedFields.join(", ")}`;
          if (levelLoosened && changedFields.length === 1) {
            desc = `Rule "${id}" level loosened from ${baseLevel} to ${headLevel}`;
          }
          loosening.push({
            type: "rule-changed",
            ruleId: id,
            description: desc,
            owners: baseOwners
          });
          allChanges.push(desc);
        }
      }
    }
  }

  // Rules added (tightening)
  for (const [id, headRule] of headRulesMap) {
    if (!baseRulesMap.has(id)) {
      allChanges.push(`Rule "${id}" added (${headRule.level})`);
    }
  }

  // 2. Exceptions diff
  const baseExcFile = [
    path.join(baseArchtour, "exceptions.yml"),
    path.join(baseArchtour, "exceptions.yaml")
  ].find(f => fs.existsSync(f));

  const headExcFile = [
    path.join(headArchtour, "exceptions.yml"),
    path.join(headArchtour, "exceptions.yaml")
  ].find(f => fs.existsSync(f));

  let baseExceptions = [];
  let headExceptions = [];

  if (baseExcFile) {
    try {
      baseExceptions = loadExceptionsFile(baseExcFile, opts).exceptions;
    } catch {}
  }

  if (headExcFile) {
    try {
      headExceptions = loadExceptionsFile(headExcFile, opts).exceptions;
    } catch (err) {
      throw err;
    }
  }

  const findRuleOwners = (ruleId) => {
    const r = baseRulesMap.get(ruleId) || headRulesMap.get(ruleId);
    if (!r) return [];
    return Array.isArray(r.owners) ? r.owners : (r.owners ? [r.owners] : []);
  };

  for (const hEx of headExceptions) {
    const bEx = baseExceptions.find(b => b.rule === hEx.rule && b.target === hEx.target);
    const ruleOwners = findRuleOwners(hEx.rule);
    const owners = ruleOwners.length > 0 ? ruleOwners : (hEx.owner ? [hEx.owner] : []);
    if (!bEx) {
      loosening.push({
        type: "exception-added",
        ruleId: hEx.rule,
        description: `Exception added for rule "${hEx.rule}" (target: "${hEx.target}", expires: ${hEx.expires})`,
        owners
      });
      allChanges.push(`Exception added for rule "${hEx.rule}" (target: "${hEx.target}", expires: ${hEx.expires})`);
    } else {
      if (hEx.expires > bEx.expires) {
        loosening.push({
          type: "exception-extended",
          ruleId: hEx.rule,
          description: `Exception extended for rule "${hEx.rule}" (target: "${hEx.target}", ${bEx.expires} -> ${hEx.expires})`,
          owners
        });
        allChanges.push(`Exception extended for rule "${hEx.rule}" (target: "${hEx.target}", ${bEx.expires} -> ${hEx.expires})`);
      } else if (hEx.expires < bEx.expires) {
        allChanges.push(`Exception expiry shortened for rule "${hEx.rule}" (target: "${hEx.target}", ${bEx.expires} -> ${hEx.expires})`);
      }
    }
  }

  for (const bEx of baseExceptions) {
    const hEx = headExceptions.find(h => h.rule === bEx.rule && h.target === bEx.target);
    if (!hEx) {
      allChanges.push(`Exception removed for rule "${bEx.rule}" (target: "${bEx.target}")`);
    }
  }

  // 3. Baseline diff
  const baseBlFile = path.join(baseArchtour, "baseline.json");
  const headBlFile = path.join(headArchtour, "baseline.json");

  let baseCounts = {};
  let headCounts = {};

  if (fs.existsSync(baseBlFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(baseBlFile, "utf8"));
      baseCounts = (data && typeof data === "object" && data.rules && typeof data.rules === "object") ? data.rules : (data || {});
    } catch {}
  }

  if (fs.existsSync(headBlFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(headBlFile, "utf8"));
      headCounts = (data && typeof data === "object" && data.rules && typeof data.rules === "object") ? data.rules : (data || {});
    } catch {}
  }

  const allBaselineKeys = new Set([...Object.keys(baseCounts), ...Object.keys(headCounts)]);
  for (const ruleId of allBaselineKeys) {
    const bCount = baseCounts[ruleId] || 0;
    const hCount = headCounts[ruleId] || 0;
    const ruleOwners = findRuleOwners(ruleId);
    if (hCount > bCount) {
      loosening.push({
        type: "baseline-raised",
        ruleId,
        description: `Baseline count raised for "${ruleId}" (${bCount} -> ${hCount})`,
        owners: ruleOwners
      });
      allChanges.push(`Baseline count raised for "${ruleId}" (${bCount} -> ${hCount})`);
    } else if (hCount < bCount) {
      allChanges.push(`Baseline count lowered for "${ruleId}" (${bCount} -> ${hCount})`);
    }
  }

  return { loosening, allChanges };
}

/**
 * Formats findings as a Markdown report with escaping and neutralised @mentions.
 */
function codeSpan(val) {
  let str = val == null ? "" : String(val);
  str = str.replace(/[\r\n\t]+/g, " ");
  // Code spans show text literally (no entities), so neutralise with a zero-width space instead: "<script" is never a tag and
  // "@team" never pings, in any renderer, while reading the same.
  str = str.replace(/</g, "<\u200B").replace(/@/g, "@\u200B");
  const matches = str.match(/`+/g);
  let maxRun = 0;
  if (matches) {
    for (const m of matches) {
      if (m.length > maxRun) maxRun = m.length;
    }
  }
  const fenceLen = Math.max(1, maxRun + 1);
  const fence = "`".repeat(fenceLen);
  const needsSpace = str.startsWith("`") || str.endsWith("`");
  return needsSpace ? `${fence} ${str} ${fence}` : `${fence}${str}${fence}`;
}

// "file:line", plus the other files that describe the same change (merged duplicates)
function formatFindingLocation(f) {
  const loc = (x) => (x.line ? `${x.file}:${x.line}` : x.file);
  if (!f.source?.file) return "unknown";
  const others = (f.sources || []).filter(x => x?.file && x.file !== f.source.file);
  return others.length ? `${loc(f.source)} (also ${others.map(loc).join(", ")})` : loc(f.source);
}

// Formats all findings as plain lines for the job log:
// <level> <ruleId> <entity> <file:line> <message>
export function formatJobLogLines(findings) {
  const lines = [];
  for (const f of findings) {
    if (f.excepted || f.overridden) continue;
    const level = f.level || "unknown";
    const ruleId = f.ruleId || "unknown";
    const entity = f.entityId || f.event?.entityId || (f.event?.kind || "entity");
    const fileLine = formatFindingLocation(f);
    const message = (f.message || "").trim();
    // One finding per line: a CR/LF in a file name or message would start a new log line, and a line starting with
    // "::" is a GitHub Actions workflow command.
    lines.push(`${level} ${ruleId} ${entity} ${fileLine} ${message}`.replace(/[\r\n]+/g, " "));
  }
  return lines;
}

export function formatMarkdownReport(findingsArg = [], optsArg = {}) {
  const findings = Array.isArray(findingsArg) ? findingsArg : (findingsArg?.findings || []);
  const opts = Array.isArray(findingsArg) ? (optsArg || {}) : (findingsArg || {});
  const activeFindings = findings.filter(f => !f.excepted && !f.overridden);
  const hardFindings = activeFindings.filter(f => f.level === "hard");
  const softFindings = activeFindings.filter(f => f.level === "soft");
  const warnFindings = activeFindings.filter(f => f.level === "warn");
  const advisoryFindings = activeFindings.filter(f => f.level === "advisory");

  const overriddenFindings = findings.filter(f => f.overridden);
  const exceptedFindings = findings.filter(f => f.excepted);

  const blockingCount = hardFindings.length + softFindings.length;
  const overriddenCount = overriddenFindings.length;
  const exceptedCount = exceptedFindings.length;
  const warningsCount = warnFindings.length;
  const advisoryCount = advisoryFindings.length;

  const countStr = `(${blockingCount} blocking, ${overriddenCount} overridden, ${exceptedCount} excepted, ${warningsCount} warnings, ${advisoryCount} advisory)`;

  let headerVerdict = "";
  if (hardFindings.length > 0) {
    headerVerdict = `## ⛔ Architecture Guardrails: Failed ${countStr}`;
  } else if (softFindings.length > 0) {
    headerVerdict = `## ⚠️ Architecture Guardrails: Blocked (soft) ${countStr}`;
  } else if (opts.truncated || findings.some(f => f.ruleId === "scan-truncated")) {
    headerVerdict = `## ⚠️ Architecture Guardrails: Blocked (soft) ${countStr}`;
  } else if (opts.noCandidateFiles || (opts.candidateFilesExamined !== undefined && opts.candidateFilesExamined === 0)) {
    headerVerdict = `## ℹ️ Architecture Guardrails: No architecture files changed`;
  } else {
    headerVerdict = `## ✅ Architecture Guardrails: Passed ${countStr}`;
  }

  const sections = [headerVerdict];

  if (opts.celebrations && opts.celebrations.length > 0) {
    sections.push("\n" + opts.celebrations.join("\n"));
  }

  const allPolicyChanges = opts.policyChanges || findings.find(f => f.ruleId === "policy-changed")?.changes || [];
  if (allPolicyChanges.length > 0) {
    const lines = ["\n### Policy changes in this PR (apply after merge)"];
    for (const c of allPolicyChanges) {
      lines.push(`- ${mdText(c)}`);
    }
    sections.push(lines.join("\n"));
  }

  if (findings.length === 0) {
    if (opts.noCandidateFiles || (opts.candidateFilesExamined !== undefined && opts.candidateFilesExamined === 0)) {
      sections.push("\nNo candidate architecture files were changed or examined.");
    } else {
      sections.push("\nNo architecture rule violations detected.");
    }
    return sections.join("\n") + "\n";
  }

  function formatGroup(title, list, capEnabled) {
    if (!list || list.length === 0) return "";
    const lines = [`\n### ${title} (${list.length})`];

    const totalsByRule = new Map();
    for (const f of list) {
      totalsByRule.set(f.ruleId, (totalsByRule.get(f.ruleId) || 0) + 1);
    }

    const seenByRule = new Map();

    for (const f of list) {
      const seen = (seenByRule.get(f.ruleId) || 0) + 1;
      seenByRule.set(f.ruleId, seen);

      if (seen <= 20 || !capEnabled) {
        const msg = mdText(f.message || "");
        const entityName = f.entityId || f.event?.entityId || (f.event?.kind || "entity");
        const fileStr = formatFindingLocation(f);
        const ownersStr = f.owners && f.owners.length > 0 ? f.owners.map(o => mdText(o)).join(", ") : "none";
        const docsStr = f.docs ? `[docs](${f.docs})` : "none";

        lines.push(`- **${msg}** (${codeSpan(f.ruleId)})`);
        lines.push(`  - Entity: ${codeSpan(entityName)}`);
        lines.push(`  - File: ${codeSpan(fileStr)}`);
        lines.push(`  - Owners: ${ownersStr}`);
        if (Array.isArray(f.alsoMatched) && f.alsoMatched.length > 0) {
          const alsoMatchedStr = f.alsoMatched.map(id => codeSpan(id)).join(", ");
          lines.push(`  - Also matched: ${alsoMatchedStr}`);
        }
        if (f.docs) {
          lines.push(`  - Docs: ${docsStr}`);
        }
      } else if (seen === 21 && capEnabled) {
        const total = totalsByRule.get(f.ruleId) || list.length;
        const remaining = total - 20;
        lines.push(`- ... and ${remaining} more \`${f.ruleId}\` findings (see the job log)`);
      }
    }
    return lines.join("\n");
  }

  const hardSection = formatGroup("⛔ Hard", hardFindings, false); // hard findings are never capped in the comment
  if (hardSection) sections.push(hardSection);

  const softSection = formatGroup("⚠️ Soft", softFindings, true);
  if (softSection) {
    const softRules = Array.from(new Set(softFindings.map(f => f.ruleId))).join(",");
    const sha = opts.headSha ? opts.headSha : "<sha>";
    sections.push(softSection + `\n\nTo override: \`/archtour override ${softRules} ${sha} <reason>\``);
  }

  const warnSection = formatGroup("⚠️ Warn", warnFindings, true);
  if (warnSection) sections.push(warnSection);

  const skipNotices = advisoryFindings.filter(f => f.ruleId === "file-not-checked");
  const advisoryRest = advisoryFindings.filter(f => f.ruleId !== "file-not-checked");

  const advisorySection = formatGroup("ℹ️ Advisory", advisoryRest, true);
  if (advisorySection) sections.push(advisorySection);

  if (skipNotices.length > 0) {
    const label = skipNotices.length === 1 ? "1 changed file not checked" : `${skipNotices.length} changed files not checked`;
    const pathParts = [];
    for (const s of skipNotices.slice(0, 50)) {
      pathParts.push(`- ${codeSpan(formatFindingLocation(s))}`);
    }
    if (skipNotices.length > 50) {
      pathParts.push(`- ... and ${skipNotices.length - 50} more (see the job log)`);
    }
    sections.push(`\n<details><summary>ℹ️ ${label} (folders skipped by default)</summary>\n\n${pathParts.join("\n")}\n\n</details>`);
  }

  if (overriddenFindings.length > 0) {
    const lines = [`\n### 🔓 Overridden (${overriddenFindings.length})`];
    for (const f of overriddenFindings) {
      const msg = mdText(f.message || "");
      const entityName = f.event?.entityId ? f.event.entityId : (f.event?.kind || "entity");
      const fileStr = formatFindingLocation(f);
      lines.push(`- **${msg}** (${codeSpan(f.ruleId)}) - overridden by ${mdText(f.overriddenBy)}: ${mdText(f.overrideReason)}`);
      lines.push(`  - Entity: ${codeSpan(entityName)}`);
      lines.push(`  - File: ${codeSpan(fileStr)}`);
      if (Array.isArray(f.alsoMatched) && f.alsoMatched.length > 0) {
        const alsoMatchedStr = f.alsoMatched.map(id => codeSpan(id)).join(", ");
        lines.push(`  - Also matched: ${alsoMatchedStr}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  if (exceptedFindings.length > 0) {
    const lines = [`\n### 🛡️ Excepted (${exceptedFindings.length})`];
    for (const f of exceptedFindings) {
      const msg = mdText(f.message || "");
      const entityName = f.event?.entityId ? f.event.entityId : (f.event?.kind || "entity");
      const ex = f.exception;
      const exDetails = ex ? ` (reason: ${mdText(ex.reason)}, owner: ${mdText(ex.owner)}, expires: ${ex.expires})` : "";
      lines.push(`- **${msg}** (${codeSpan(f.ruleId)})${exDetails}`);
      lines.push(`  - Entity: ${codeSpan(entityName)}`);
      if (Array.isArray(f.alsoMatched) && f.alsoMatched.length > 0) {
        const alsoMatchedStr = f.alsoMatched.map(id => codeSpan(id)).join(", ");
        lines.push(`  - Also matched: ${alsoMatchedStr}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  let report = sections.join("\n") + "\n";
  if (report.length > 60000) {
    const truncIdx = report.lastIndexOf("\n", 59500);
    const cutPos = truncIdx > 50000 ? truncIdx : 59500;
    report = report.slice(0, cutPos) + "\n\n... and additional findings omitted to stay under the 60,000 character limit (see the job log for full list)\n";
  }
  return report;
}
