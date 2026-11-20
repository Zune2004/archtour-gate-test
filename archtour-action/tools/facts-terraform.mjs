// Archtour Terraform Plan JSON Reader & Guardrails Event Extractor
// Offline parser and diff-rule evaluator for `terraform show -json plan.out` files.

export const STATEFUL_TYPES_RE = /^(?:aws_db_instance|aws_rds_cluster|google_sql_database_instance|azurerm_(?:mssql|postgresql|mysql)_.*|aws_dynamodb_table|aws_s3_bucket|google_storage_bucket|azurerm_storage_account)$/;

export function isStatefulType(type) {
  return typeof type === "string" && STATEFUL_TYPES_RE.test(type);
}

/**
 * Checks whether a file path and parsed object (or JSON string) represents a Terraform plan JSON.
 * Accepts *.json or *.tfplan.json / tfplan.json / plan.json ONLY when format_version and resource_changes match.
 */
export function isTerraformPlanJson(filePath, obj) {
  if (!filePath || typeof filePath !== "string") return false;
  if (!/\.json$/i.test(filePath)) return false;

  let parsed = obj;
  if (typeof obj === "string") {
    try {
      parsed = JSON.parse(obj);
    } catch {
      return false;
    }
  }

  return Boolean(
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    ("format_version" in parsed) &&
    Array.isArray(parsed.resource_changes)
  );
}

/**
 * Recursively masks sensitive values with "(sensitive)".
 */
function maskSensitive(val, sensitive) {
  if (val == null) return val;
  if (sensitive === true) return "(sensitive)";
  if (!sensitive || typeof sensitive !== "object") return val;

  if (Array.isArray(val)) {
    return val.map((item, idx) => {
      const s = Array.isArray(sensitive) ? sensitive[idx] : sensitive;
      return maskSensitive(item, s);
    });
  }

  if (typeof val === "object") {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = maskSensitive(v, sensitive[k]);
    }
    return res;
  }

  return val;
}

/**
 * Caps a value at 64 KB of JSON string. Larger values return { truncated: true } with values dropped.
 */
function capValue(val) {
  if (val == null) return val;
  try {
    const str = JSON.stringify(val);
    if (str && str.length > 64 * 1024) {
      return { truncated: true };
    }
  } catch {}
  return val;
}

function checkPublicIngress(resType, rawBefore, rawAfter) {
  const b = rawBefore || {};
  const a = rawAfter || {};

  // 1. aws_security_group
  if (resType === "aws_security_group") {
    const hasPublic = (val) => {
      const ing = Array.isArray(val?.ingress) ? val.ingress : (val?.ingress ? [val.ingress] : []);
      return ing.some(r => {
        const c4 = Array.isArray(r?.cidr_blocks) ? r.cidr_blocks : [];
        const c6 = Array.isArray(r?.ipv6_cidr_blocks) ? r.ipv6_cidr_blocks : [];
        return c4.includes("0.0.0.0/0") || c6.includes("::/0");
      });
    };
    return hasPublic(a) && !hasPublic(b);
  }

  // 2. aws_security_group_rule
  if (resType === "aws_security_group_rule") {
    const isIngress = (val) => typeof val?.type === "string" && val.type.toLowerCase() === "ingress";
    const hasPublic = (val) => {
      const c4 = Array.isArray(val?.cidr_blocks) ? val.cidr_blocks : [];
      const c6 = Array.isArray(val?.ipv6_cidr_blocks) ? val.ipv6_cidr_blocks : [];
      return c4.includes("0.0.0.0/0") || c6.includes("::/0");
    };
    return isIngress(a) && hasPublic(a) && !(isIngress(b) && hasPublic(b));
  }

  // 3. aws_vpc_security_group_ingress_rule
  if (resType === "aws_vpc_security_group_ingress_rule") {
    const hasPublic = (val) => val?.cidr_ipv4 === "0.0.0.0/0" || val?.cidr_ipv6 === "::/0";
    return hasPublic(a) && !hasPublic(b);
  }

  // 4. google_compute_firewall
  if (resType === "google_compute_firewall") {
    const isIngress = (val) => !val?.direction || String(val.direction).toUpperCase() === "INGRESS";
    const hasPublic = (val) => {
      const sr = Array.isArray(val?.source_ranges) ? val.source_ranges : [];
      return sr.includes("0.0.0.0/0") || sr.includes("::/0");
    };
    return isIngress(a) && hasPublic(a) && !(isIngress(b) && hasPublic(b));
  }

  // 5. azurerm_network_security_rule
  if (resType === "azurerm_network_security_rule") {
    const isIngress = (val) => !val?.direction || String(val.direction).toLowerCase() === "inbound";
    const hasPublic = (val) => {
      const prefixes = [
        ...(Array.isArray(val?.source_address_prefixes) ? val.source_address_prefixes : []),
        val?.source_address_prefix
      ].filter(Boolean);
      return prefixes.some(p => {
        const str = String(p).trim().toLowerCase();
        return str === "*" || str === "internet" || str === "0.0.0.0/0" || str === "::/0";
      });
    };
    return isIngress(a) && hasPublic(a) && !(isIngress(b) && hasPublic(b));
  }

  if (resType === "azurerm_network_security_group") {
    const hasPublic = (val) => {
      const rules = Array.isArray(val?.security_rule) ? val.security_rule : [];
      return rules.some(r => {
        const isIngress = !r?.direction || String(r.direction).toLowerCase() === "inbound";
        const prefixes = [
          ...(Array.isArray(r?.source_address_prefixes) ? r.source_address_prefixes : []),
          r?.source_address_prefix
        ].filter(Boolean);
        return isIngress && prefixes.some(p => {
          const str = String(p).trim().toLowerCase();
          return str === "*" || str === "internet" || str === "0.0.0.0/0" || str === "::/0";
        });
      });
    };
    return hasPublic(a) && !hasPublic(b);
  }

  return false;
}

function checkBucketPublic(resType, actions, rawBefore, rawAfter) {
  const b = rawBefore || {};
  const a = rawAfter || {};
  const isDelete = actions.includes("delete") && !actions.includes("create");

  // aws_s3_bucket_public_access_block
  if (resType === "aws_s3_bucket_public_access_block") {
    if (isDelete) return true;
    const flags = ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"];
    const anyFalseInAfter = flags.some(f => a[f] === false);
    if (anyFalseInAfter) return true;
    return false;
  }

  // aws_s3_bucket_acl or aws_s3_bucket with acl
  if (resType === "aws_s3_bucket_acl" || resType === "aws_s3_bucket") {
    const isPublicAcl = (val) => val?.acl === "public-read" || val?.acl === "public-read-write";
    if (isPublicAcl(a) && !isPublicAcl(b)) return true;
  }

  // google_storage_bucket_iam_*
  if (/^google_storage_bucket_iam_/.test(resType)) {
    const hasPublicMember = (val) => {
      if (val?.member === "allUsers" || val?.member === "allAuthenticatedUsers") return true;
      if (Array.isArray(val?.members) && (val.members.includes("allUsers") || val.members.includes("allAuthenticatedUsers"))) return true;
      return false;
    };
    if (hasPublicMember(a) && !hasPublicMember(b)) return true;
  }

  return false;
}

// A value that is "known after apply" (after_unknown) is not a removal.
const isUnknown = (unknown, key) => Boolean(unknown && typeof unknown === "object" && unknown[key]);

function checkEncryptionDisabled(rawBefore, rawAfter, actions, unknown) {
  const isDelete = actions.includes("delete") && !actions.includes("create");
  if (isDelete) return false;

  const b = rawBefore || {};
  const a = rawAfter || {};

  const isCreate = actions.includes("create") && !actions.includes("delete");

  if (isCreate) {
    if (a.storage_encrypted === false || a.encrypted === false) return true;
    return false;
  }

  // Update
  for (const key of ["storage_encrypted", "encrypted"]) {
    if (b[key] === true && !isUnknown(unknown, key) && (a[key] === false || a[key] == null)) return true;
  }
  if (b.kms_key_id && !isUnknown(unknown, "kms_key_id") && (a.kms_key_id == null || a.kms_key_id === "" || a.kms_key_id === false)) {
    return true;
  }

  return false;
}

function checkDeletionProtectionDisabled(rawBefore, rawAfter, actions, unknown) {
  const isDelete = actions.includes("delete") && !actions.includes("create");
  if (isDelete) return false;

  const b = rawBefore || {};
  const a = rawAfter || {};

  if (b.deletion_protection === true && !isUnknown(unknown, "deletion_protection") &&
      (a.deletion_protection === false || a.deletion_protection == null)) {
    return true;
  }
  return false;
}

function checkIamWildcard(resType, rawAfter, actions) {
  const isDelete = actions.includes("delete") && !actions.includes("create");
  if (isDelete) return false;

  const iamTypes = new Set([
    "aws_iam_policy",
    "aws_iam_role_policy",
    "aws_iam_user_policy",
    "aws_iam_group_policy",
    "aws_iam_policy_document"
  ]);
  if (!iamTypes.has(resType)) return false;

  const a = rawAfter || {};
  const rawPolicy = a.policy || a.json;
  if (!rawPolicy) return false;

  let policyDoc;
  if (typeof rawPolicy === "object" && rawPolicy !== null) {
    policyDoc = rawPolicy;
  } else if (typeof rawPolicy === "string") {
    try {
      policyDoc = JSON.parse(rawPolicy);
    } catch {
      // tolerate invalid JSON -> no event
      return false;
    }
  } else {
    return false;
  }

  if (!policyDoc || typeof policyDoc !== "object") return false;

  const statements = Array.isArray(policyDoc.Statement)
    ? policyDoc.Statement
    : (policyDoc.Statement && typeof policyDoc.Statement === "object" ? [policyDoc.Statement] : []);

  for (const stmt of statements) {
    if (!stmt || typeof stmt !== "object") continue;
    const effect = String(stmt.Effect || "").trim().toLowerCase();
    if (effect !== "allow") continue;

    const actionList = Array.isArray(stmt.Action) ? stmt.Action : (stmt.Action ? [stmt.Action] : []);
    const resourceList = Array.isArray(stmt.Resource) ? stmt.Resource : (stmt.Resource ? [stmt.Resource] : []);

    const actionsText = actionList.map(act => String(act).trim());
    const allActions = actionsText.includes("*");
    const wholeService = actionsText.some(act => /^[a-z0-9-]+:\*$/i.test(act));
    const allResources = resourceList.some(res => String(res).trim() === "*");

    // Action "*" = admin; "service:*" on Resource "*" = a whole service on everything. Resource "*" with specific actions
    // (ec2:Describe*, logs:CreateLogGroup) is normal and not flagged.
    if (allActions || (wholeService && allResources)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts facts and events from a Terraform plan JSON file.
 */
export function parseTerraformPlanFacts(filePath, content, getStableId, entities, relations, errors, parseErrors) {
  let doc = null;
  if (typeof content === "object" && content !== null) {
    doc = content;
  } else if (typeof content === "string") {
    try {
      doc = JSON.parse(content);
    } catch (err) {
      const errEntry = {
        file: filePath,
        path: filePath,
        line: 1,
        error: err.message,
        message: `Failed to parse Terraform plan JSON in ${filePath}: ${err.message}`
      };
      errors.push(errEntry);
      if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
      return false;
    }
  }

  // Not a plan (the file name alone never makes a plan: an app's own plan.json is not one)
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.resource_changes)) return false;

  const fileEvents = [];
  const resourceSource = { file: filePath, line: 1 };

  for (const rc of doc.resource_changes) {
    if (!rc || typeof rc !== "object") continue;
    const address = String(rc.address || "").trim();
    if (!address) continue;

    const resType = String(rc.type || "").trim();
    const provider = String(rc.provider_name || rc.provider || "").trim();
    const isStateful = isStatefulType(resType);

    const change = rc.change || {};
    const actions = Array.isArray(change.actions) ? change.actions : [];

    // Mask sensitive fields
    const rawBefore = maskSensitive(change.before, change.before_sensitive);
    const rawAfter = maskSensitive(change.after, change.after_sensitive);

    // 1. tf.resource_deleted & tf.resource_replaced
    const isDelete = actions.includes("delete") && !actions.includes("create");
    const isReplace = actions.includes("delete") && actions.includes("create");

    const resourceId = getStableId ? getStableId("tf.resource", address, resourceSource) : `tf.resource:${address}`;

    // Cap before and after for entity attributes
    const beforeVal = capValue(rawBefore);
    const afterVal = capValue(rawAfter);

    entities.push({
      kind: "tf.resource",
      id: resourceId,
      name: address,
      source: resourceSource,
      attrs: {
        address,
        type: resType,
        provider,
        actions,
        before: beforeVal,
        after: afterVal,
        stateful: isStateful
      }
    });

    if (isDelete) {
      const statefulNote = isStateful ? " (stateful resource: data loss risk)" : "";
      fileEvents.push({
        type: "tf.resource_deleted",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        stateful: isStateful,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Terraform ${isStateful ? "stateful " : ""}resource '${address}' was deleted${statefulNote}`
      });
    } else if (isReplace) {
      const statefulNote = isStateful ? " (stateful resource: data loss risk)" : "";
      fileEvents.push({
        type: "tf.resource_replaced",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        stateful: isStateful,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Terraform ${isStateful ? "stateful " : ""}resource '${address}' was replaced${statefulNote}`
      });
    }

    // 2. tf.public_ingress_added
    if (checkPublicIngress(resType, rawBefore, rawAfter)) {
      fileEvents.push({
        type: "tf.public_ingress_added",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Public ingress to 0.0.0.0/0 or ::/0 added in '${address}'`
      });
    }

    // 3. tf.bucket_public
    if (checkBucketPublic(resType, actions, rawBefore, rawAfter)) {
      fileEvents.push({
        type: "tf.bucket_public",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Public bucket access enabled in '${address}'`
      });
    }

    // 4. tf.encryption_disabled
    if (checkEncryptionDisabled(rawBefore, rawAfter, actions, change.after_unknown)) {
      fileEvents.push({
        type: "tf.encryption_disabled",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Encryption disabled in '${address}'`
      });
    }

    // 5. tf.deletion_protection_disabled
    if (checkDeletionProtectionDisabled(rawBefore, rawAfter, actions, change.after_unknown)) {
      fileEvents.push({
        type: "tf.deletion_protection_disabled",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `Deletion protection disabled in '${address}'`
      });
    }

    // 6. tf.iam_wildcard
    if (checkIamWildcard(resType, rawAfter, actions)) {
      fileEvents.push({
        type: "tf.iam_wildcard",
        entityId: resourceId,
        kind: "tf.resource",
        address,
        resourceType: resType,
        before: beforeVal,
        after: afterVal,
        source: resourceSource,
        message: `IAM policy '${address}' allows every action ("*") or a whole service ("svc:*") on every resource`
      });
    }
  }

  return { events: fileEvents };
}

/**
 * Passes through events of plan files present in head whose content differs from base (or that are new).
 */
export function diffTerraformFacts(base = {}, head = {}, events = []) {
  const normPath = p => (p || "").replace(/\\/g, "/");
  const baseSources = (base.sources || []).filter(s => s.kind === "Terraform");
  const headSources = (head.sources || []).filter(s => s.kind === "Terraform");

  const baseMap = new Map(baseSources.map(s => [normPath(s.path), s]));

  for (const headSrc of headSources) {
    const baseSrc = baseMap.get(normPath(headSrc.path));
    if (baseSrc && baseSrc.content === headSrc.content) {
      continue;
    }
    for (const ev of headSrc.events || []) {
      events.push(ev);
    }
  }
}

/**
 * Built-in guardrail rules for Terraform plans.
 */
export const TERRAFORM_RULES = [
  {
    id: "tf-stateful-resource-deleted",
    on: "tf.resource_deleted",
    where: { stateful: "true" },
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Deleting a stateful resource causes permanent data loss.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-stateful-resource-replaced",
    on: "tf.resource_replaced",
    where: { stateful: "true" },
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Replacing a stateful resource recreates it and risks data loss.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-resource-deleted",
    on: "tf.resource_deleted",
    where: { stateful: "!true" },
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Terraform resource was deleted.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-public-ingress-added",
    on: "tf.public_ingress_added",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Security group or firewall rule opens public ingress (0.0.0.0/0 or ::/0).",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-bucket-public",
    on: "tf.bucket_public",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Storage bucket public access restrictions disabled or public ACL granted.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-encryption-disabled",
    on: "tf.encryption_disabled",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Resource encryption was disabled.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-deletion-protection-disabled",
    on: "tf.deletion_protection_disabled",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Deletion protection was disabled for resource.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  },
  {
    id: "tf-iam-wildcard",
    on: "tf.iam_wildcard",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "IAM policy allows every action, or a whole service on every resource.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#terraform"
  }
];
