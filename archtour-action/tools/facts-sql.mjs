// Archtour SQL Migrations Reader & Event Extractor (PostgreSQL + MySQL DDL)
// Dependency-free DDL statement reader and state replay engine.

import { readFileSync } from "node:fs";
import { getMigrationDirs } from "./settings.mjs";

/**
 * Splits SQL script content into statements, respecting:
 * - Single quotes ('...') with '' and \' escapes
 * - Double quotes ("...") with "" and \" escapes
 * - Backticks (`...`) with `` and \` escapes
 * - PostgreSQL dollar-quoted strings ($tag$...$tag$ or $$...$$)
 * - Line comments (-- ...)
 * - Block comments (/* ... * /)
 * Returns array of { text, line }
 */
export function splitSqlStatements(content = "") {
  const statements = [];
  const len = content.length;
  let i = 0;
  let line = 1;
  let stmtStartLine = 1;
  let buf = "";

  while (i < len) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === "\n") {
      line++;
    }

    // 1. Line comment (-- ...)
    if (ch === "-" && next === "-") {
      const eol = content.indexOf("\n", i + 2);
      if (eol === -1) {
        break;
      }
      i = eol; // \n will be processed on next iteration or increment line here
      line++;
      i++;
      continue;
    }

    // 2. Block comment (/* ... */)
    if (ch === "/" && next === "*") {
      let endComment = content.indexOf("*/", i + 2);
      if (endComment === -1) {
        break;
      }
      const commentChunk = content.slice(i, endComment + 2);
      const nlCount = (commentChunk.match(/\n/g) || []).length;
      line += nlCount;

      // A comment separates tokens: `DROP/**/TABLE orders;` must read as `DROP TABLE orders;`.
      if (buf.length > 0 && !/\s$/.test(buf)) buf += " ";
      i = endComment + 2;
      continue;
    }

    // 3. Dollar quoting ($tag$...$tag$ or $$...$$)
    if (ch === "$") {
      const tagMatch = content.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = content.indexOf(tag, i + tag.length);
        if (closeIdx !== -1) {
          const bodyChunk = content.slice(i, closeIdx + tag.length);
          const nlCount = (bodyChunk.match(/\n/g) || []).length;
          line += nlCount;
          buf += bodyChunk;
          i = closeIdx + tag.length;
          continue;
        }
      }
    }

    // 4. Single quote ('...')
    if (ch === "'") {
      if (buf.trim().length === 0) stmtStartLine = line;
      buf += ch;
      i++;
      while (i < len) {
        const c = content[i];
        if (c === "\n") line++;
        buf += c;
        if (c === "'") {
          // Check for '' escape or \' escape
          if (content[i + 1] === "'") {
            buf += "'";
            i += 2;
            continue;
          }
          if (content[i - 1] === "\\") {
            // Escaped in MySQL syntax
            i++;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 5. Double quote ("...")
    if (ch === '"') {
      if (buf.trim().length === 0) stmtStartLine = line;
      buf += ch;
      i++;
      while (i < len) {
        const c = content[i];
        if (c === "\n") line++;
        buf += c;
        if (c === '"') {
          if (content[i + 1] === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          if (content[i - 1] === "\\") {
            i++;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 6. Backtick (`...`)
    if (ch === "`") {
      if (buf.trim().length === 0) stmtStartLine = line;
      buf += ch;
      i++;
      while (i < len) {
        const c = content[i];
        if (c === "\n") line++;
        buf += c;
        if (c === "`") {
          if (content[i + 1] === "`") {
            buf += "`";
            i += 2;
            continue;
          }
          if (content[i - 1] === "\\") {
            i++;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 7. Semicolon: statement terminator
    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed) {
        statements.push({ text: trimmed, line: stmtStartLine });
      }
      buf = "";
      stmtStartLine = line;
      i++;
      continue;
    }

    if (buf.trim().length === 0 && !/\s/.test(ch)) {
      stmtStartLine = line;
    }
    buf += ch;
    i++;
  }

  const trailing = buf.trim();
  if (trailing) {
    statements.push({ text: trailing, line: stmtStartLine });
  }

  return statements;
}

/**
 * Strips quotes, backticks, and schema qualification from an identifier.
 */
export function cleanIdentifier(raw) {
  if (!raw) return "";
  let s = raw.trim();
  if (s.includes(".")) {
    const parts = s.split(".");
    s = parts[parts.length - 1].trim();
  }
  return s.replace(/^["`]|["`]$/g, "").trim();
}

/**
 * Detects whether a new type is narrower than the old type:
 * e.g. text -> varchar(n), bigint -> int, varchar(255) -> varchar(100), etc.
 */
export function isTypeNarrowed(oldType, newType) {
  if (!oldType || !newType) return false;
  const o = oldType.trim().toLowerCase();
  const n = newType.trim().toLowerCase();
  if (o === n) return false;

  const oLenMatch = o.match(/^(?:varchar|char|character varying|character)\s*\(\s*(\d+)\s*\)/);
  const nLenMatch = n.match(/^(?:varchar|char|character varying|character)\s*\(\s*(\d+)\s*\)/);

  const isUnboundedText = (t) => ["text", "longtext", "mediumtext", "varchar", "character varying"].includes(t);

  // Unbounded text -> bounded varchar/char
  if (isUnboundedText(o) && nLenMatch) return true;
  if (o === "longtext" && ["mediumtext", "text", "tinytext"].includes(n)) return true;
  if (o === "mediumtext" && ["text", "tinytext"].includes(n)) return true;
  if (o === "text" && ["tinytext"].includes(n)) return true;

  // Bounded varchar/char -> smaller bounded length
  if (oLenMatch && nLenMatch) {
    const oLen = parseInt(oLenMatch[1], 10);
    const nLen = parseInt(nLenMatch[1], 10);
    if (nLen < oLen) return true;
  }

  // Integer types
  const intRanks = {
    "bigint": 4,
    "int8": 4,
    "int": 3,
    "integer": 3,
    "int4": 3,
    "mediumint": 2.5,
    "smallint": 2,
    "int2": 2,
    "tinyint": 1
  };
  const oBase = o.replace(/\s*\(\s*\d+\s*\)/, "");
  const nBase = n.replace(/\s*\(\s*\d+\s*\)/, "");
  if (intRanks[oBase] && intRanks[nBase]) {
    if (intRanks[nBase] < intRanks[oBase]) return true;
  }

  // Decimal / Numeric precision reduction
  const oNumMatch = o.match(/^(?:numeric|decimal)\s*\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/);
  const nNumMatch = n.match(/^(?:numeric|decimal)\s*\(\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/);
  if (oNumMatch && nNumMatch) {
    const oPrec = parseInt(oNumMatch[1], 10);
    const nPrec = parseInt(nNumMatch[1], 10);
    if (nPrec < oPrec) return true;
  }

  // Double precision -> Real / Float
  if ((o === "double precision" || o === "double") && (n === "real" || n === "float")) {
    return true;
  }

  return false;
}

/**
 * Checks whether a file path qualifies as an SQL migration candidate:
 * - Inside a directory named migrations, migration, db/migrate, sql/migrations, flyway
 * - In a Drizzle folder (a .sql file whose parent folder is named drizzle, any depth)
 * - Anywhere under a db/changelog folder pair (Liquibase)
 * - Or matching Flyway V<n>__*.sql
 * - Or matching prisma/migrations/<dir>/migration.sql
 * - Or inside a folder configured with --migration-dir
 */
export function isSqlMigrationCandidate(relPath = "", fullPath = "", filename = "") {
  const normRel = (relPath || "").replace(/\\/g, "/");
  const normFull = (fullPath || "").replace(/\\/g, "/");
  const fname = filename || normRel.split("/").pop() || "";

  if (!/\.sql$/i.test(fname)) return false;

  // golang-migrate *.down.sql files are down migrations, not judged (Flyway-named files always are)
  if (isDownMigrationFile(fname)) {
    return false;
  }

  // Flyway matching V<n>__*.sql
  if (/^v\d+.*__.*\.sql$/i.test(fname)) return true;

  // prisma/migrations/*/migration.sql
  if (/(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/i.test(normRel) ||
      /(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/i.test(normFull)) {
    return true;
  }

  // Inside a directory named migrations, migration, db/migrate, sql/migrations, flyway
  const hasMatchingDir = (p) => {
    const parts = p.split("/");
    parts.pop(); // remove file name
    const lowerParts = parts.map(s => s.toLowerCase());
    if (lowerParts.some(s => s === "migrations" || s === "migration" || s === "flyway")) {
      return true;
    }
    // Drizzle: only a .sql file directly inside the drizzle folder
    if (lowerParts.length > 0 && lowerParts[lowerParts.length - 1] === "drizzle") return true;
    for (let i = 0; i < lowerParts.length - 1; i++) {
      if (lowerParts[i] === "db" && lowerParts[i + 1] === "migrate") return true;
      if (lowerParts[i] === "sql" && lowerParts[i + 1] === "migrations") return true;
      if (lowerParts[i] === "db" && lowerParts[i + 1] === "changelog") return true;
    }
    return false;
  };

  if (hasMatchingDir(normRel) || hasMatchingDir(normFull)) return true;

  // Folders configured with --migration-dir (case-sensitive, any depth below the folder)
  for (const dir of getMigrationDirs()) {
    if (normRel.startsWith(dir + "/")) return true;
  }

  return false;
}

/**
 * Helper to split elements inside parentheses by comma, respecting nested parens & quotes.
 */
function splitByComma(str) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
    else if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        const item = str.slice(start, i).trim();
        if (item) parts.push(item);
        start = i + 1;
      }
    }
  }
  const last = str.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/**
 * Parses a column definition element string into structured attributes:
 * { name, type, notNull, hasDefault, primaryKey, unique }
 */
function parseColumnDef(rawDef) {
  const tokens = rawDef.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  const rawName = tokens[0];
  const name = cleanIdentifier(rawName);
  const rest = rawDef.slice(rawName.length).trim();

  // Find where constraints start
  const constraintKeywords = [
    "NOT NULL",
    "NULL",
    "DEFAULT",
    "PRIMARY KEY",
    "UNIQUE",
    "AUTO_INCREMENT",
    "REFERENCES",
    "CHECK",
    "COLLATE",
    "GENERATED"
  ];

  let typeEndIdx = rest.length;
  let parenDepth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (parenDepth === 0) {
      const remaining = rest.slice(i);
      for (const kw of constraintKeywords) {
        const regex = new RegExp(`^\\b${kw}\\b`, "i");
        if (regex.test(remaining)) {
          typeEndIdx = i;
          break;
        }
      }
      if (typeEndIdx !== rest.length) break;
    }
  }

  const type = rest.slice(0, typeEndIdx).trim();
  const constraints = rest.slice(typeEndIdx).trim();

  const isSerial = /\b(?:serial|bigserial|smallserial)\b/i.test(type);
  const isAutoInc = /\bAUTO_INCREMENT\b/i.test(constraints) || /\bAUTO_INCREMENT\b/i.test(type);
  const hasDefault = /\bDEFAULT\b/i.test(constraints) || isSerial || isAutoInc;
  const isPk = /\bPRIMARY\s+KEY\b/i.test(constraints);
  const notNull = isPk || (/\bNOT\s+NULL\b/i.test(constraints) && !/\bNULL\b/i.test(constraints.replace(/\bNOT\s+NULL\b/gi, "")));
  const unique = /\bUNIQUE\b/i.test(constraints);

  return {
    name,
    type: type.toLowerCase(),
    notNull,
    hasDefault,
    primaryKey: isPk,
    unique
  };
}

// Flyway applies every V<version>__ / R__ file whatever its suffix, so "V2__x.down.sql" is a normal migration there.
const FLYWAY_NAME = /^(?:[VR]\d+(?:[._]\d+)*__|R__)/i;
const FLYWAY_UNDO_NAME = /^U\d+.*__.*\.sql$/i;

// golang-migrate pairs "<version>_<title>.up.sql" with ".down.sql"; the down file only runs on rollback.
// Flyway undo files ("U<version>__*.sql") are rollback files and are not judged.
export function isDownMigrationFile(filePath = "") {
  const fname = String(filePath).split(/[\/\\]/).pop() || "";
  if (FLYWAY_UNDO_NAME.test(fname)) {
    return true;
  }
  return /\.down\.sql$/i.test(fname) && !FLYWAY_NAME.test(fname);
}

/**
 * Tools that run the WHOLE migration file, so a dbmate/goose/sql-migrate "down" section is still executed there:
 * Prisma (prisma/migrations/<folder>/migration.sql), Drizzle (a .sql directly inside a drizzle/ folder) and
 * Liquibase (anything under db/changelog/). Same path tests as isSqlMigrationCandidate.
 */
function runsWholeMigrationFile(filePath = "") {
  const norm = String(filePath || "").replace(/\\/g, "/");
  if (/(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/i.test(norm)) return true;
  const parts = norm.split("/");
  parts.pop();
  const lowerParts = parts.map(s => s.toLowerCase());
  if (lowerParts.length > 0 && lowerParts[lowerParts.length - 1] === "drizzle") return true;
  for (let i = 0; i < lowerParts.length - 1; i++) {
    if (lowerParts[i] === "db" && lowerParts[i + 1] === "changelog") return true;
  }
  return false;
}

/**
 * Strips down sections from SQL migration content:
 * - dbmate: -- migrate:down
 * - goose: -- +goose Down
 * - sql-migrate: -- +migrate Down
 * Sections are dropped only when the file also has the matching Up marker and is not Flyway-named.
 * Replaces lines in down sections with blanks to preserve line numbering.
 */
export function stripDbmateDownSections(content = "", filePath = "") {
  if (typeof content !== "string") {
    return content;
  }

  const fname = String(filePath).split(/[\/\\]/).pop() || "";
  // Flyway versioned (V) and repeatable (R) migrations execute all statements regardless of down comments
  if (FLYWAY_NAME.test(fname)) {
    return content;
  }
  if (runsWholeMigrationFile(filePath)) {
    return content;
  }

  const hasDbmateUp = /^\s*--\s*migrate\s*:\s*up\b/im.test(content);
  const hasDbmateDown = /^\s*--\s*migrate\s*:\s*down\b/im.test(content);
  const activeDbmate = hasDbmateUp && hasDbmateDown;

  const hasGooseUp = /^\s*--\s*\+goose\s+Up\b/im.test(content);
  const hasGooseDown = /^\s*--\s*\+goose\s+Down\b/im.test(content);
  const activeGoose = hasGooseUp && hasGooseDown;

  const hasSqlMigrateUp = /^\s*--\s*\+migrate\s+Up\b/im.test(content);
  const hasSqlMigrateDown = /^\s*--\s*\+migrate\s+Down\b/im.test(content);
  const activeSqlMigrate = hasSqlMigrateUp && hasSqlMigrateDown;

  if (!activeDbmate && !activeGoose && !activeSqlMigrate) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  let isDown = false;
  const resultLines = [];
  for (const line of lines) {
    let isDownMarker = false;
    let isUpMarker = false;

    if (activeDbmate) {
      if (/^\s*--\s*migrate\s*:\s*down\b/i.test(line)) isDownMarker = true;
      if (/^\s*--\s*migrate\s*:\s*up\b/i.test(line)) isUpMarker = true;
    }
    if (activeGoose) {
      if (/^\s*--\s*\+goose\s+Down\b/i.test(line)) isDownMarker = true;
      if (/^\s*--\s*\+goose\s+Up\b/i.test(line)) isUpMarker = true;
    }
    if (activeSqlMigrate) {
      if (/^\s*--\s*\+migrate\s+Down\b/i.test(line)) isDownMarker = true;
      if (/^\s*--\s*\+migrate\s+Up\b/i.test(line)) isUpMarker = true;
    }

    if (isDownMarker) {
      isDown = true;
      resultLines.push("");
      continue;
    }
    if (isUpMarker) {
      isDown = false;
      resultLines.push(line);
      continue;
    }
    if (isDown) {
      resultLines.push("");
    } else {
      resultLines.push(line);
    }
  }
  return resultLines.join("\n");
}

// T-107 (E): view names created during a replay. parseSqlFacts runs once per file with the same
// shared `entities` array, so key this registry on that array to keep view names across files in
// one replay without adding views to the facts.
const viewsByEntities = new WeakMap();

/**
 * Replays DDL statements from an SQL migration file into entities and collects statement events.
 */
export function parseSqlFacts(filePath, content, getStableId, entities, relations, sources, errors) {
  const fname = (filePath || "").split(/[\/\\]/).pop() || "";
  if (isDownMigrationFile(fname)) {
    return;
  }
  const cleanedContent = stripDbmateDownSections(content, filePath);
  const statements = splitSqlStatements(cleanedContent);
  const createdInThisFile = new Set();
  const tempTablesInThisFile = new Set();
  const views = viewsByEntities.get(entities) || new Set();
  viewsByEntities.set(entities, views);
  const fileEvents = [];

  // T-103: SQLite cannot alter columns, so migrations rebuild a table:
  // CREATE TABLE new_x; INSERT ...; DROP TABLE x; ALTER TABLE new_x RENAME TO x.
  // Pre-scan the file for the names each statement renames a table TO, so a DROP TABLE x
  // followed later in this file by a rename TO x is not reported as a destructive drop.
  const renameToByStmtIndex = statements.map(stmt => {
    const names = [];
    const stmtText = String(stmt.text || "");
    const alterRename = stmtText.match(/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s,(]+)\s+RENAME\s+TO\s+([^\s;(]+)/i);
    if (alterRename) names.push(cleanIdentifier(alterRename[2]).toLowerCase());
    const directRename = stmtText.match(/^\s*RENAME\s+TABLE\s+([\s\S]+)$/i);
    if (directRename) {
      for (const pair of splitByComma(directRename[1])) {
        const m = pair.match(/([^\s]+)\s+TO\s+([^\s;]+)/i);
        if (m) names.push(cleanIdentifier(m[2]).toLowerCase());
      }
    }
    return names;
  });
  let stmtIndex = -1;

  // Helper maps to inspect current entities state
  const findTableEntity = (name) => entities.find(e => e.kind === "db.table" && e.name.toLowerCase() === name.toLowerCase());
  const findColumnEntity = (tbl, col) => entities.find(e => e.kind === "db.column" && e.attrs?.table?.toLowerCase() === tbl.toLowerCase() && e.attrs?.name?.toLowerCase() === col.toLowerCase());

  // Columns filled by an UPDATE earlier in this file: "add nullable, backfill, SET NOT NULL" is the safe pattern
  const backfilled = new Set();
  const wasBackfilled = (tbl, col) => backfilled.has(`${tbl}.${col}`.toLowerCase());

  for (const stmt of statements) {
    stmtIndex++;
    const text = stmt.text;
    const line = stmt.line;

    const updateMatch = text.match(/^\s*UPDATE\s+(?:ONLY\s+)?([^\s]+)\s+(?:(?:AS\s+)?(?!SET\b)\w+\s+)?SET\s+([\s\S]+?)(?:\s+(?:FROM|WHERE|RETURNING)\b[\s\S]*)?;?\s*$/i);
    if (updateMatch) {
      const tbl = cleanIdentifier(updateMatch[1]);
      let depth = 0;
      let start = 0;
      const assignments = [];
      const setList = updateMatch[2];
      for (let i = 0; i <= setList.length; i++) {
        const ch = setList[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if ((ch === "," && depth === 0) || i === setList.length) {
          assignments.push(setList.slice(start, i));
          start = i + 1;
        }
      }
      for (const a of assignments) {
        const m = a.match(/^\s*(?:[^\s=.]+\.)?([^\s=]+)\s*=/);
        if (m) backfilled.add(`${tbl}.${cleanIdentifier(m[1])}`.toLowerCase());
      }
      continue;
    }

    // T-107 (E): views are not tables. Remember every view created in the replay so a later
    // DROP TABLE of that name is not reported, and CREATE MATERIALIZED VIEW produces no table facts.
    const viewMatch = text.match(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
    if (viewMatch) {
      views.add(cleanIdentifier(viewMatch[1]).toLowerCase());
      continue;
    }

    // 1. CREATE TABLE
    const createTableMatch = text.match(/^\s*CREATE\s+(?:(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i);
    if (createTableMatch) {
      const rawTableName = createTableMatch[1];
      const tableName = cleanIdentifier(rawTableName);
      // T-107 (A): a TEMP/TEMPORARY table lives only for this file's session. It never becomes
      // part of the replayed schema, and dropping it is not a destructive schema change.
      if (/^\s*CREATE\s+(?:TEMPORARY|TEMP)\s+TABLE\b/i.test(text)) {
        tempTablesInThisFile.add(tableName.toLowerCase());
        continue;
      }
      createdInThisFile.add(tableName.toLowerCase());

      const openIdx = text.indexOf("(", createTableMatch.index + createTableMatch[0].length - 1);
      let depth = 0;
      let closeIdx = -1;
      for (let i = openIdx; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") {
          depth--;
          if (depth === 0) {
            closeIdx = i;
            break;
          }
        }
      }

      if (closeIdx !== -1) {
        const body = text.slice(openIdx + 1, closeIdx);
        const elements = splitByComma(body);

        // Remove previous table if re-created
        const existingTblIdx = entities.findIndex(e => e.kind === "db.table" && e.name.toLowerCase() === tableName.toLowerCase());
        if (existingTblIdx !== -1) entities.splice(existingTblIdx, 1);

        const tableSource = { file: filePath, line };
        entities.push({
          kind: "db.table",
          id: getStableId("db.table", tableName, tableSource),
          name: tableName,
          source: tableSource,
          attrs: { name: tableName }
        });

        const tableColumns = [];
        const tablePks = new Set();
        const tableUniques = new Set();

        for (const el of elements) {
          const trimmed = el.trim();
          if (/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.test(trimmed)) {
            const m = trimmed.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
            if (m) {
              m[1].split(",").map(cleanIdentifier).filter(Boolean).forEach(c => tablePks.add(c.toLowerCase()));
            }
          } else if (/^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\b(?:\s+(?:KEY|INDEX))?\s*(?:\S+\s*)?\(([^)]+)\)/i.test(trimmed)) {
            const m = trimmed.match(/UNIQUE(?:\s+(?:KEY|INDEX))?\s*(?:\S+\s*)?\(([^)]+)\)/i);
            if (m) {
              const cols = m[1].split(",").map(cleanIdentifier).filter(Boolean);
              if (cols.length === 1) tableUniques.add(cols[0].toLowerCase());
            }
          } else if (/^(?:FOREIGN\s+KEY|CHECK|KEY|INDEX)\b/i.test(trimmed)) {
            // Ignore other constraints
          } else {
            const col = parseColumnDef(trimmed);
            if (col) tableColumns.push(col);
          }
        }

        for (const col of tableColumns) {
          const isPk = col.primaryKey || tablePks.has(col.name.toLowerCase());
          const isUnique = col.unique || tableUniques.has(col.name.toLowerCase());
          const notNull = col.notNull || isPk;
          const colSource = { file: filePath, line };

          entities.push({
            kind: "db.column",
            id: getStableId("db.column", `${tableName}.${col.name}`, colSource),
            name: col.name,
            source: colSource,
            attrs: {
              table: tableName,
              name: col.name,
              type: col.type,
              notNull,
              hasDefault: col.hasDefault,
              primaryKey: isPk,
              unique: isUnique
            }
          });
        }
      }
      continue;
    }

    // T-107 (A): CREATE TEMP TABLE x AS SELECT ... has no column list, so the CREATE TABLE regex
    // above does not see it. Record it as a temp table only; it produces no table/column facts.
    const createTempAsMatch = text.match(/^\s*CREATE\s+(?:TEMPORARY|TEMP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s+AS\b/i);
    if (createTempAsMatch) {
      tempTablesInThisFile.add(cleanIdentifier(createTempAsMatch[1]).toLowerCase());
      continue;
    }

    // 2. DROP TABLE
    const dropTableMatch = text.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:CASCADE|RESTRICT)?\s*$/i);
    if (dropTableMatch) {
      const rawTables = dropTableMatch[1].split(",");
      for (const rt of rawTables) {
        const tName = cleanIdentifier(rt);
        if (!tName) continue;
        const tLower = tName.toLowerCase();

        // Remove from entities
        const tIdx = entities.findIndex(e => e.kind === "db.table" && e.name.toLowerCase() === tLower);
        if (tIdx !== -1) entities.splice(tIdx, 1);

        for (let idx = entities.length - 1; idx >= 0; idx--) {
          if (entities[idx].kind === "db.column" && entities[idx].attrs?.table?.toLowerCase() === tLower) {
            entities.splice(idx, 1);
          }
        }

        // T-103: a later rename of another table TO this name in the same file is the SQLite
        // table-rebuild idiom; the replayed result is the new table under the old name.
        const rebuildRenameLater = renameToByStmtIndex.some(
          (names, idx) => idx > stmtIndex && names.includes(tLower)
        );

        // FP3: a table created and dropped in the same migration produces no drop finding
        if (!createdInThisFile.has(tLower) && !tempTablesInThisFile.has(tLower) && !views.has(tLower) && !rebuildRenameLater) {
          fileEvents.push({
            type: "sql.drop_table",
            entityId: `db.table:${tName}`,
            kind: "db.table",
            before: tName,
            source: { file: filePath, line },
            message: `Table '${tName}' was dropped`
          });
        }
      }
      continue;
    }

    // 3. ALTER TABLE
    const alterTableMatch = text.match(/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s,(]+)\s+([\s\S]+)$/i);
    if (alterTableMatch) {
      const rawTableName = alterTableMatch[1];
      const tableName = cleanIdentifier(rawTableName);
      const actionBody = alterTableMatch[2];
      const actions = splitByComma(actionBody);

      for (const action of actions) {
        const act = action.trim();

        // A. ADD COLUMN
        const addColMatch = act.match(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i);
        // ADD CONSTRAINT / PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK / INDEX / KEY are not columns (explicit ADD COLUMN always is)
        const addsColumn = /^ADD\s+COLUMN\b/i.test(act) ||
          !/^ADD\s+(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|INDEX|KEY|FULLTEXT|SPATIAL|PARTITION)\b/i.test(act);
        if (addColMatch && addsColumn) {
          const col = parseColumnDef(addColMatch[1]);
          if (col) {
            if (col.notNull && !col.hasDefault) {
              fileEvents.push({
                type: "sql.not_null_without_default",
                entityId: `db.column:${tableName}.${col.name}`,
                kind: "db.column",
                after: "NOT NULL",
                source: { file: filePath, line },
                message: `Column '${tableName}.${col.name}' was added as NOT NULL without DEFAULT`
              });
            }
            const colSource = { file: filePath, line };
            entities.push({
              kind: "db.column",
              id: getStableId("db.column", `${tableName}.${col.name}`, colSource),
              name: col.name,
              source: colSource,
              attrs: {
                table: tableName,
                name: col.name,
                type: col.type,
                notNull: col.notNull,
                hasDefault: col.hasDefault,
                primaryKey: col.primaryKey,
                unique: col.unique
              }
            });
          }
          continue;
        }

        // B. DROP COLUMN (only when the word after DROP is not a keyword)
        // Keywords after DROP that are NOT columns: CONSTRAINT, INDEX, KEY, PRIMARY, FOREIGN, CHECK, DEFAULT, NOT, PARTITION
        const hasExplicitColumn = /^DROP\s+COLUMN\b/i.test(act);
        const dropColMatch = act.match(/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([^\s,(]+)/i);
        if (dropColMatch) {
          const droppedWord = dropColMatch[1].trim().toUpperCase();
          const isNonColumnKeyword = [
            "CONSTRAINT", "INDEX", "KEY", "PRIMARY", "FOREIGN",
            "CHECK", "DEFAULT", "NOT", "PARTITION"
          ].includes(droppedWord);
          const isColumnDrop = hasExplicitColumn || !isNonColumnKeyword;
          if (isColumnDrop) {
            const colName = cleanIdentifier(dropColMatch[1]);
            const existingIdx = entities.findIndex(
              e => e.kind === "db.column" && e.attrs?.table?.toLowerCase() === tableName.toLowerCase() && e.attrs?.name?.toLowerCase() === colName.toLowerCase()
            );
            if (existingIdx !== -1) {
              entities.splice(existingIdx, 1);
            }
            fileEvents.push({
              type: "sql.drop_column",
              entityId: `db.column:${tableName}.${colName}`,
              kind: "db.column",
              before: `${tableName}.${colName}`,
              source: { file: filePath, line },
              message: `Column '${tableName}.${colName}' was dropped`
            });
          }
          continue;
        }

        // C. RENAME COLUMN
        const renameColMatch = act.match(/^RENAME\s+(?:COLUMN\s+)?([^\s]+)\s+TO\s+([^\s]+)/i);
        if (renameColMatch) {
          const oldCol = cleanIdentifier(renameColMatch[1]);
          const newCol = cleanIdentifier(renameColMatch[2]);
          const existing = findColumnEntity(tableName, oldCol);
          if (existing) {
            existing.name = newCol;
            existing.attrs.name = newCol;
            existing.id = `db.column:${tableName}.${newCol}`;
            existing.source = { file: filePath, line };
          }
          fileEvents.push({
            type: "sql.rename",
            entityId: `db.column:${tableName}.${newCol}`,
            kind: "db.column",
            before: `${tableName}.${oldCol}`,
            after: `${tableName}.${newCol}`,
            source: { file: filePath, line },
            message: `Column '${tableName}.${oldCol}' was renamed to '${newCol}'`
          });
          continue;
        }

        // D. RENAME TABLE (ALTER TABLE tbl RENAME TO newTbl)
        const renameTableMatch = act.match(/^RENAME\s+TO\s+([^\s]+)/i);
        if (renameTableMatch) {
          const newTableName = cleanIdentifier(renameTableMatch[1]);
          const tblEnt = findTableEntity(tableName);
          if (tblEnt) {
            tblEnt.name = newTableName;
            tblEnt.attrs.name = newTableName;
            tblEnt.id = `db.table:${newTableName}`;
            tblEnt.source = { file: filePath, line };
          }
          for (const ent of entities) {
            if (ent.kind === "db.column" && ent.attrs?.table?.toLowerCase() === tableName.toLowerCase()) {
              ent.attrs.table = newTableName;
              ent.id = `db.column:${newTableName}.${ent.name}`;
              ent.source = { file: filePath, line };
            }
          }
          fileEvents.push({
            type: "sql.rename",
            entityId: `db.table:${newTableName}`,
            kind: "db.table",
            before: tableName,
            after: newTableName,
            source: { file: filePath, line },
            message: `Table '${tableName}' was renamed to '${newTableName}'`
          });
          continue;
        }

        // E. Postgres ALTER [COLUMN] colName TYPE
        const alterColTypeMatch = act.match(/^ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+(?:SET\s+DATA\s+)?TYPE\s+([^,]+?)(?:\s+USING\b.*)?$/i);
        if (alterColTypeMatch) {
          const colName = cleanIdentifier(alterColTypeMatch[1]);
          const newType = alterColTypeMatch[2].trim().toLowerCase();
          const existing = findColumnEntity(tableName, colName);
          if (existing) {
            const oldType = existing.attrs.type;
            if (isTypeNarrowed(oldType, newType)) {
              fileEvents.push({
                type: "sql.type_narrowed",
                entityId: existing.id,
                kind: "db.column",
                before: oldType,
                after: newType,
                source: { file: filePath, line },
                message: `Column '${tableName}.${colName}' type narrowed from '${oldType}' to '${newType}'`
              });
            }
            existing.attrs.type = newType;
            existing.source = { file: filePath, line };
          }
          continue;
        }

        // F. Postgres ALTER [COLUMN] colName SET NOT NULL
        const setNotNullMatch = act.match(/^ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+SET\s+NOT\s+NULL/i);
        if (setNotNullMatch) {
          const colName = cleanIdentifier(setNotNullMatch[1]);
          const existing = findColumnEntity(tableName, colName);
          if (existing) {
            existing.attrs.notNull = true;
            existing.source = { file: filePath, line };
          }
          if (!wasBackfilled(tableName, colName)) {
            fileEvents.push({
              type: "sql.not_null_without_default",
              entityId: `db.column:${tableName}.${colName}`,
              kind: "db.column",
              after: "NOT NULL",
              source: { file: filePath, line },
              message: `Column '${tableName}.${colName}' was set to NOT NULL`
            });
          }
          continue;
        }

        // G. Postgres ALTER [COLUMN] colName DROP NOT NULL
        const dropNotNullMatch = act.match(/^ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+DROP\s+NOT\s+NULL/i);
        if (dropNotNullMatch) {
          const colName = cleanIdentifier(dropNotNullMatch[1]);
          const existing = findColumnEntity(tableName, colName);
          if (existing) {
            existing.attrs.notNull = false;
            existing.source = { file: filePath, line };
          }
          continue;
        }

        // H. Postgres ALTER [COLUMN] colName SET/DROP DEFAULT
        const setDefaultMatch = act.match(/^ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+SET\s+DEFAULT/i);
        if (setDefaultMatch) {
          const colName = cleanIdentifier(setDefaultMatch[1]);
          const existing = findColumnEntity(tableName, colName);
          if (existing) {
            existing.attrs.hasDefault = true;
            existing.source = { file: filePath, line };
          }
          continue;
        }
        const dropDefaultMatch = act.match(/^ALTER\s+(?:COLUMN\s+)?([^\s]+)\s+DROP\s+DEFAULT/i);
        if (dropDefaultMatch) {
          const colName = cleanIdentifier(dropDefaultMatch[1]);
          const existing = findColumnEntity(tableName, colName);
          if (existing) {
            existing.attrs.hasDefault = false;
            existing.source = { file: filePath, line };
          }
          continue;
        }

        // I. MySQL MODIFY [COLUMN] colDef
        const modifyMatch = act.match(/^MODIFY\s+(?:COLUMN\s+)?([\s\S]+)$/i);
        if (modifyMatch) {
          const col = parseColumnDef(modifyMatch[1]);
          if (col) {
            const existing = findColumnEntity(tableName, col.name);
            if (existing) {
              const oldType = existing.attrs.type;
              if (isTypeNarrowed(oldType, col.type)) {
                fileEvents.push({
                  type: "sql.type_narrowed",
                  entityId: existing.id,
                  kind: "db.column",
                  before: oldType,
                  after: col.type,
                  source: { file: filePath, line },
                  message: `Column '${tableName}.${col.name}' type narrowed from '${oldType}' to '${col.type}'`
                });
              }
              if (col.notNull && !existing.attrs.notNull && !col.hasDefault && !existing.attrs.hasDefault && !wasBackfilled(tableName, col.name)) {
                fileEvents.push({
                  type: "sql.not_null_without_default",
                  entityId: existing.id,
                  kind: "db.column",
                  after: "NOT NULL",
                  source: { file: filePath, line },
                  message: `Column '${tableName}.${col.name}' was set to NOT NULL`
                });
              }
              existing.attrs.type = col.type;
              existing.attrs.notNull = col.notNull;
              existing.attrs.hasDefault = col.hasDefault;
              existing.source = { file: filePath, line };
            }
          }
          continue;
        }

        // J. MySQL CHANGE [COLUMN] oldCol newColDef
        const changeMatch = act.match(/^CHANGE\s+(?:COLUMN\s+)?([^\s]+)\s+([\s\S]+)$/i);
        if (changeMatch) {
          const oldCol = cleanIdentifier(changeMatch[1]);
          const col = parseColumnDef(changeMatch[2]);
          if (col) {
            const isRename = oldCol.toLowerCase() !== col.name.toLowerCase();
            if (isRename) {
              fileEvents.push({
                type: "sql.rename",
                entityId: `db.column:${tableName}.${col.name}`,
                kind: "db.column",
                before: `${tableName}.${oldCol}`,
                after: `${tableName}.${col.name}`,
                source: { file: filePath, line },
                message: `Column '${tableName}.${oldCol}' was renamed to '${col.name}'`
              });
            }
            const existing = findColumnEntity(tableName, oldCol);
            if (existing) {
              const oldType = existing.attrs.type;
              if (isTypeNarrowed(oldType, col.type)) {
                fileEvents.push({
                  type: "sql.type_narrowed",
                  entityId: `db.column:${tableName}.${col.name}`,
                  kind: "db.column",
                  before: oldType,
                  after: col.type,
                  source: { file: filePath, line },
                  message: `Column '${tableName}.${col.name}' type narrowed from '${oldType}' to '${col.type}'`
                });
              }
              if (col.notNull && !existing.attrs.notNull && !col.hasDefault && !existing.attrs.hasDefault && !wasBackfilled(tableName, col.name)) {
                fileEvents.push({
                  type: "sql.not_null_without_default",
                  entityId: `db.column:${tableName}.${col.name}`,
                  kind: "db.column",
                  after: "NOT NULL",
                  source: { file: filePath, line },
                  message: `Column '${tableName}.${col.name}' was set to NOT NULL`
                });
              }
              existing.name = col.name;
              existing.id = `db.column:${tableName}.${col.name}`;
              existing.attrs.name = col.name;
              existing.attrs.type = col.type;
              existing.attrs.notNull = col.notNull;
              existing.attrs.hasDefault = col.hasDefault;
              existing.source = { file: filePath, line };
            }
          }
          continue;
        }
      }
      continue;
    }

    // 4. MySQL RENAME TABLE old TO new
    const renameTableDirect = text.match(/^\s*RENAME\s+TABLE\s+([\s\S]+)$/i);
    if (renameTableDirect) {
      const pairs = splitByComma(renameTableDirect[1]);
      for (const pair of pairs) {
        const m = pair.match(/([^\s]+)\s+TO\s+([^\s]+)/i);
        if (m) {
          const oldT = cleanIdentifier(m[1]);
          const newT = cleanIdentifier(m[2]);
          const tblEnt = findTableEntity(oldT);
          if (tblEnt) {
            tblEnt.name = newT;
            tblEnt.attrs.name = newT;
            tblEnt.id = `db.table:${newT}`;
            tblEnt.source = { file: filePath, line };
          }
          for (const ent of entities) {
            if (ent.kind === "db.column" && ent.attrs?.table?.toLowerCase() === oldT.toLowerCase()) {
              ent.attrs.table = newT;
              ent.id = `db.column:${newT}.${ent.name}`;
              ent.source = { file: filePath, line };
            }
          }
          fileEvents.push({
            type: "sql.rename",
            entityId: `db.table:${newT}`,
            kind: "db.table",
            before: oldT,
            after: newT,
            source: { file: filePath, line },
            message: `Table '${oldT}' was renamed to '${newT}'`
          });
        }
      }
      continue;
    }

    // 5. CREATE [UNIQUE] INDEX [CONCURRENTLY]
    const createIndexMatch = text.match(/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\bCONCURRENTLY\b\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:\S+\s+)?ON\s+(?:ONLY\s+)?([^\s(]+)/i);
    if (createIndexMatch) {
      const hasConcurrently = Boolean(createIndexMatch[1]);
      const rawTableName = createIndexMatch[2];
      const tableName = cleanIdentifier(rawTableName);
      const isExistingTable = !createdInThisFile.has(tableName.toLowerCase()) && Boolean(findTableEntity(tableName));

      if (!hasConcurrently && isExistingTable && isPostgresMigrationFile(filePath)) {
        fileEvents.push({
          type: "sql.index_without_concurrently",
          entityId: `db.table:${tableName}`,
          kind: "db.table",
          source: { file: filePath, line },
          message: `Index on table '${tableName}' created without CONCURRENTLY`
        });
      }
      continue;
    }
  }

  sources.push({
    path: filePath,
    kind: "Database",
    entityCount: entities.filter(e => e.source?.file === filePath).length,
    content,
    events: fileEvents
  });
}

/**
 * T-103: CONCURRENTLY is PostgreSQL-only. A migration is clearly not PostgreSQL when its path has a
 * mysql/mariadb/sqlite segment, or when the Prisma migrations root's migration_lock.toml says so.
 */
function isPostgresMigrationFile(filePath) {
  const norm = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  if (norm.split("/").some(seg => seg === "mysql" || seg === "mariadb" || seg === "sqlite")) return false;
  const prismaMatch = norm.match(/^(.*?migrations)\/[^/]+\/migration\.sql$/);
  if (prismaMatch) {
    try {
      const lock = readFileSync(`${prismaMatch[1]}/migration_lock.toml`, "utf8");
      const provider = lock.match(/provider\s*=\s*["']([^"']+)["']/i);
      if (provider) {
        const p = provider[1].toLowerCase();
        if (p === "mysql" || p === "sqlite") return false;
      }
    } catch {
      // Lock file not readable from here: skip this part of the check.
    }
  }
  return true;
}

export function normalizeMigrationContent(content = "") {
  return String(content || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
}

function getMigrationVersionPrefix(filePath) {
  const norm = (filePath || "").replace(/\\/g, "/");
  const filename = norm.split("/").pop();
  const flywayMatch = filename.match(/^([vVuU]\d+(?:[._]\d+)*)__/);
  if (flywayMatch) return flywayMatch[1].toUpperCase();
  const prismaMatch = norm.match(/migrations\/([^\/]+)\/migration\.sql$/i);
  if (prismaMatch) return prismaMatch[1];
  const numMatch = filename.match(/^(\d+)/);
  if (numMatch) return numMatch[1];
  return null;
}

/**
 * Diffs facts between base and head states for SQL migrations:
 * - Emits sql.migration_edited for modified migrations in head
 * - Emits sql.migration_edited for deleted or renamed migrations in head (history rewrite)
 * - Emits statement-level events for new migration files and for statements added to edited ones
 * - Emits normal db.* facts diff (field_removed, type_changed, made_required)
 */
export function diffSqlFacts(base = {}, head = {}, events = [], isTruncated = false) {
  const baseSources = (base.sources || []).filter(s => isSqlMigrationCandidate(s.path));
  const headSources = (head.sources || []).filter(s => isSqlMigrationCandidate(s.path));

  const baseMap = new Map(baseSources.map(s => [s.path, s]));
  const headMap = new Map(headSources.map(s => [s.path, s]));
  const gitRenames = head._renames || base._renames || new Map();

  const missingInHead = baseSources.filter(b => !headMap.has(b.path));
  const newInHead = headSources.filter(h => !baseMap.has(h.path));

  const renamePairings = new Map(); // headPath -> baseSrc
  const pairedBasePaths = new Set();
  const pairedHeadPaths = new Set();

  const getDir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

  // Pair renames between missingInHead and newInHead
  for (const h of newInHead) {
    let matchedBase = null;

    // 1. Git explicit rename match
    if (gitRenames.has(h.path)) {
      const oldP = gitRenames.get(h.path);
      matchedBase = missingInHead.find(b => b.path === oldP && !pairedBasePaths.has(b.path));
    }

    // 2. Normalized content match in the same directory (or across directories)
    if (!matchedBase) {
      const hNorm = normalizeMigrationContent(h.content);
      matchedBase = missingInHead.find(
        b => !pairedBasePaths.has(b.path) &&
             getDir(b.path) === getDir(h.path) &&
             normalizeMigrationContent(b.content) === hNorm
      );
      if (!matchedBase) {
        matchedBase = missingInHead.find(
          b => !pairedBasePaths.has(b.path) &&
               normalizeMigrationContent(b.content) === hNorm
        );
      }
    }

    // 3. Migration version prefix match in the same directory
    if (!matchedBase) {
      const hVer = getMigrationVersionPrefix(h.path);
      if (hVer) {
        matchedBase = missingInHead.find(
          b => !pairedBasePaths.has(b.path) &&
               getDir(b.path) === getDir(h.path) &&
               getMigrationVersionPrefix(b.path) === hVer
        );
      }
    }

    // 4. Single file renamed in same directory
    if (!matchedBase && missingInHead.filter(b => !pairedBasePaths.has(b.path) && getDir(b.path) === getDir(h.path)).length === 1 &&
        newInHead.filter(nh => !pairedHeadPaths.has(nh.path) && getDir(nh.path) === getDir(h.path)).length === 1) {
      matchedBase = missingInHead.find(b => !pairedBasePaths.has(b.path) && getDir(b.path) === getDir(h.path));
    }

    if (matchedBase) {
      renamePairings.set(h.path, matchedBase);
      pairedBasePaths.add(matchedBase.path);
      pairedHeadPaths.add(h.path);
    }
  }

  // 1. Separate folder moves (identical content across folders) from individual renames
  const folderMoves = new Map();
  const individualRenames = [];

  for (const [hPath, bSrc] of renamePairings.entries()) {
    const isIdentical = normalizeMigrationContent(bSrc.content) === normalizeMigrationContent(headMap.get(hPath).content);
    const fromDir = getDir(bSrc.path);
    const toDir = getDir(hPath);

    if (isIdentical && fromDir !== toDir) {
      const key = `${fromDir}\0${toDir}`;
      if (!folderMoves.has(key)) {
        folderMoves.set(key, { fromDir, toDir, files: [] });
      }
      folderMoves.get(key).files.push({ hPath, bSrc });
    } else {
      individualRenames.push({ hPath, bSrc });
    }
  }

  // Folder moves with identical content emit one soft event per folder
  for (const { fromDir, toDir, files } of folderMoves.values()) {
    const count = files.length;
    events.push({
      type: "sql.migrations_moved",
      entityId: `sql.migrations:${toDir}`,
      kind: "sql.migrations",
      count,
      before: fromDir,
      after: toDir,
      source: { file: toDir, line: 1 },
      message: `${count} migrations moved from ${fromDir} to ${toDir}`
    });
  }

  // Renames with changed content (or non-folder renames) stay hard sql.migration_edited
  for (const { hPath, bSrc } of individualRenames) {
    events.push({
      type: "sql.migration_edited",
      entityId: `sql.migration:${hPath}`,
      kind: "sql.migration",
      before: bSrc.content,
      after: headMap.get(hPath).content,
      source: { file: hPath, line: 1 },
      message: `Migration file '${hPath}' was renamed from '${bSrc.path}' after being applied (history rewrite)`
    });
  }

  // 2. Emits sql.migration_edited for deleted applied migrations
  for (const bSrc of missingInHead) {
    if (!pairedBasePaths.has(bSrc.path)) {
      events.push({
        type: "sql.migration_edited",
        entityId: `sql.migration:${bSrc.path}`,
        kind: "sql.migration",
        before: bSrc.content,
        after: null,
        source: { file: bSrc.path, line: 1 },
        message: `Migration file '${bSrc.path}' was deleted after being applied (history rewrite)`
      });
    }
  }

  // 3. Emits sql.migration_edited for in-place edited migrations (normalizing CRLF to LF)
  // Editing an R__*.sql file is not sql-no-migration-edited (Flyway re-runs them by design)
  for (const [path, headSrc] of headMap.entries()) {
    if (baseMap.has(path)) {
      const baseSrc = baseMap.get(path);
      if (normalizeMigrationContent(baseSrc.content) !== normalizeMigrationContent(headSrc.content)) {
        const fname = path.split("/").pop();
        const isRepeatable = /^r__.*\.sql$/i.test(fname);
        if (!isRepeatable) {
          events.push({
            type: "sql.migration_edited",
            entityId: `sql.migration:${path}`,
            kind: "sql.migration",
            before: baseSrc.content,
            after: headSrc.content,
            source: { file: path, line: 1 },
            message: `Migration file '${path}' was edited after being applied (history rewrite)`
          });
        }
      }
    }
  }

  // 4. Statement-level events: every statement of a new migration; for an edited/renamed migration only the statements
  //    the edit added (a DROP COLUMN slipped into an applied file), not the ones already there in base.
  //    For Flyway repeatable (R__*.sql) files, statements are judged as new statements.
  for (const [path, headSrc] of headMap.entries()) {
    const baseSrc = baseMap.get(path) || renamePairings.get(path);
    if (baseSrc && normalizeMigrationContent(baseSrc.content) === normalizeMigrationContent(headSrc.content)) continue;
    const fname = path.split("/").pop();
    const isRepeatable = /^r__.*\.sql$/i.test(fname);
    if (isRepeatable) {
      for (const ev of headSrc.events || []) {
        events.push(ev);
      }
    } else {
      const already = new Set((baseSrc?.events || []).map(ev => `${ev.type}\u0000${ev.entityId}`));
      for (const ev of headSrc.events || []) {
        if (!already.has(`${ev.type}\u0000${ev.entityId}`)) events.push(ev);
      }
    }
  }

  // 3. Reused db.* events for db.column entities (if not truncated)
  if (!isTruncated) {
    const baseEntities = new Map((base.entities || []).map(e => [e.id, e]));
    const headEntities = new Map((head.entities || []).map(e => [e.id, e]));

    // Check removed db.column entities
    for (const [id, baseEnt] of baseEntities.entries()) {
      if (baseEnt.kind === "db.column" && !headEntities.has(id)) {
        const tableId = `db.table:${baseEnt.attrs?.table}`;
        // If table was also removed, entity.removed(db.table) was already emitted; suppress column removed
        if (headEntities.has(tableId)) {
          // Replace any entity.removed for this column with db.field_removed
          const existingRemovedIdx = events.findIndex(
            e => e.type === "entity.removed" && e.entityId === id
          );
          const colRemovedEv = {
            type: "db.field_removed",
            entityId: id,
            kind: "db.column",
            before: `${baseEnt.attrs?.table}.${baseEnt.attrs?.name}`,
            source: baseEnt.source,
            message: `Database column '${baseEnt.attrs?.table}.${baseEnt.attrs?.name}' was removed`
          };
          if (existingRemovedIdx !== -1) {
            events[existingRemovedIdx] = colRemovedEv;
          } else {
            events.push(colRemovedEv);
          }
        } else {
          // Clean up any generic entity.removed for columns of dropped tables
          const genericIdx = events.findIndex(
            e => e.type === "entity.removed" && e.entityId === id
          );
          if (genericIdx !== -1) events.splice(genericIdx, 1);
        }
      }
    }

    // Check modified db.column entities
    for (const [id, headEnt] of headEntities.entries()) {
      if (headEnt.kind === "db.column" && baseEntities.has(id)) {
        const baseEnt = baseEntities.get(id);
        const bAttrs = baseEnt.attrs || {};
        const hAttrs = headEnt.attrs || {};
        const source = headEnt.source || baseEnt.source;

        // db.field_type_changed
        if (bAttrs.type !== hAttrs.type) {
          events.push({
            type: "db.field_type_changed",
            entityId: id,
            kind: "db.column",
            before: bAttrs.type,
            after: hAttrs.type,
            source,
            message: `Column '${hAttrs.table}.${hAttrs.name}' type changed from '${bAttrs.type}' to '${hAttrs.type}'`
          });
        }

        // db.field_made_required (optional -> required)
        if (!bAttrs.notNull && hAttrs.notNull) {
          events.push({
            type: "db.field_made_required",
            entityId: id,
            kind: "db.column",
            before: "optional",
            after: "required",
            source,
            message: `Column '${hAttrs.table}.${hAttrs.name}' was made required`
          });
        }

        // db.field_unique_added
        if (!bAttrs.unique && hAttrs.unique) {
          events.push({
            type: "db.field_unique_added",
            entityId: id,
            kind: "db.column",
            before: false,
            after: true,
            source,
            message: `Column '${hAttrs.table}.${hAttrs.name}' was made unique`
          });
        }
      }
    }
  }
}

/**
 * Recommended guardrail rules for SQL migrations.
 */
export const SQL_RECOMMENDED_RULES = [
  {
    id: "sql-no-drop-table",
    on: "sql.drop_table",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Dropping a database table is destructive and breaks running services.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-no-drop-column",
    on: "sql.drop_column",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Dropping a database column is destructive and breaks running queries.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-type-narrowed",
    on: "sql.type_narrowed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Narrowing a column type risks data truncation or migration failures.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-not-null-without-default",
    on: "sql.not_null_without_default",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Adding or setting a NOT NULL column without a DEFAULT will fail on non-empty tables.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-index-without-concurrently",
    on: "sql.index_without_concurrently",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Creating an index on an existing table without CONCURRENTLY locks the table against writes.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-no-rename",
    on: "sql.rename",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Renaming a database table or column breaks running queries during zero-downtime deploys.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-migrations-moved",
    on: "sql.migrations_moved",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Applied migration files were moved with identical content (folder move).",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "sql-no-migration-edited",
    on: "sql.migration_edited",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Previously applied migration was edited in head (migration history rewrite).",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  }
];
