# Release configuration

This checkout builds Rayburst locally. It does not create a store listing, publish a
website, change Git remotes or submit a signing request during development.

## Desktop updates

Configure `RAYBURST_UPDATER_PUBLIC_KEY`, `RAYBURST_SIGNING_PRIVATE_KEY` and
`RAYBURST_SIGNING_PRIVATE_KEY_PASSWORD` in the release repository. The public key is a
repository variable; private material is a secret. The release workflow merges the
public key into Tauri configuration and enables signed updater artifacts before building. An empty public key disables
update checks in local builds.

Update manifests live under the separate `rayburst-updater` release tag. Stable
builds use `latest.json`; prereleases use `beta.json`. Do not reuse another product's
update tag, key or installer identity. Verify the new repository exists before publishing.

## Browser identities

`src-tauri/native-messaging/identity.json` lists allowed browser identities.
The local Chromium identity is derived from the public key in the file; the Firefox
ID is explicit. The checked-in store IDs are unset. Native Messaging is activation-only.

When Rayburst Connect receives actual store identities, update this file and the
extension's independently maintained `browser-identity.json` in the same delivery.
Regenerate packaged manifests with `pnpm build:native-launcher` and rebuild the app.
No wildcard extension origins are allowed.

## Platform distribution

Homebrew publication requires `RAYBURST_HOMEBREW_ENABLED=true` and a configured
Rayburst tap. Windows signing requires `RAYBURST_SIGNPATH_ENABLED=true` and the
Rayburst SignPath project settings. Community package entries are not assumed to
exist. Keep installation instructions limited to packages that have been published.

Use `scripts/bump-version.sh` for a chosen release version. Creating a release,
submitting to stores and platform acceptance are separate actions.
