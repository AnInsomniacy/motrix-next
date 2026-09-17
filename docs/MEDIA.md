# Native media downloads

Rayburst uses Aria2 Next's GPAC, libcurl and FFmpeg integration for HLS and
DASH. No separate downloader, player or transcoding executable is required.
The bundled engine must advertise the current RPC contract and implement
`aria2.finishMedia` and `aria2.retryMedia`. Older sidecars are rejected.

## Downloading

Add an HTTP(S) manifest URL through the normal download dialog or browser
extension. The engine detects media from URL suffixes and response MIME types.
The advanced source mode can force HLS/DASH or save the original resource.

The Downloads preferences define the default container and whether new finite
presentations require content selection. With selection enabled, new presentations
pause after discovery and enter the selection queue used by BitTorrent. With it
disabled, the desktop resolves the native probe and continues finite sources with
`changeOption` and `unpause`, while keeping live recording behind confirmation.
The engine receives only its existing boolean pause option. Preferences apply to
new tasks only; restored tasks never enter automatic selection. The content dialog shows available video,
audio and subtitles, the output container, and a duration limit for live sources.
Confirming starts the same GID. Choose Later keeps it paused with a direct action
on its task card; it does not repeatedly reopen. Restored tasks remain accessible
without automatically interrupting startup. Ordinary files do not enter this flow.
Explicit native options can bypass selection; resume-all skips unresolved choices.

Audio and subtitle selectors accept a language or a native representation ID.
`best` chooses the native default and `none` excludes that track type. An HLS
multiplexed representation can contain both audio and video. This is not an
arbitrary multi-audio or multi-subtitle selection interface.

MP4 and Matroska are output containers, not encoding presets. Unsupported codec
or subtitle combinations fail explicitly; choose MKV when MP4 cannot carry the
selected subtitles. DRM, webpage extraction, subtitle translation and transcoding
are outside the engine's supported scope.

## Recording and recovery

Live tasks report recorded duration instead of a percentage. **Finish recording
and save** requests publication of committed media; it does not report success
until the engine emits ordinary task completion. The toolbar can request this
operation for all recordings in the current task list. Pause retains recovery
data; deletion discards it. These operations are not interchangeable.

Failed media uses the native `retryMedia` transaction, preserving its GID and
recovery data. The shared content dialog also allows changing media options before a
retry. Changing selection or container may invalidate prior fragments according
to the engine's identity rules. Already expired live segments cannot be recovered.

Re-downloading a completed presentation creates a new task. Native automatic
file renaming protects existing output and persists the chosen destination for
restart. The application never copies or edits the engine's media SQLite records.

For filename ownership, ordinary submissions and native database boundaries, see
[Download ownership and handoff](DOWNLOADS.md).

## Integration boundaries

- `Aria2Task.media` passes through Rust, frontend snapshots and history metadata.
- Numeric RPC values remain decimal strings. Durations are milliseconds and
  presentation progress is a fraction. The string `"false"` is not truthy media
  state.
- Source payload bytes differ from final container bytes. File size becomes
  authoritative after publication; finalization has no fabricated percentage.
- Completion persistence runs in Rust and remains available in lightweight mode.
  History retains non-sensitive media options, not copied credential headers.
- Network headers, authentication, proxies, TLS and speed limits use the existing
  transport. Certificate verification uses the native system trust policy.
- The engine owns manifest timing, segment retention, decryption, muxing and
  transactional publication. Frontend logic does not reproduce those algorithms.

## Validation

Run the normal TypeScript, Vitest and Rust checks. In the engine repository,
`tools/transfer_validation/media/recovery.py` exercises selection across restart,
partial failure, native retry, decoded output equality and output collisions
using the existing Caddy/FFmpeg validation helpers. Public media validation covers
subtitles, audio-only downloads and live recording controls separately.

All six platform sidecars must be built from the updated engine source before
distribution. Updating the Windows development binary alone does not update
the other packaged targets.

## Selection UI ownership

BitTorrent and media have independent dialogs and submission paths. The selection
queue stores only task identifiers, dialog kinds, and prompting state. Task
snapshots determine readiness outside the queue. The host waits for `after-leave`
before presenting the next dialog; each dialog retains its content through exit.
The native media dialog owns track loading, output options and same-GID retry.
BitTorrent retains its existing file selector and category routing. Both use
Naive UI modal primitives and the application's shared motion styles.

Modal instances stay mounted with `show=false` until selected, allowing Naive UI's
native enter transition to run on the first opening. Loading, errors and forms
share stable dialog bounds; the footer does not move during asynchronous updates.
The task overview renders media-specific rows inside its existing descriptions
and provides selection beside status, without repeating protocol or diagnostics.

## Browser media API

The desktop provides the `/media/v1` inspection contract in Rust; the extension
consumes and validates it independently.
The endpoints are authenticated with the Extension API secret; media requests
require a nonempty secret and an extension origin (or an authenticated native
client with no Origin header). Browser-page origins cannot use these endpoints.
Media operations remain available when the main webview is closed.

The API advertises `hls`, `dash` and `requestContexts: true` only when the running
engine advertises origin-scoped request contexts, stable track IDs and structured
media errors. Ordinary files use `/add`; this API has no direct-file inspection
or original-container branch.

The adapter validates browser request contexts and sends them through the native
`media-request-contexts` option. Every context retains its URL and header set;
there is no flattening into global headers. The engine selects the context for
each HTTP hop. Signed source URLs remain unchanged. Browser operations clear
ambient source credentials and use the supplied contexts. History stores only
an explicit allowlist of non-sensitive media options.

An inspection uses `media-pause-after-probe=true`, retains its GID through selection,
and stays outside download lists, history, notifications and bulk resume/pause.
Confirmation validates native track IDs and starts that GID without another desktop
selection dialog. Native container/codec validation remains authoritative.

`media-operations.db` stores bounded operation identities and submission receipts
using SQLite transactions. It contains request fingerprints, not source URLs or
browser credentials. Inspections expire after five minutes; cancellation tombstones
and submission receipts remain for at least 24 hours. Repeated submissions return
the same GID. A lost RPC reply preserves the submission intent for reconciliation.
Restart invalidates unsubmitted inspections and preserves acknowledged submissions.
The journal has its own native lifecycle and does not require the history webview.

Transport ambiguity returns HTTP 503; the current extension preserves its operation
identity on that response and can reconcile by polling. It does not mean that the
engine failed to create or start a task. Unsupported sources and selections use the
contract's terminal error codes. No legacy media endpoints or raw RPC proxy exist.

## Ownership and verification

- `media/contracts.rs` owns browser DTOs and native metadata conversion.
- `media/probe.rs` owns native inspection and capability negotiation.
- `media/native.rs` owns confirmation and retry transitions for the desktop UI,
  automatic selection and browser submissions.
- `services/tasks/policy.rs` owns probe visibility and automatic-selection admission.
- `media/runtime.rs` binds the service to Tauri and publishes confirmed events.
- `media/journal.rs` persists operation identities and receipts using SQLite.

The wire state `submitting` includes the immutable submission ID. Clients keep
polling the same operation while native confirmation is unresolved. Inspection
readiness requires both native `awaiting-selection` and ordinary `paused` status.

Static verification uses TypeScript, ESLint, formatting and
`cargo check --workspace --all-targets` in this repository. Module tests use local
fixtures. No test starts another repository or imports its test implementation.
Browser-to-desktop E2E acceptance is performed manually by the maintainer using
separately built applications. Compiler success does not establish runtime success.
