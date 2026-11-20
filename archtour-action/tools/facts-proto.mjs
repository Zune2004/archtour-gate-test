import path from "node:path";

export function isProtoFile(filePath) {
  const base = path.basename(filePath);
  return /\.proto$/i.test(base);
}

/**
 * Dependency-free tokenizer for proto2 and proto3 files.
 * Ignores comments (including multi-line with braces inside) and options safely.
 */
function tokenizeProto(content) {
  const tokens = [];
  let pos = 0;
  let line = 1;
  const len = content.length;

  while (pos < len) {
    const ch = content[pos];

    // Newlines
    if (ch === "\n") {
      line++;
      pos++;
      continue;
    }
    if (ch === "\r") {
      pos++;
      continue;
    }

    // Whitespace
    if (ch === " " || ch === "\t") {
      pos++;
      continue;
    }

    // Single-line comment //
    if (ch === "/" && content[pos + 1] === "/") {
      pos += 2;
      while (pos < len && content[pos] !== "\n") {
        pos++;
      }
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === "/" && content[pos + 1] === "*") {
      pos += 2;
      while (pos < len) {
        if (content[pos] === "\n") {
          line++;
        } else if (content[pos] === "*" && content[pos + 1] === "/") {
          pos += 2;
          break;
        }
        pos++;
      }
      continue;
    }

    // String literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const tokenLine = line;
      let str = "";
      pos++;
      while (pos < len) {
        const c = content[pos];
        if (c === "\n") line++;
        if (c === "\\") {
          pos++;
          if (pos < len) {
            str += content[pos];
            pos++;
          }
          continue;
        }
        if (c === quote) {
          pos++;
          break;
        }
        str += c;
        pos++;
      }
      tokens.push({ type: "string", value: str, line: tokenLine });
      continue;
    }

    // Punctuation
    if ("{}[];,=()<>".includes(ch)) {
      tokens.push({ type: "punct", value: ch, line });
      pos++;
      continue;
    }

    // Identifiers, keywords, numbers (including negative numbers or dotted names)
    const start = pos;
    while (pos < len) {
      const c = content[pos];
      if (" \t\r\n{}[];,=()<>\"'/".includes(c)) break;
      pos++;
    }
    const val = content.slice(start, pos);
    tokens.push({ type: "ident", value: val, line });
  }

  return tokens;
}

/**
 * Dependency-free proto2/proto3 AST parser.
 */
function parseProtoTokens(tokens, filePath) {
  let idx = 0;
  const len = tokens.length;

  function peek(offset = 0) {
    return tokens[idx + offset] || { type: "eof", value: "", line: 1 };
  }

  function consume(val) {
    const t = peek();
    if (val !== undefined && t.value !== val) {
      return null;
    }
    idx++;
    return t;
  }

  function skipOption() {
    // Skips option statements until matching ';' while tracking balanced braces and brackets
    let braceDepth = 0;
    let bracketDepth = 0;
    while (idx < len) {
      const t = tokens[idx++];
      if (t.value === "{") braceDepth++;
      else if (t.value === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (t.value === "[") bracketDepth++;
      else if (t.value === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (t.value === ";" && braceDepth === 0 && bracketDepth === 0) {
        break;
      }
    }
  }

  function skipBrackets() {
    let depth = 1;
    while (idx < len && depth > 0) {
      const t = tokens[idx++];
      if (t.value === "[") depth++;
      else if (t.value === "]") depth--;
    }
  }

  function parseReserved() {
    const numbers = [];
    const names = [];
    // reserved 1, 2, 9 to 11; OR reserved "foo", "bar";
    while (idx < len) {
      const t = tokens[idx++];
      if (t.value === ";") break;
      if (t.value === ",") continue;

      if (t.type === "string") {
        names.push(t.value);
        continue;
      }

      const num = parseInt(t.value, 10);
      if (!isNaN(num)) {
        if (peek().value === "to") {
          idx++; // consume 'to'
          const nextT = tokens[idx++];
          const endNum = parseInt(nextT.value, 10);
          if (!isNaN(endNum)) {
            for (let n = num; n <= endNum; n++) {
              numbers.push(n);
            }
          } else {
            numbers.push(num);
          }
        } else {
          numbers.push(num);
        }
      } else if (t.type === "ident") {
        names.push(t.value);
      }
    }
    return { numbers, names };
  }

  let syntax = "proto2";
  let pkg = "";
  let packageLine = 1;
  const imports = [];
  const messages = [];
  const enums = [];
  const services = [];

  function parseEnum(parentFullName = "") {
    const enumToken = tokens[idx++]; // 'enum'
    const nameToken = tokens[idx++];
    const enumName = nameToken ? nameToken.value : "UnknownEnum";
    const enumLine = enumToken.line;
    const fullEnumName = parentFullName ? `${parentFullName}.${enumName}` : (pkg ? `${pkg}.${enumName}` : enumName);

    consume("{");
    const values = [];
    const reservedNumbers = [];
    const reservedNames = [];

    while (idx < len) {
      const t = peek();
      if (t.value === "}") {
        idx++;
        break;
      }
      if (t.value === ";") {
        idx++;
        continue;
      }
      if (t.value === "option") {
        idx++;
        skipOption();
        continue;
      }
      if (t.value === "reserved") {
        idx++;
        const res = parseReserved();
        reservedNumbers.push(...res.numbers);
        reservedNames.push(...res.names);
        continue;
      }

      // Value definition: NAME = NUMBER [options];
      const valNameToken = tokens[idx++];
      if (peek().value === "=") {
        idx++; // consume '='
        const numToken = tokens[idx++];
        let numVal = 0;
        if (numToken.value === "-" && peek().type === "ident") {
          const actualNum = tokens[idx++];
          numVal = -parseInt(actualNum.value, 10);
        } else {
          numVal = parseInt(numToken.value, 10);
        }
        if (peek().value === "[") {
          idx++;
          skipBrackets();
        }
        if (peek().value === ";") idx++;
        values.push({
          name: valNameToken.value,
          number: numVal,
          line: valNameToken.line
        });
      }
    }

    const enm = {
      name: enumName,
      fullName: fullEnumName,
      line: enumLine,
      values,
      reservedNumbers,
      reservedNames
    };
    enums.push(enm);
    return enm;
  }

  function parseMessage(parentFullName = "") {
    const msgToken = tokens[idx++]; // 'message'
    const nameToken = tokens[idx++];
    const msgName = nameToken ? nameToken.value : "UnknownMessage";
    const msgLine = msgToken.line;
    const fullMsgName = parentFullName ? `${parentFullName}.${msgName}` : (pkg ? `${pkg}.${msgName}` : msgName);

    consume("{");
    const fields = [];
    const reservedNumbers = [];
    const reservedNames = [];
    const nestedMessages = [];
    const nestedEnums = [];

    while (idx < len) {
      const t = peek();
      if (t.value === "}") {
        idx++;
        break;
      }
      if (t.value === ";") {
        idx++;
        continue;
      }

      // Nested message
      if (t.value === "message") {
        const subMsg = parseMessage(fullMsgName);
        nestedMessages.push(subMsg);
        continue;
      }

      // Nested enum
      if (t.value === "enum") {
        const subEnum = parseEnum(fullMsgName);
        nestedEnums.push(subEnum);
        continue;
      }

      // reserved
      if (t.value === "reserved") {
        idx++;
        const res = parseReserved();
        reservedNumbers.push(...res.numbers);
        reservedNames.push(...res.names);
        continue;
      }

      // extensions / option
      if (t.value === "extensions" || t.value === "option") {
        idx++;
        skipOption();
        continue;
      }

      // oneof
      if (t.value === "oneof") {
        const oneofToken = tokens[idx++]; // 'oneof'
        const oneofNameToken = tokens[idx++];
        const oneofName = oneofNameToken ? oneofNameToken.value : "unknown_oneof";
        consume("{");
        while (idx < len) {
          const ot = peek();
          if (ot.value === "}") {
            idx++;
            break;
          }
          if (ot.value === ";") {
            idx++;
            continue;
          }
          if (ot.value === "option") {
            idx++;
            skipOption();
            continue;
          }

          // Field inside oneof: type name = number [options];
          let fType = tokens[idx++].value;
          if (peek().value === "<") {
            // e.g. map<k, v>
            idx++;
            const k = tokens[idx++].value;
            consume(",");
            const v = tokens[idx++].value;
            consume(">");
            fType = `map<${k}, ${v}>`;
          }
          const fNameToken = tokens[idx++];
          consume("=");
          const fNumToken = tokens[idx++];
          const fNumber = parseInt(fNumToken ? fNumToken.value : "0", 10);
          if (peek().value === "[") {
            idx++;
            skipBrackets();
          }
          if (peek().value === ";") idx++;
          fields.push({
            name: fNameToken ? fNameToken.value : "",
            number: fNumber,
            type: fType,
            label: null,
            oneof: oneofName,
            line: fNameToken ? fNameToken.line : oneofToken.line
          });
        }
        continue;
      }

      // Normal field: [label] type name = number [options];
      let label = null;
      if (["optional", "required", "repeated"].includes(t.value)) {
        label = tokens[idx++].value;
      }

      let fType = tokens[idx++].value;
      if (peek().value === "<") {
        idx++;
        const k = tokens[idx++].value;
        consume(",");
        const v = tokens[idx++].value;
        consume(">");
        fType = `map<${k}, ${v}>`;
      }

      const fNameToken = tokens[idx++];
      consume("=");
      const fNumToken = tokens[idx++];
      const fNumber = parseInt(fNumToken ? fNumToken.value : "0", 10);

      if (peek().value === "[") {
        idx++;
        skipBrackets();
      }
      if (peek().value === ";") idx++;

      fields.push({
        name: fNameToken ? fNameToken.value : "",
        number: fNumber,
        type: fType,
        label,
        oneof: null,
        line: fNameToken ? fNameToken.line : t.line
      });
    }

    const msg = {
      name: msgName,
      fullName: fullMsgName,
      line: msgLine,
      fields,
      reservedNumbers,
      reservedNames,
      nestedMessages,
      nestedEnums
    };
    messages.push(msg);
    return msg;
  }

  function parseService() {
    const svcToken = tokens[idx++]; // 'service'
    const nameToken = tokens[idx++];
    const svcName = nameToken ? nameToken.value : "UnknownService";
    const svcLine = svcToken.line;
    const fullSvcName = pkg ? `${pkg}.${svcName}` : svcName;

    consume("{");
    const rpcs = [];

    while (idx < len) {
      const t = peek();
      if (t.value === "}") {
        idx++;
        break;
      }
      if (t.value === ";") {
        idx++;
        continue;
      }
      if (t.value === "option") {
        idx++;
        skipOption();
        continue;
      }

      if (t.value === "rpc") {
        const rpcToken = tokens[idx++]; // 'rpc'
        const rpcName = tokens[idx++].value;
        consume("(");
        let clientStreaming = false;
        if (peek().value === "stream") {
          clientStreaming = true;
          idx++;
        }
        const reqType = tokens[idx++].value;
        consume(")");

        consume("returns");
        consume("(");
        let serverStreaming = false;
        if (peek().value === "stream") {
          serverStreaming = true;
          idx++;
        }
        const resType = tokens[idx++].value;
        consume(")");

        if (peek().value === "{") {
          idx++;
          while (idx < len && peek().value !== "}") {
            skipOption();
          }
          consume("}");
        } else if (peek().value === ";") {
          idx++;
        }

        rpcs.push({
          name: rpcName,
          request: reqType,
          response: resType,
          clientStreaming,
          serverStreaming,
          line: rpcToken.line
        });
      } else {
        idx++;
      }
    }

    const svc = {
      name: svcName,
      fullName: fullSvcName,
      line: svcLine,
      rpcs
    };
    services.push(svc);
    return svc;
  }

  // Top-level loop
  while (idx < len) {
    const t = peek();
    if (t.type === "eof") break;

    if (t.value === ";") {
      idx++;
      continue;
    }

    if (t.value === "syntax") {
      idx++;
      consume("=");
      const synToken = tokens[idx++];
      syntax = synToken ? synToken.value : "proto2";
      consume(";");
      continue;
    }

    if (t.value === "package") {
      packageLine = t.line;
      idx++;
      let pParts = [];
      while (idx < len && peek().value !== ";") {
        pParts.push(tokens[idx++].value);
      }
      pkg = pParts.join("");
      consume(";");
      continue;
    }

    if (t.value === "import") {
      idx++;
      if (peek().value === "public" || peek().value === "weak") {
        idx++;
      }
      const impToken = tokens[idx++];
      if (impToken) imports.push(impToken.value);
      consume(";");
      continue;
    }

    if (t.value === "option") {
      idx++;
      skipOption();
      continue;
    }

    if (t.value === "message") {
      parseMessage();
      continue;
    }

    if (t.value === "enum") {
      parseEnum();
      continue;
    }

    if (t.value === "service") {
      parseService();
      continue;
    }

    // Skip unknown token
    idx++;
  }

  return {
    syntax,
    package: pkg,
    packageLine,
    imports,
    messages,
    enums,
    services
  };
}

/**
 * Extracts facts from a protobuf file.
 */
export function parseProtoFacts(filePath, content, getStableId, entities, relations, errors, parseErrors) {
  let tokens;
  try {
    tokens = tokenizeProto(content);
  } catch (err) {
    const errEntry = {
      file: filePath,
      path: filePath,
      error: err.message,
      message: `Failed to tokenize Protobuf in ${filePath}: ${err.message}`
    };
    errors.push(errEntry);
    parseErrors.push(errEntry);
    return null;
  }

  let ast;
  try {
    ast = parseProtoTokens(tokens, filePath);
  } catch (err) {
    const errEntry = {
      file: filePath,
      path: filePath,
      error: err.message,
      message: `Failed to parse Protobuf in ${filePath}: ${err.message}`
    };
    errors.push(errEntry);
    parseErrors.push(errEntry);
    return null;
  }

  const pkg = ast.package || "";

  // 1. Package entity
  if (pkg) {
    const pSource = { file: filePath, line: ast.packageLine || 1 };
    const pId = getStableId("proto.package", pkg, pSource);
    entities.push({
      kind: "proto.package",
      id: pId,
      name: pkg,
      source: pSource,
      attrs: {
        name: pkg
      }
    });
  }

  // 2. Message and field entities
  for (const msg of ast.messages) {
    const mSource = { file: filePath, line: msg.line };
    const mId = getStableId("proto.message", msg.fullName, mSource);

    entities.push({
      kind: "proto.message",
      id: mId,
      name: msg.fullName,
      source: mSource,
      attrs: {
        package: pkg,
        name: msg.name,
        fullName: msg.fullName,
        reservedNumbers: msg.reservedNumbers,
        reservedNames: msg.reservedNames
      }
    });

    for (const f of msg.fields) {
      const fullFieldName = `${msg.fullName}.${f.name}`;
      const fSource = { file: filePath, line: f.line };
      const fId = getStableId("proto.field", fullFieldName, fSource);

      entities.push({
        kind: "proto.field",
        id: fId,
        name: fullFieldName,
        source: fSource,
        attrs: {
          package: pkg,
          message: msg.fullName,
          name: f.name,
          fullName: fullFieldName,
          number: f.number,
          type: f.type,
          label: f.label,
          oneof: f.oneof
        }
      });
    }
  }

  // 3. Enum entities
  for (const enm of ast.enums) {
    const eSource = { file: filePath, line: enm.line };
    const eId = getStableId("proto.enum", enm.fullName, eSource);

    entities.push({
      kind: "proto.enum",
      id: eId,
      name: enm.fullName,
      source: eSource,
      attrs: {
        package: pkg,
        name: enm.name,
        fullName: enm.fullName,
        values: enm.values
      }
    });
  }

  // 4. Service entities
  for (const svc of ast.services) {
    const sSource = { file: filePath, line: svc.line };
    const sId = getStableId("proto.service", svc.fullName, sSource);

    entities.push({
      kind: "proto.service",
      id: sId,
      name: svc.fullName,
      source: sSource,
      attrs: {
        package: pkg,
        name: svc.name,
        fullName: svc.fullName,
        rpcs: svc.rpcs
      }
    });
  }

  return ast;
}

/**
 * Computes protobuf diff events between base and head.
 */
export function diffProto(base = {}, head = {}, baseEntities = new Map(), headEntities = new Map()) {
  const events = [];

  const baseMessages = [];
  const headMessages = [];
  const baseFields = [];
  const headFields = [];
  const baseEnums = [];
  const headEnums = [];
  const baseServices = [];
  const headServices = [];
  const basePackages = [];
  const headPackages = [];

  for (const ent of baseEntities.values()) {
    if (ent.kind === "proto.message") baseMessages.push(ent);
    else if (ent.kind === "proto.field") baseFields.push(ent);
    else if (ent.kind === "proto.enum") baseEnums.push(ent);
    else if (ent.kind === "proto.service") baseServices.push(ent);
    else if (ent.kind === "proto.package") basePackages.push(ent);
  }

  for (const ent of headEntities.values()) {
    if (ent.kind === "proto.message") headMessages.push(ent);
    else if (ent.kind === "proto.field") headFields.push(ent);
    else if (ent.kind === "proto.enum") headEnums.push(ent);
    else if (ent.kind === "proto.service") headServices.push(ent);
    else if (ent.kind === "proto.package") headPackages.push(ent);
  }

  const baseMessagesMap = new Map(baseMessages.map(m => [m.attrs.fullName || m.name, m]));
  const headMessagesMap = new Map(headMessages.map(m => [m.attrs.fullName || m.name, m]));

  const baseServicesMap = new Map(baseServices.map(s => [s.attrs.fullName || s.name, s]));
  const headServicesMap = new Map(headServices.map(s => [s.attrs.fullName || s.name, s]));

  const baseEnumsMap = new Map(baseEnums.map(e => [e.attrs.fullName || e.name, e]));
  const headEnumsMap = new Map(headEnums.map(e => [e.attrs.fullName || e.name, e]));

  // 1. proto.package_changed
  if (basePackages.length > 0 && headPackages.length > 0) {
    const bPkg = basePackages[0].attrs.name;
    const hPkg = headPackages[0].attrs.name;
    if (bPkg !== hPkg) {
      events.push({
        type: "proto.package_changed",
        entityId: headPackages[0].id,
        kind: "proto.package",
        before: bPkg,
        after: hPkg,
        source: headPackages[0].source,
        message: `Protobuf package changed from '${bPkg}' to '${hPkg}'`
      });
    }
  }

  // 2. proto.service_removed
  for (const [sName, baseSvc] of baseServicesMap.entries()) {
    if (!headServicesMap.has(sName)) {
      events.push({
        type: "proto.service_removed",
        entityId: baseSvc.id,
        kind: "proto.service",
        before: sName,
        source: baseSvc.source,
        message: `gRPC service '${sName}' was removed`
      });
    }
  }

  // 3. Service RPC checks (proto.rpc_removed, proto.rpc_signature_changed)
  for (const [sName, headSvc] of headServicesMap.entries()) {
    const baseSvc = baseServicesMap.get(sName);
    if (!baseSvc) continue;

    const bRpcs = new Map((baseSvc.attrs.rpcs || []).map(r => [r.name, r]));
    const hRpcs = new Map((headSvc.attrs.rpcs || []).map(r => [r.name, r]));

    // proto.rpc_removed
    for (const [rpcName, bRpc] of bRpcs.entries()) {
      if (!hRpcs.has(rpcName)) {
        events.push({
          type: "proto.rpc_removed",
          entityId: headSvc.id,
          kind: "proto.service",
          before: `${sName}.${rpcName}`,
          source: baseSvc.source,
          message: `gRPC RPC '${sName}.${rpcName}' was removed`
        });
      }
    }

    // proto.rpc_signature_changed
    for (const [rpcName, hRpc] of hRpcs.entries()) {
      const bRpc = bRpcs.get(rpcName);
      if (!bRpc) continue;

      const reqChanged = bRpc.request !== hRpc.request || bRpc.clientStreaming !== hRpc.clientStreaming;
      const resChanged = bRpc.response !== hRpc.response || bRpc.serverStreaming !== hRpc.serverStreaming;

      if (reqChanged || resChanged) {
        const bSig = `${bRpc.clientStreaming ? "stream " : ""}${bRpc.request} -> ${bRpc.serverStreaming ? "stream " : ""}${bRpc.response}`;
        const hSig = `${hRpc.clientStreaming ? "stream " : ""}${hRpc.request} -> ${hRpc.serverStreaming ? "stream " : ""}${hRpc.response}`;

        events.push({
          type: "proto.rpc_signature_changed",
          entityId: headSvc.id,
          kind: "proto.service",
          before: bSig,
          after: hSig,
          source: headSvc.source,
          message: `gRPC RPC '${sName}.${rpcName}' signature changed from (${bSig}) to (${hSig})`
        });
      }
    }
  }

  // 4. Enum checks (proto.enum_value_removed, proto.enum_number_changed)
  for (const [eName, headEnum] of headEnumsMap.entries()) {
    const baseEnum = baseEnumsMap.get(eName);
    if (!baseEnum) continue;

    const bVals = new Map((baseEnum.attrs.values || []).map(v => [v.name, v]));
    const hVals = new Map((headEnum.attrs.values || []).map(v => [v.name, v]));

    // proto.enum_value_removed
    for (const [vName, bVal] of bVals.entries()) {
      if (!hVals.has(vName)) {
        events.push({
          type: "proto.enum_value_removed",
          entityId: headEnum.id,
          kind: "proto.enum",
          before: `${eName}.${vName}`,
          source: baseEnum.source,
          message: `Protobuf enum value '${eName}.${vName}' was removed`
        });
      }
    }

    // proto.enum_number_changed
    for (const [vName, hVal] of hVals.entries()) {
      const bVal = bVals.get(vName);
      if (!bVal) continue;

      if (bVal.number !== hVal.number) {
        events.push({
          type: "proto.enum_number_changed",
          entityId: headEnum.id,
          kind: "proto.enum",
          before: bVal.number,
          after: hVal.number,
          source: headEnum.source,
          message: `Protobuf enum value '${eName}.${vName}' number changed from ${bVal.number} to ${hVal.number}`
        });
      }
    }
  }

  // 5. Message Field checks:
  // - proto.field_number_reused
  // - proto.field_number_changed
  // - proto.field_removed
  // - proto.field_type_changed
  // - proto.required_added
  for (const [mName, headMsg] of headMessagesMap.entries()) {
    const baseMsg = baseMessagesMap.get(mName);

    const bFields = baseFields.filter(f => f.attrs.message === mName);
    const hFields = headFields.filter(f => f.attrs.message === mName);

    const bFieldsByName = new Map(bFields.map(f => [f.attrs.name, f]));
    const hFieldsByName = new Map(hFields.map(f => [f.attrs.name, f]));

    const bFieldsByNumber = new Map(bFields.map(f => [f.attrs.number, f]));

    const hReservedNumbers = new Set(headMsg.attrs.reservedNumbers || []);
    const bReservedNumbers = new Set(baseMsg?.attrs.reservedNumbers || []);

    // Check head fields
    for (const hf of hFields) {
      const bf = bFieldsByName.get(hf.attrs.name);

      // proto.required_added
      if (hf.attrs.label === "required") {
        if (!bf || bf.attrs.label !== "required") {
          events.push({
            type: "proto.required_added",
            entityId: hf.id,
            kind: "proto.field",
            after: hf.name,
            source: hf.source,
            message: `Required protobuf field '${hf.name}' was added`
          });
        }
      }

      // proto.field_number_reused:
      // a) number was listed in reserved in head or base
      // b) number was used by a different field name in base message
      let reused = false;
      let reusedReason = "";

      if (hReservedNumbers.has(hf.attrs.number) || bReservedNumbers.has(hf.attrs.number)) {
        reused = true;
        reusedReason = "listed in reserved";
      }

      const prevFieldWithNum = bFieldsByNumber.get(hf.attrs.number);
      if (prevFieldWithNum && prevFieldWithNum.attrs.name !== hf.attrs.name) {
        reused = true;
        reusedReason = `previously used by '${prevFieldWithNum.attrs.name}'`;
      }

      if (reused) {
        events.push({
          type: "proto.field_number_reused",
          entityId: hf.id,
          kind: "proto.field",
          after: hf.attrs.number,
          source: hf.source,
          message: `Protobuf field number ${hf.attrs.number} in '${mName}.${hf.attrs.name}' was reused (${reusedReason})`
        });
      }

      // If field existed in base with same name:
      if (bf) {
        // proto.field_number_changed
        if (bf.attrs.number !== hf.attrs.number) {
          events.push({
            type: "proto.field_number_changed",
            entityId: hf.id,
            kind: "proto.field",
            before: bf.attrs.number,
            after: hf.attrs.number,
            source: hf.source,
            message: `Protobuf field '${hf.name}' number changed from ${bf.attrs.number} to ${hf.attrs.number}`
          });
        }

        // proto.field_type_changed
        if (bf.attrs.type !== hf.attrs.type) {
          events.push({
            type: "proto.field_type_changed",
            entityId: hf.id,
            kind: "proto.field",
            before: bf.attrs.type,
            after: hf.attrs.type,
            source: hf.source,
            message: `Protobuf field '${hf.name}' type changed from '${bf.attrs.type}' to '${hf.attrs.type}'`
          });
        }
      }
    }

    // Check removed fields in base message: proto.field_removed (without adding number to reserved)
    if (baseMsg) {
      for (const bf of bFields) {
        if (!hFieldsByName.has(bf.attrs.name)) {
          // Check if its number was added to reserved numbers in head
          const isReservedInHead = hReservedNumbers.has(bf.attrs.number);
          if (!isReservedInHead) {
            events.push({
              type: "proto.field_removed",
              entityId: bf.id,
              kind: "proto.field",
              before: bf.name,
              source: bf.source,
              message: `Protobuf field '${bf.name}' was removed without reserving its field number ${bf.attrs.number}`
            });
          }
        }
      }
    }
  }

  return events;
}
