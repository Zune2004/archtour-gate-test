import {
  Source,
  parse,
  buildASTSchema,
  buildSchema,
  concatAST,
  findBreakingChanges,
  findDangerousChanges,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isInputObjectType,
  isScalarType,
  isNonNullType,
  printSchema,
  Kind
} from "graphql";
import path from "node:path";

const STANDARD_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

export function isGraphQLFile(filePath) {
  const base = path.basename(filePath);
  return /\.(?:graphql|gql|graphqls)$/i.test(base);
}

/**
 * Parses GraphQL SDL files in a single directory into a unified schema facts representation.
 * Concatenates files in path order.
 * Files that fail alone are reported with a parse error.
 */
export function parseGraphQLFacts(filesInDir, dirPath, getStableId, entities, relations, errors, parseErrors) {
  if (!filesInDir || filesInDir.length === 0) return null;

  // Sort files in path order
  const sortedFiles = [...filesInDir].sort((a, b) => (a.path || "").localeCompare(b.path || ""));

  const parsedDocs = [];
  let hasSoloError = false;

  // 1. Verify each file parses alone (detecting syntax errors on individual files)
  //    Then drop executable definitions (query/mutation/subscription/fragment) so that
  //    client operation files are not treated as schema definitions.
  for (const f of sortedFiles) {
    const filePath = f.path || "unknown";
    const content = typeof f.content === "string" ? f.content.replace(/^\uFEFF/, "") : "";
    try {
      const source = new Source(content, filePath);
      const doc = parse(source);
      // Drop operation and fragment definitions; keep type-system definitions only.
      if (doc && doc.definitions) {
        doc.definitions = doc.definitions.filter(
          (d) => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION
        );
      }
      // A file with no definitions left is not part of the schema.
      if (doc && doc.definitions && doc.definitions.length > 0) {
        parsedDocs.push(doc);
      }
    } catch (err) {
      hasSoloError = true;
      const line = err.locations?.[0]?.line || 1;
      const errEntry = {
        file: filePath,
        path: filePath,
        line,
        error: err.message,
        message: `GraphQL parse error in ${filePath}: ${err.message}`
      };
      errors.push(errEntry);
      parseErrors.push(errEntry);
    }
  }

  if (hasSoloError) {
    return { dir: dirPath, schema: null, error: "One or more GraphQL files failed to parse" };
  }

  // If no file had type-system definitions, this folder is not a schema folder.
  if (parsedDocs.length === 0) {
    return null;
  }

  // 2. Concatenate AST documents and build schema
  let unifiedDoc;
  try {
    unifiedDoc = concatAST(parsedDocs);
  } catch (err) {
    const firstPath = sortedFiles[0]?.path || dirPath;
    const errEntry = {
      file: firstPath,
      path: firstPath,
      error: err.message,
      message: `GraphQL AST concatenation error in ${dirPath}: ${err.message}`
    };
    errors.push(errEntry);
    parseErrors.push(errEntry);
    return { dir: dirPath, schema: null, error: err.message };
  }

  let schema;
  try {
    schema = buildASTSchema(unifiedDoc);
  } catch (err) {
    const firstPath = sortedFiles[0]?.path || dirPath;
    const errEntry = {
      file: firstPath,
      path: firstPath,
      error: err.message,
      message: `GraphQL schema build error in ${dirPath}: ${err.message}`
    };
    errors.push(errEntry);
    parseErrors.push(errEntry);
    return { dir: dirPath, schema: null, error: err.message };
  }

  // 3. Extract facts: gql.type {name, kind}, gql.field {type, name, returnType, args [{name, type, required}]}
  const typeMap = schema.getTypeMap();

  for (const [typeName, type] of Object.entries(typeMap)) {
    // Filter out internal introspection types (__*) and built-in standard scalars without user astNode
    if (typeName.startsWith("__")) continue;
    if (STANDARD_SCALARS.has(typeName) && !type.astNode) continue;

    let kind = "OBJECT";
    if (isObjectType(type)) kind = "OBJECT";
    else if (isInterfaceType(type)) kind = "INTERFACE";
    else if (isUnionType(type)) kind = "UNION";
    else if (isEnumType(type)) kind = "ENUM";
    else if (isInputObjectType(type)) kind = "INPUT_OBJECT";
    else if (isScalarType(type)) kind = "SCALAR";

    const astNode = type.astNode;
    const sourceFile = astNode?.loc?.source?.name || sortedFiles[0]?.path || dirPath;
    const sourceLine = astNode?.loc?.startToken?.line || 1;
    const source = { file: sourceFile, line: sourceLine };

    const typeId = getStableId("gql.type", typeName, source);
    entities.push({
      kind: "gql.type",
      id: typeId,
      name: typeName,
      source,
      attrs: {
        name: typeName,
        kind
      }
    });

    // Extract fields
    if (isObjectType(type) || isInterfaceType(type)) {
      const fieldMap = type.getFields();
      for (const [fieldName, fieldDef] of Object.entries(fieldMap)) {
        const fNode = fieldDef.astNode;
        const fSourceFile = fNode?.loc?.source?.name || sourceFile;
        const fSourceLine = fNode?.loc?.startToken?.line || sourceLine;
        const fSource = { file: fSourceFile, line: fSourceLine };

        const fieldId = getStableId("gql.field", `${typeName}.${fieldName}`, fSource);
        const args = (fieldDef.args || []).map(arg => ({
          name: arg.name,
          type: arg.type.toString(),
          required: isNonNullType(arg.type) && arg.defaultValue === undefined
        }));

        entities.push({
          kind: "gql.field",
          id: fieldId,
          name: fieldName,
          source: fSource,
          attrs: {
            type: typeName,
            name: fieldName,
            returnType: fieldDef.type.toString(),
            args
          }
        });
      }
    } else if (isInputObjectType(type)) {
      const fieldMap = type.getFields();
      for (const [fieldName, fieldDef] of Object.entries(fieldMap)) {
        const fNode = fieldDef.astNode;
        const fSourceFile = fNode?.loc?.source?.name || sourceFile;
        const fSourceLine = fNode?.loc?.startToken?.line || sourceLine;
        const fSource = { file: fSourceFile, line: fSourceLine };

        const fieldId = getStableId("gql.field", `${typeName}.${fieldName}`, fSource);
        entities.push({
          kind: "gql.field",
          id: fieldId,
          name: fieldName,
          source: fSource,
          attrs: {
            type: typeName,
            name: fieldName,
            returnType: fieldDef.type.toString(),
            args: []
          }
        });
      }
    }
  }

  let sdl = "";
  try {
    sdl = printSchema(schema);
  } catch {}

  return {
    dir: dirPath,
    schema,
    sdl,
    files: sortedFiles.map(f => f.path)
  };
}

function isStandardScalarChange(c) {
  if (c.type === "TYPE_REMOVED") {
    for (const s of STANDARD_SCALARS) {
      if (c.description.includes(`scalar ${s}`) || c.description.includes(`Standard scalar ${s}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Computes GraphQL schema diffs between base and head.
 * Emits `gql.breaking` and `gql.dangerous` changes from graphql-js.
 */
function emitGraphQLEvents(baseSchema, headSchema, dir, events, baseEntities, headEntities) {
  let breaking = [];
  let dangerous = [];
  try {
    breaking = findBreakingChanges(baseSchema, headSchema);
  } catch {}
  try {
    dangerous = findDangerousChanges(baseSchema, headSchema);
  } catch {}

  const filteredBreaking = breaking.filter(c => !isStandardScalarChange(c));
  const filteredDangerous = dangerous.filter(c => !isStandardScalarChange(c));

  for (const c of filteredBreaking) {
    let entityId = `gql.schema:${dir}`;
    let source = null;

    const fieldMatch = c.description.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\b/);
    if (fieldMatch) {
      const fid = `gql.field:${fieldMatch[1]}.${fieldMatch[2]}`;
      const ent = baseEntities.get(fid) || headEntities.get(fid);
      if (ent) {
        entityId = ent.id;
        source = ent.source;
      } else {
        entityId = fid;
      }
    } else {
      const typeMatch = c.description.match(/^([A-Za-z0-9_]+)\b/);
      if (typeMatch) {
        const tid = `gql.type:${typeMatch[1]}`;
        const ent = baseEntities.get(tid) || headEntities.get(tid);
        if (ent) {
          entityId = ent.id;
          source = ent.source;
        } else {
          entityId = tid;
        }
      }
    }

    events.push({
      type: "gql.breaking",
      changeType: c.type,
      description: c.description,
      entityId,
      source,
      message: c.description
    });
  }

  for (const c of filteredDangerous) {
    let entityId = `gql.schema:${dir}`;
    let source = null;

    const fieldMatch = c.description.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\b/);
    if (fieldMatch) {
      const fid = `gql.field:${fieldMatch[1]}.${fieldMatch[2]}`;
      const ent = headEntities.get(fid) || baseEntities.get(fid);
      if (ent) {
        entityId = ent.id;
        source = ent.source;
      } else {
        entityId = fid;
      }
    } else {
      const typeMatch = c.description.match(/^([A-Za-z0-9_]+)\b/);
      if (typeMatch) {
        const tid = `gql.type:${typeMatch[1]}`;
        const ent = headEntities.get(tid) || baseEntities.get(tid);
        if (ent) {
          entityId = ent.id;
          source = ent.source;
        } else {
          entityId = tid;
        }
      }
    }

    events.push({
      type: "gql.dangerous",
      changeType: c.type,
      description: c.description,
      entityId,
      source,
      message: c.description
    });
  }
}

export function diffGraphQL(base = {}, head = {}, baseEntities = new Map(), headEntities = new Map()) {
  const events = [];

  const baseSchemas = base._graphqlSchemas || [];
  const headSchemas = head._graphqlSchemas || [];

  const baseDirs = new Set(baseSchemas.map(s => s.dir));
  const headDirs = new Set(headSchemas.map(s => s.dir));
  const allDirs = new Set([...baseDirs, ...headDirs]);
  const usedHeadDirs = new Set();

  for (const dir of allDirs) {
    const baseEntry = baseSchemas.find(s => s.dir === dir);
    const headEntry = headSchemas.find(s => s.dir === dir);

    if (baseEntry?.sdl && (!baseEntry.schema || typeof baseEntry.schema.getTypeMap !== "function")) {
      try {
        baseEntry.schema = buildSchema(baseEntry.sdl);
      } catch {}
    }
    if (headEntry?.sdl && (!headEntry.schema || typeof headEntry.schema.getTypeMap !== "function")) {
      try {
        headEntry.schema = buildSchema(headEntry.sdl);
      } catch {}
    }

    // If base or head failed to build in this directory, do not compute breaking/dangerous changes
    if (baseEntry && !baseEntry.schema) continue;
    if (headEntry && !headEntry.schema) continue;

    // If both schemas are present, run findBreakingChanges and findDangerousChanges
    if (baseEntry?.schema && headEntry?.schema) {
      emitGraphQLEvents(baseEntry.schema, headEntry.schema, dir, events, baseEntities, headEntities);
      usedHeadDirs.add(dir);
    }
  }

  // Handle deleted GraphQL schemas: base folder with no head entry
  // Build comparison target from new head folders (in head but not in base)
  for (const dir of baseDirs) {
    if (headDirs.has(dir)) continue; // already handled above (or no head entry)
    if (!baseSchemas.some(s => s.dir === dir)) continue;
    const baseEntry = baseSchemas.find(s => s.dir === dir);
    if (!baseEntry?.schema) continue;

    // Find new head folders not in base
    const newHeadDirs = [...headDirs].filter(d => !baseDirs.has(d) && !usedHeadDirs.has(d));
    let targetSchema = null;

    if (newHeadDirs.length > 0) {
      // Merge SDL from new head folders
      const sdls = [];
      for (const newDir of newHeadDirs) {
        const newEntry = headSchemas.find(s => s.dir === newDir);
        if (newEntry && newEntry.sdl) {
          sdls.push(newEntry.sdl);
          usedHeadDirs.add(newDir);
        }
      }
      if (sdls.length > 0) {
        const mergedSdl = sdls.join("\n");
        try {
          targetSchema = buildSchema(mergedSdl);
        } catch {}
      }
    }

    if (!targetSchema) {
      // Use empty schema placeholder
      try {
        targetSchema = buildSchema("type Query { _archtourEmpty: Boolean }");
      } catch {}
    }

    if (targetSchema) {
      emitGraphQLEvents(baseEntry.schema, targetSchema, dir, events, baseEntities, headEntities);
    }
  }

  return events;
}
