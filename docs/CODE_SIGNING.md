# Code signing

Local builds are unsigned unless a signing identity is explicitly configured.
A renamed product does not inherit a certificate or signing-service approval.

Rayburst's updater requires its own public signing key. The checked-in configuration
leaves that key empty, so local builds report that updates are not configured and do
not contact an update server. Release builds inject the public key through Tauri's
configuration merge. Private keys belong in release secrets, never in source control.

The Windows signing workflow is opt-in and requires Rayburst-specific SignPath
configuration. See [Release configuration](RELEASING.md).
