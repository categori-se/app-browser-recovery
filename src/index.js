const FORMAT = "categori.browser-recovery";
const VERSION = 1;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

class InvalidJson extends Error {}
class TooLarge extends Error {}

function failure(status, reason, details = {}) {
  return {ok: false, status, reason, ...details};
}

function exactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  // URI encoding must be lossless; unpaired UTF-16 surrogates have no identifier encoding.
  try { encodeURIComponent(value); return true; } catch { return false; }
}

function contextSnapshot(scope, resource) {
  if (!plain(scope) || !exactKeys(scope, ["deployment", "issuer", "subject"])) return null;
  const fields = Object.getOwnPropertyDescriptors(scope);
  const copy = {};
  for (const name of ["deployment", "issuer", "subject"]) {
    const field = fields[name];
    if (!field || !("value" in field) || !identifier(field.value, 1024)) return null;
    copy[name] = field.value;
  }
  if (!identifier(resource, 1024)) return null;
  return {scope: Object.freeze(copy), resource};
}

function boundedBytes(text, limit) {
  if (text.length > limit || encoder.encode(text).byteLength > limit) throw new TooLarge();
}

// Inspect data descriptors rather than reading properties: recovery must never invoke
// caller-owned accessors or a toJSON method while preparing its private snapshot.
function jsonSnapshot(value, maxBytes) {
  let nodes = 0;
  let stringBytes = 0;
  const ancestors = new Set();
  function visit(input, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TooLarge();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new InvalidJson();
      return input;
    }
    if (typeof input === "string") {
      boundedBytes(input, maxBytes);
      stringBytes += encoder.encode(input).byteLength;
      if (stringBytes > maxBytes) throw new TooLarge();
      return input;
    }
    if (typeof input !== "object" || ancestors.has(input)) throw new InvalidJson();
    const array = Array.isArray(input);
    if (!array && !plain(input)) throw new InvalidJson();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new InvalidJson();
    if (keys.length + nodes > MAX_NODES) throw new TooLarge();
    ancestors.add(input);
    const output = array ? [] : {};
    try {
      if (array) {
        const length = descriptors.length;
        if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_NODES) throw new TooLarge();
        if (keys.length !== length.value + 1) throw new InvalidJson();
        for (let index = 0; index < length.value; ++index) {
          const item = descriptors[String(index)];
          if (!item || !("value" in item) || !item.enumerable) throw new InvalidJson();
          output.push(visit(item.value, depth + 1));
        }
      } else {
        for (const key of keys) {
          const item = descriptors[key];
          if (!("value" in item) || !item.enumerable) throw new InvalidJson();
          boundedBytes(key, maxBytes);
          stringBytes += encoder.encode(key).byteLength;
          if (stringBytes > maxBytes) throw new TooLarge();
          Object.defineProperty(output, key, {value: visit(item.value, depth + 1), enumerable: true, writable: true, configurable: true});
        }
      }
      return output;
    } finally { ancestors.delete(input); }
  }
  return visit(value, 0);
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

// Only checked snapshots reach this function. Serializing their members directly
// prevents an inherited Object.prototype/Array.prototype.toJSON hook from running.
function stringifySnapshot(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; ++index) items.push(stringifySnapshot(value[index]));
    return `[${items.join(",")}]`;
  }
  const items = [];
  for (const key of Object.keys(value)) items.push(`${JSON.stringify(key)}:${stringifySnapshot(value[key])}`);
  return `{${items.join(",")}}`;
}

function scopeEqual(left, right) {
  return left.deployment === right.deployment && left.issuer === right.issuer && left.subject === right.subject;
}

/** The caller supplies verified identity, domain validation, and current-context checks. */
export function createScopedRecoveryStore({storage, product, maxBytes, validatePayload = () => true, assertCurrent = () => true} = {}) {
  if (typeof storage !== "function" || typeof validatePayload !== "function" || typeof assertCurrent !== "function" || typeof product !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(product) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
    throw new TypeError("Invalid recovery store configuration");
  }
  const receipts = new WeakMap();

  function context(scope, resource) {
    try {
      const snapshot = contextSnapshot(scope, resource);
      if (!snapshot) return failure("invalid", "invalid-context");
      const key = ["categori", "browser-recovery", "v1", product, snapshot.scope.deployment, snapshot.scope.issuer, snapshot.scope.subject, snapshot.resource].map(encodeURIComponent).join(":");
      return {...snapshot, key};
    } catch { return failure("invalid", "invalid-context"); }
  }

  function current(ctx) {
    try { return assertCurrent(ctx.scope, ctx.resource) === true; } catch { return false; }
  }

  function open(ctx, operation) {
    if (!current(ctx)) return failure("stale-context", "context-changed");
    let target;
    let method;
    try { target = storage(); } catch { return current(ctx) ? failure("unavailable", "storage-access") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    try { method = target?.[operation]; } catch { return current(ctx) ? failure("unavailable", "storage-method") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    if (typeof method !== "function") return failure("unavailable", "storage-method");
    return {target, method};
  }

  function issueReceipt(ctx, text) {
    const receipt = Object.freeze({format: `${FORMAT}.receipt/v1`});
    receipts.set(receipt, {key: ctx.key, text});
    return receipt;
  }

  function checkedPayload(payload) {
    const snapshot = freezeJson(jsonSnapshot(payload, maxBytes));
    if (validatePayload(snapshot) !== true) throw new InvalidJson();
    return snapshot;
  }

  function read(scope, resource) {
    const ctx = context(scope, resource);
    if (ctx.ok === false) return ctx;
    const opened = open(ctx, "getItem");
    if (opened.ok === false) return opened;
    let text;
    try { text = opened.method.call(opened.target, ctx.key); } catch { return current(ctx) ? failure("unavailable", "storage-read") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    if (text === null) return {ok: true, status: "missing"};
    if (typeof text !== "string") return failure("corrupt", "invalid-storage-value");
    try {
      boundedBytes(text, maxBytes);
      const envelope = jsonSnapshot(JSON.parse(text), maxBytes);
      if (!plain(envelope) || !exactKeys(envelope, ["format", "version", "product", "scope", "resource", "revision", "payload"]) || envelope.format !== FORMAT || envelope.version !== VERSION || envelope.product !== product || envelope.resource !== ctx.resource || !UUID.test(envelope.revision)) return failure("corrupt", "invalid-envelope");
      const savedContext = contextSnapshot(envelope.scope, envelope.resource);
      if (!savedContext || !scopeEqual(savedContext.scope, ctx.scope)) return failure("corrupt", "scope-mismatch");
      const payload = checkedPayload(envelope.payload);
      if (!current(ctx)) return failure("stale-context", "context-changed");
      return {ok: true, status: "read", payload: jsonSnapshot(payload, maxBytes), receipt: issueReceipt(ctx, text)};
    } catch (error) {
      if (!current(ctx)) return failure("stale-context", "context-changed");
      return failure(error instanceof TooLarge ? "oversize" : "corrupt", error instanceof TooLarge ? "storage-bound" : "invalid-payload");
    }
  }

  function write(scope, resource, payload) {
    const ctx = context(scope, resource);
    if (ctx.ok === false) return ctx;
    if (!current(ctx)) return failure("stale-context", "context-changed");
    let text;
    try {
      const snapshot = checkedPayload(payload);
      let revision;
      try { revision = globalThis.crypto.randomUUID(); } catch { return current(ctx) ? failure("unavailable", "revision-source") : failure("stale-context", "context-changed"); }
      if (typeof revision !== "string" || !UUID.test(revision)) return failure("unavailable", "revision-source");
      const envelope = jsonSnapshot({format: FORMAT, version: VERSION, product, scope: ctx.scope, resource: ctx.resource, revision, payload: snapshot}, maxBytes);
      text = stringifySnapshot(envelope);
      boundedBytes(text, maxBytes);
    } catch (error) {
      if (!current(ctx)) return failure("stale-context", "context-changed");
      return failure(error instanceof TooLarge ? "oversize" : "invalid", error instanceof TooLarge ? "payload-bound" : "invalid-payload");
    }
    const opened = open(ctx, "setItem");
    if (opened.ok === false) return opened;
    try { opened.method.call(opened.target, ctx.key, text); } catch { return current(ctx) ? failure("unavailable", "storage-write") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed", {written: true});
    return {ok: true, status: "written", receipt: issueReceipt(ctx, text)};
  }

  function remove(scope, resource, receipt) {
    const ctx = context(scope, resource);
    if (ctx.ok === false) return ctx;
    const expected = receipt !== null && typeof receipt === "object" ? receipts.get(receipt) : undefined;
    if (!expected || expected.key !== ctx.key) return failure("invalid", "invalid-receipt");
    const opened = open(ctx, "getItem");
    if (opened.ok === false) return opened;
    let text;
    try { text = opened.method.call(opened.target, ctx.key); } catch { return current(ctx) ? failure("unavailable", "storage-read") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    if (text === null) return {ok: true, status: "missing"};
    if (text !== expected.text) return {ok: true, status: "changed"};
    let method;
    try { method = opened.target.removeItem; } catch { return current(ctx) ? failure("unavailable", "storage-method") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    if (typeof method !== "function") return failure("unavailable", "storage-method");
    // Acquiring a custom method may itself write. Recheck immediately before removal;
    // this remains best-effort rather than an atomic Storage compare-and-delete.
    try { text = opened.method.call(opened.target, ctx.key); } catch { return current(ctx) ? failure("unavailable", "storage-read") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed");
    if (text === null) return {ok: true, status: "missing"};
    if (text !== expected.text) return {ok: true, status: "changed"};
    try { method.call(opened.target, ctx.key); } catch { return current(ctx) ? failure("unavailable", "storage-remove") : failure("stale-context", "context-changed"); }
    if (!current(ctx)) return failure("stale-context", "context-changed", {removed: true});
    return {ok: true, status: "removed"};
  }

  return Object.freeze({read, write, remove});
}
