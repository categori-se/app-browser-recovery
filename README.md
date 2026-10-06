# browser-recovery

Alpha 0.1.0-alpha.1; Apache-2.0. Not for production use.

`@categori/browser-recovery` exports `createScopedRecoveryStore` for bounded browser snapshots. Applications supply trusted `{deployment, issuer, subject}` scope, a product namespace, synchronous payload validation and current-context checks.

`read`, `write` and `remove` return explicit outcomes. Success yields an independent payload copy and/or an opaque in-memory receipt. Failures report invalid, corrupt, oversized, unavailable or stale-context state without silently falling back to memory or deleting corrupt bytes.

Payloads must be plain JSON; accessors, cycles, class instances and unsupported values are rejected. Serialized envelopes are bounded to at most 16 MiB, depth 64 and 100,000 shape elements. Removal compares the bytes tied to the matching receipt.

Browser Storage has no atomic compare-and-delete primitive. These checks do not provide database CAS or cross-tab coordination. Apps must recheck identity and lifecycle before applying restored content. The module supplies no authentication, token verification, authorization, provider requests, domain processing or billing.

Registry packages are not published by this source release. Node manifests retain `private: true` to guard against accidental npm publication. See the repository CI for offline test commands.
