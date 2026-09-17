# Download ownership and handoff

The desktop, browser extension and engine are independent projects. Each owns its
source, dependencies, artifacts and tests. Their parent directory is only a local
workspace. No shared runtime package or cross-repository test harness is required.

## Responsibilities

| Owner             | Responsibility                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Browser extension | Intercept browser intent, capture observed names and request context, preserve handoff identity until a receipt arrives. |
| Rust desktop      | Apply application preferences, manage confirmation and submission receipts, create/control tasks and persist history.    |
| Vue desktop       | Edit user intent, present native task state, select content and invoke named commands.                                   |
| Aria2 Next        | Resolve final output names and paths, handle conflicts and recovery, transfer data and publish completed media.          |

`aria2/rpc.rs` owns HTTP JSON-RPC framing, authentication and structured errors.
`services/tasks/` owns task queries, controls and visibility policy.
`services/downloads/` owns ordinary submission, including manual URI/torrent
creation. `services/media/` owns media inspection and selection. Policy does not
belong in the RPC transport. OS deep-link parsing still feeds the desktop dialog;
browser HTTP submissions run in Rust without requiring a mounted WebView.

## Output names

For a new ordinary HTTP task, the engine applies this precedence:

1. An explicit user `out` or an already persisted output path.
2. A browser-resolved `filename-hint` with source `browser`.
3. The final payload response's `Content-Disposition` (`filename*` before `filename`).
4. A `suggested` filename hint, then the final URL basename, then the engine default.

Hints are decoded text, not paths. The engine applies its path rules. URL components
are decoded once; literal percent sequences in names, passwords and restored paths
remain literal. The desktop makes no separate HEAD/GET request to guess a name.
Remote torrent metainfo inspection remains a real download, not a naming probe.

For media, `filename-hint-source=title` preserves dots in a page title and appends
the selected container extension. Filename hints and explicit `out` values have
their extension replaced by the selected container. The engine owns publication
and collision handling. Vue never rewrites the native output name on selection.
Directory classification is an application preference based on the available URL
or hint; it does not predict a later server-selected filename.

The header rules follow [RFC 6266](https://www.rfc-editor.org/rfc/rfc6266.html).
The existing aria2 header parser and libcurl handle protocol decoding. A bounded
encoded-word adapter is confined to HTTP header values from nonconforming servers;
it is not a general charset detector or a second pass over browser names.

## Ordinary browser API, protocol 2

The desktop owns the contract in `services/downloads/contracts.rs`. The extension
validates the fields it consumes in its own repository. Both endpoints use the
configured Extension API authentication and origin policy; the body limit is 256 KiB.

`GET /downloads/capabilities` returns:

```json
{ "protocolVersion": 2, "filenameHints": true }
```

This requires the running engine's `downloadFeatures` to contain `filename-hints`.
A client must check support before its first mutation. Old `/add` responses are not
accepted and there is no legacy fallback protocol.

`POST /add` accepts this shape (optional fields may be omitted):

```json
{
  "id": "49d78689-14a7-4761-8695-23df58c3605d",
  "url": "https://example.com/download",
  "filename": "report%20.pdf",
  "filenameSource": "browser",
  "requestHeaders": []
}
```

`id` is 1–128 ASCII letters, digits, hyphens or colons. Optional fields are
`finalUrl`, `referer`, `cookie`, `userAgent`, `filename`, `filenameSource`
(`browser` or `suggested`, default `suggested`), and `requestHeaders`
(`{name,value}` pairs). Supported inputs are HTTP(S), SFTP, magnet, ED2K and Thunder;
the engine's aria2 compatibility adapter remains responsible for legacy link formats.

A receipt always echoes `id`. Its `action` is `submitted` (with `gid`),
`needs-confirmation`, or `cancelled`. `needs-confirmation` acknowledges a persisted
intent, not task creation. Submitted means the engine task/session and native receipt
have been saved. A replay with the same ID/body retains the GID; a different body
with that ID returns 409. Invalid input returns 400; unresolved native/storage work
returns 503. A lost reply is not proof that task creation failed.

The browser retains unresolved requests in native `storage.session` and replays the
same ID on worker startup, only against the original connection. Session storage
survives worker suspension, not browser restart or extension reload. After an
ambiguous POST, it does not start a second browser download. Definitive preflight
failures may use the existing browser fallback.

## Native storage and recovery

`database/` is the single connection owner for `history.db`: history, birth records,
HTTP credentials and ordinary submission receipts. `schema.sql` defines the current
schema; `PRAGMA user_version` records it. Initialization runs from Rust startup.
Frontend stores expose named IPC operations and never execute SQL. The media
operation journal remains separate because it has a different lifecycle and lease.

SQLite transactions serialize history page/count queries and submission updates.
The current database layout is retained when opening existing data; unsupported
layouts fail explicitly. There is no legacy migration runner or automatic reset.
Only the user's explicit reset removes the database.

Pending confirmations retain the request locally so desktop restart can reopen them.
Submitting or cancelling clears that request body, including browser credentials.
Receipts retain request ID, fingerprint, GID and state until the database is reset.
These identities prevent retries from creating another task after a lost reply.
They are not a distributed transaction across arbitrary machine power loss.
Saved HTTP passwords remain plaintext local data as before and are never URL decoded.

## Verification and packaging

Use `pnpm test --maxWorkers=4`, `pnpm build`, `pnpm lint`, `pnpm check:repo`,
`pnpm format:check`, and `cargo test --workspace --all-targets`.
Native tests cover real SQLite transactions and local HTTP JSON-RPC responses,
including lost creation replies, structured errors, invalid UTF-8 and removal order.
Frontend tests cover transformations and visible state rather than forwarding wrappers.
The engine repository owns executable transfer tests; the extension owns browser API
and worker replay fixtures. Manual acceptance uses the three separately built apps.

Every packaged platform needs a matching engine artifact. In addition to the media
contract described in [MEDIA.md](MEDIA.md), it must advertise `filename-hints`.
Updating one platform's binary does not update the other bundled targets. Do not
publish a multi-platform desktop release with unmatched sidecars.

Prefer the established native APIs and maintained stable dependencies. Choose LTS
when that dependency provides a useful support window; do not invent an LTS version
for community libraries. File length is a review signal, not a reason to split one
cohesive algorithm. Comments explain ownership, units and non-obvious constraints;
tests protect behavior, data integrity and recovery rather than implementation shape.

## Product identity

The desktop advertises `product: "rayburst"` in `/ping`, download capabilities and
media capabilities. Rayburst Connect validates that field and sends
`X-Rayburst-Client: rayburst-connect` on authenticated requests. Browser-origin
requests without that header are rejected. Native clients without an Origin header
continue to authenticate with the Extension API secret.

The `rayburst://` scheme activates the desktop only. It never creates a download or
transports cookies. Downloads use the authenticated HTTP handoff and its receipts.
