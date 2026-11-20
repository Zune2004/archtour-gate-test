import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDevComposeFile } from "./facts.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

let CACHE_VERSION = "0.1.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, "..", "package.json"), "utf8"));
  if (pkg.version) CACHE_VERSION = pkg.version;
} catch {}

export { CACHE_VERSION };

/**
 * Computes the Git blob SHA-1 for a string or Buffer.
 * Git blobs are formatted as: "blob <length>\0<content>"
 */
export function computeBlobSha(content) {
  if (content == null) return null;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export class FactsCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir ? path.resolve(cacheDir) : null;
    this.memoryCache = new Map();
  }

  get(sha, targetPath = null) {
    if (!sha) return null;
    let entry = this.memoryCache.get(sha);

    if (!entry && this.cacheDir) {
      const filePath = path.join(this.cacheDir, `${sha}.json`);
      if (fs.existsSync(filePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
          if (raw && raw.version === CACHE_VERSION && raw.facts) {
            entry = raw;
            this.memoryCache.set(sha, entry);
          }
        } catch {
          // Corrupted or invalid JSON -> treat as miss
        }
      }
    }

    if (!entry) return null;
    const facts = entry.facts;
    if (!targetPath) return facts;

    const normTarget = targetPath.replace(/\\/g, "/");
    const cachedPath = facts.sources?.[0]?.path;
    if (!cachedPath || cachedPath === normTarget) {
      return facts;
    }

    const isDev = isDevComposeFile(normTarget);
    return {
      entities: (facts.entities || []).map(e => ({
        ...e,
        id: (e.kind === "service" && isDev) ? `service:${e.name}@${normTarget}` : e.id,
        source: e.source ? { ...e.source, file: normTarget } : { file: normTarget }
      })),
      relations: (facts.relations || []).map(r => ({ ...r })),
      sources: (facts.sources || []).map(s => ({ ...s, path: normTarget })),
      errors: (facts.errors || []).map(err => ({ ...err, file: normTarget, path: normTarget })),
      parseErrors: (facts.parseErrors || []).map(err => ({ ...err, file: normTarget, path: normTarget }))
    };
  }

  set(sha, facts) {
    if (!sha || !facts) return;
    const entry = {
      version: CACHE_VERSION,
      sha,
      facts
    };
    this.memoryCache.set(sha, entry);

    if (this.cacheDir) {
      try {
        if (!fs.existsSync(this.cacheDir)) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        fs.writeFileSync(path.join(this.cacheDir, `${sha}.json`), JSON.stringify(entry));
      } catch {
        // Silently ignore cache write errors (e.g. read-only disk)
      }
    }
  }

  has(sha) {
    if (!sha) return false;
    if (this.memoryCache.has(sha)) return true;
    if (this.cacheDir) {
      return fs.existsSync(path.join(this.cacheDir, `${sha}.json`));
    }
    return false;
  }
}
