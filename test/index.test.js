import assert from "node:assert/strict";
import test from "node:test";
import {createScopedRecoveryStore} from "../src/index.js";

const actorA = {deployment: "gateway-a", issuer: "https://identity.example/pool", subject: "actor-a"};
const actorB = {...actorA, subject: "actor-b"};
const newDeck = "new";

function memoryStorage() {
  const values = new Map();
  const calls = [];
  return {
    values, calls,
    getItem(key) { calls.push(["get", key]); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(["set", key]); values.set(key, value); },
    removeItem(key) { calls.push(["remove", key]); values.delete(key); }
  };
}

function fixture(options = {}) {
  const storage = memoryStorage();
  const store = createScopedRecoveryStore({storage: () => storage, product: "lng0", maxBytes: 4096, ...options});
  return {store, storage};
}

test("distinct actors, deployments, issuers, products and resources retain their own snapshots", () => {
  const {store, storage} = fixture();
  const scopes = [actorA, actorB, {...actorA, deployment: "gateway-b"}, {...actorA, issuer: "https://identity.example/other"}];
  for (const [index, scope] of scopes.entries()) assert.equal(store.write(scope, newDeck, {source: `private-${index}`}).status, "written");
  assert.equal(store.write(actorA, "saved:deck", {source: "other-deck"}).status, "written");
  const otherProduct = createScopedRecoveryStore({storage: () => storage, product: "other", maxBytes: 4096});
  assert.equal(otherProduct.write(actorA, newDeck, {source: "other-product"}).status, "written");
  assert.equal(storage.values.size, 6);
  for (const [index, scope] of scopes.entries()) assert.deepEqual(store.read(scope, newDeck).payload, {source: `private-${index}`});
  assert.deepEqual(store.read(actorA, "saved:deck").payload, {source: "other-deck"});
  assert.deepEqual(otherProduct.read(actorA, newDeck).payload, {source: "other-product"});
});

test("UTF-8 scope components cannot collide through delimiters or percent encoding", () => {
  const {store, storage} = fixture();
  const first = {...actorA, deployment: "a:b", subject: "c"};
  const second = {...actorA, deployment: "a", subject: "b:c"};
  assert.equal(store.write(first, "é:%", 1).status, "written");
  assert.equal(store.write(second, "é:%", 2).status, "written");
  assert.equal(storage.values.size, 2);
  assert.equal(store.read(first, "é:%").payload, 1);
  assert.equal(store.read(second, "é:%").payload, 2);
});

test("copying a scoped envelope to another actor key never returns its private payload", () => {
  const {store, storage} = fixture();
  store.write(actorA, newDeck, {source: "secret"});
  const original = [...storage.values.values()][0];
  store.read(actorB, newDeck);
  storage.values.set(storage.calls.at(-1)[1], original);
  const result = store.read(actorB, newDeck);
  assert.equal(result.status, "corrupt");
  assert.equal(result.reason, "scope-mismatch");
  assert.equal("payload" in result, false);
});

test("wrong product, resource, format, version, revision and extra envelope fields fail closed", () => {
  for (const mutate of [
    (value) => { value.product = "other"; },
    (value) => { value.resource = "other"; },
    (value) => { value.format = "other"; },
    (value) => { value.version = 2; },
    (value) => { value.revision = "not-an-id"; },
    (value) => { value.scope.extra = "other"; },
    (value) => { value.extra = true; }
  ]) {
    const {store, storage} = fixture();
    store.write(actorA, newDeck, {source: "secret"});
    const [key, text] = [...storage.values][0];
    const envelope = JSON.parse(text);
    mutate(envelope);
    storage.values.set(key, JSON.stringify(envelope));
    const result = store.read(actorA, newDeck);
    assert.equal(result.status, "corrupt");
    assert.equal("payload" in result, false);
  }
});

test("JSON/null and unknown fields survive, original mutations and returned mutations stay separate", () => {
  const {store} = fixture();
  const payload = JSON.parse('{"source":"original","nullable":null,"unknown":{"__proto__":{"safe":true},"array":[1,false,"é",null]}}');
  assert.equal(store.write(actorA, newDeck, payload).status, "written");
  payload.source = "changed";
  payload.unknown.array.push("changed");
  const first = store.read(actorA, newDeck);
  assert.equal(first.payload.source, "original");
  assert.equal(first.payload.unknown.array.length, 4);
  assert.deepEqual(Object.getOwnPropertyDescriptor(first.payload.unknown, "__proto__").value, {safe: true});
  assert.equal(Object.prototype.safe, undefined);
  first.payload.unknown.array.push("returned-edit");
  assert.equal(store.read(actorA, newDeck).payload.unknown.array.length, 4);
});

test("payload validator sees a frozen snapshot and must return exact synchronous true", () => {
  const {store} = fixture({validatePayload(payload) { assert(Object.isFrozen(payload)); assert(Object.isFrozen(payload.nested)); return payload.valid === true; }});
  assert.equal(store.write(actorA, newDeck, {valid: false, nested: {}}).status, "invalid");
  assert.equal(store.write(actorA, newDeck, {valid: true, nested: {}}).status, "written");
  for (const result of [1, "true", Promise.resolve(true)]) {
    const {store: invalid} = fixture({validatePayload: () => result});
    assert.equal(invalid.write(actorA, newDeck, null).status, "invalid");
  }
  const {store: mutating} = fixture({validatePayload(payload) { payload.private = "edit"; return true; }});
  assert.equal(mutating.write(actorA, newDeck, {private: "original"}).status, "invalid");
});

test("read invokes current domain validation and leaves rejected persisted bytes intact", () => {
  let allowed = true;
  const {store, storage} = fixture({validatePayload: () => allowed});
  store.write(actorA, newDeck, {source: "existing"});
  const before = [...storage.values];
  allowed = false;
  assert.equal(store.read(actorA, newDeck).status, "corrupt");
  assert.deepEqual([...storage.values], before);
});

test("accessors, cycles, class instances, non-JSON numbers, sparse arrays and symbols are rejected before storage", () => {
  let accessorReads = 0;
  const accessor = {get source() { accessorReads++; throw new Error("must not run"); }};
  const cycle = {}; cycle.self = cycle;
  const hidden = {}; Object.defineProperty(hidden, "hidden", {value: true});
  const arrayWithProperty = [1]; arrayWithProperty.extra = true;
  const cases = [accessor, cycle, new Date(), NaN, Infinity, undefined, BigInt(1), () => true, [,,], [undefined], arrayWithProperty, {[Symbol("hidden")]: true}, hidden];
  for (const payload of cases) {
    const {store, storage} = fixture();
    assert.equal(store.write(actorA, newDeck, payload).status, "invalid");
    assert.equal(storage.calls.length, 0);
  }
  assert.equal(accessorReads, 0);
});

test("scope accessors, unexpected fields, blank identifiers and invalid UTF-16 never access storage", () => {
  let reads = 0;
  const accessor = {...actorA}; Object.defineProperty(accessor, "subject", {get() { reads++; return "actor-a"; }});
  for (const [scope, resource] of [[accessor, newDeck], [{...actorA, extra: true}, newDeck], [{...actorA, subject: ""}, newDeck], [{...actorA, subject: " actor-a"}, newDeck], [actorA, "line\nfeed"], [actorA, "\ud800"]]) {
    const {store, storage} = fixture();
    assert.equal(store.write(scope, resource, null).status, "invalid");
    assert.equal(storage.calls.length, 0);
  }
  assert.equal(reads, 0);
});

test("inherited toJSON accessors never run while writing checked objects or arrays", () => {
  let hookReads = 0;
  const objectBefore = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const arrayBefore = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  try {
    for (const prototype of [Object.prototype, Array.prototype]) Object.defineProperty(prototype, "toJSON", {configurable: true, get() { hookReads++; throw new Error("must not serialize through hooks"); }});
    const {store, storage} = fixture();
    assert.equal(store.write(actorA, newDeck, {toJSON: "ordinary metadata", values: [{nullable: null}, false]}).status, "written");
    assert.equal(store.write(actorB, newDeck, {private: "other actor"}).status, "written");
    assert.equal(storage.values.size, 2);
    const restored = store.read(actorA, newDeck);
    assert.equal(restored.status, "read");
    assert.deepEqual(restored.payload, {toJSON: "ordinary metadata", values: [{nullable: null}, false]});
    assert.deepEqual(store.read(actorB, newDeck).payload, {private: "other actor"});
    assert.equal(hookReads, 0);
  } finally {
    if (objectBefore) Object.defineProperty(Object.prototype, "toJSON", objectBefore); else delete Object.prototype.toJSON;
    if (arrayBefore) Object.defineProperty(Array.prototype, "toJSON", arrayBefore); else delete Array.prototype.toJSON;
  }
});

test("UTF-8 bytes and envelope bytes, depth, and node limits bound recovery", () => {
  const {store, storage} = fixture({maxBytes: 512});
  assert.equal(store.write(actorA, newDeck, "é".repeat(300)).status, "oversize");
  assert.equal(store.write(actorA, newDeck, "a".repeat(400)).status, "oversize");
  assert.equal(storage.calls.length, 0);
  let deep = null;
  for (let index = 0; index < 70; ++index) deep = {next: deep};
  assert.equal(fixture().store.write(actorA, newDeck, deep).status, "oversize");
  const many = new Array(100_001).fill(null);
  assert.equal(fixture({maxBytes: 1024 * 1024}).store.write(actorA, newDeck, many).status, "oversize");
  store.read(actorA, newDeck);
  const key = storage.calls.at(-1)[1];
  storage.values.set(key, "é".repeat(300));
  assert.equal(store.read(actorA, newDeck).status, "oversize");
});

test("envelope depth is bounded symmetrically so every successful deepest write can be read", () => {
  const {store} = fixture({maxBytes: 32 * 1024});
  let payload = null;
  for (let index = 0; index < 63; ++index) payload = {next: payload};
  assert.equal(store.write(actorA, newDeck, payload).status, "written");
  assert.deepEqual(store.read(actorA, newDeck).payload, payload);
  payload = {next: payload};
  assert.equal(store.write(actorA, newDeck, payload).status, "oversize");
});

test("missing and malformed storage bytes are explicit and never auto-delete", () => {
  const {store, storage} = fixture();
  assert.deepEqual(store.read(actorA, newDeck), {ok: true, status: "missing"});
  const key = storage.calls.at(-1)[1];
  for (const text of ["{broken", "null", '"string"', "{}", 42]) {
    storage.values.set(key, text);
    const result = store.read(actorA, newDeck);
    assert.equal(result.status, "corrupt");
    assert.equal(storage.values.get(key), text);
  }
});

test("throwing browser storage getter, unavailable methods, quota and read/remove errors are explicit", () => {
  const browser = {get sessionStorage() { throw new Error("blocked"); }};
  const denied = createScopedRecoveryStore({storage: () => browser.sessionStorage, product: "lng0", maxBytes: 4096});
  assert.equal(denied.read(actorA, newDeck).reason, "storage-access");
  assert.equal(denied.write(actorA, newDeck, null).status, "unavailable");
  const absent = createScopedRecoveryStore({storage: () => null, product: "lng0", maxBytes: 4096});
  assert.equal(absent.read(actorA, newDeck).reason, "storage-method");
  const {store, storage} = fixture();
  storage.setItem = () => { throw new Error("quota"); };
  assert.equal(store.write(actorA, newDeck, null).reason, "storage-write");
  storage.getItem = () => { throw new Error("read failed"); };
  assert.equal(store.read(actorA, newDeck).reason, "storage-read");
  const good = fixture();
  const written = good.store.write(actorA, newDeck, null);
  good.storage.removeItem = () => { throw new Error("remove failed"); };
  assert.equal(good.store.remove(actorA, newDeck, written.receipt).reason, "storage-remove");
});

test("conditional removal preserves a newer identical-payload write and rejects forged or wrong-scope receipts", () => {
  const {store, storage} = fixture();
  const older = store.write(actorA, newDeck, {source: "same"});
  const newer = store.write(actorA, newDeck, {source: "same"});
  assert.equal(store.remove(actorA, newDeck, older.receipt).status, "changed");
  assert.equal(store.remove(actorB, newDeck, newer.receipt).status, "invalid");
  assert.equal(store.remove(actorA, "other", newer.receipt).status, "invalid");
  assert.equal(store.remove(actorA, newDeck, {...newer.receipt}).status, "invalid");
  const anotherStore = createScopedRecoveryStore({storage: () => storage, product: "lng0", maxBytes: 4096});
  assert.equal(anotherStore.remove(actorA, newDeck, newer.receipt).status, "invalid");
  assert.equal(Object.keys(newer.receipt).includes("payload"), false);
  assert.equal(JSON.stringify(newer.receipt).includes("same"), false);
  assert.equal(store.remove(actorA, newDeck, newer.receipt).status, "removed");
  assert.equal(store.remove(actorA, newDeck, newer.receipt).status, "missing");
});

test("a read receipt removes exactly its current stored snapshot", () => {
  const {store} = fixture();
  store.write(actorA, newDeck, {source: "saved"});
  const read = store.read(actorA, newDeck);
  assert.equal(store.remove(actorA, newDeck, read.receipt).status, "removed");
  assert.equal(store.read(actorA, newDeck).status, "missing");
});

test("context guards reject promises and stop before touching unavailable storage", () => {
  for (const guard of [() => false, () => 1, () => Promise.resolve(true), () => { throw new Error("expired"); }]) {
    let accesses = 0;
    const store = createScopedRecoveryStore({storage: () => { accesses++; throw new Error("must not reach"); }, product: "lng0", maxBytes: 4096, assertCurrent: guard});
    assert.equal(store.read(actorA, newDeck).status, "stale-context");
    assert.equal(store.write(actorA, newDeck, null).status, "stale-context");
    assert.equal(accesses, 0);
  }
});

test("scope snapshots precede storage getter side effects and stale getters/methods/read callbacks expose no data", () => {
  const mutableScope = {...actorA};
  const storage = memoryStorage();
  let current = true;
  const store = createScopedRecoveryStore({
    product: "lng0", maxBytes: 4096,
    assertCurrent(scope) { assert(Object.isFrozen(scope)); return current; },
    storage() { mutableScope.subject = "changed"; return storage; }
  });
  assert.equal(store.write(mutableScope, newDeck, "original").status, "written");
  assert.equal(store.read(actorA, newDeck).payload, "original");
  assert.equal(store.read(mutableScope, newDeck).status, "missing");
  const getterChanged = createScopedRecoveryStore({product: "lng0", maxBytes: 4096, assertCurrent: () => current, storage() { current = false; return storage; }});
  assert.equal(getterChanged.read(actorA, newDeck).status, "stale-context");
  current = true;
  const methodChanged = {get getItem() { current = false; return () => "private"; }};
  const guarded = createScopedRecoveryStore({product: "lng0", maxBytes: 4096, assertCurrent: () => current, storage: () => methodChanged});
  assert.equal(guarded.read(actorA, newDeck).status, "stale-context");
  current = true;
  const originalRead = storage.getItem;
  storage.getItem = function (key) { const value = originalRead.call(this, key); current = false; return value; };
  const stale = store.read(actorA, newDeck);
  assert.equal(stale.status, "stale-context");
  assert.equal("payload" in stale, false);
});

test("write/remove report a context change after their storage effect and never claim current success", () => {
  let current = true;
  const {store, storage} = fixture({assertCurrent: () => current});
  const set = storage.setItem;
  storage.setItem = function (key, value) { set.call(this, key, value); current = false; };
  const staleWrite = store.write(actorA, newDeck, {source: "old-context"});
  assert.deepEqual(staleWrite, {ok: false, status: "stale-context", reason: "context-changed", written: true});
  current = true;
  const read = store.read(actorA, newDeck);
  const remove = storage.removeItem;
  storage.removeItem = function (key) { remove.call(this, key); current = false; };
  assert.deepEqual(store.remove(actorA, newDeck, read.receipt), {ok: false, status: "stale-context", reason: "context-changed", removed: true});
});

test("conditional remove rechecks after method getters and preserves a changed snapshot", () => {
  const {store, storage} = fixture();
  const old = store.write(actorA, newDeck, "old");
  let removes = 0;
  Object.defineProperty(storage, "removeItem", {get() {
    const [key] = [...storage.values.keys()];
    storage.values.set(key, "changed by getter");
    return () => { removes++; };
  }});
  assert.equal(store.remove(actorA, newDeck, old.receipt).status, "changed");
  assert.equal(removes, 0);
});

test("legacy unscoped keys are neither enumerated, read nor removed", () => {
  const {store, storage} = fixture();
  storage.values.set("lng0:pending-generation:new", '{"source":"legacy-private"}');
  assert.equal(store.read(actorA, newDeck).status, "missing");
  const saved = store.write(actorA, newDeck, {source: "scoped"});
  assert.equal(store.remove(actorA, newDeck, saved.receipt).status, "removed");
  assert.equal(storage.values.get("lng0:pending-generation:new"), '{"source":"legacy-private"}');
  assert(storage.calls.every(([, key]) => key !== "lng0:pending-generation:new"));
});

test("invalid configurations fail at construction without storage access", () => {
  for (const change of [{storage: {}}, {product: ""}, {product: "with space"}, {product: {toString() { throw new Error("must not coerce"); }}}, {maxBytes: 0}, {maxBytes: 16 * 1024 * 1024 + 1}, {maxBytes: NaN}, {validatePayload: true}, {assertCurrent: true}]) {
    assert.throws(() => createScopedRecoveryStore({storage: () => null, product: "lng0", maxBytes: 4096, ...change}), TypeError);
  }
});
