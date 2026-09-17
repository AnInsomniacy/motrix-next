#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <release-tag>" >&2
  exit 1
fi

TAG="${1%$'\r'}"
VERSION="${TAG#v}"
REPO="${GITHUB_REPOSITORY:-AnInsomniacy/rayburst}"
BASE="https://github.com/$REPO/releases/download/$TAG"

if [[ "$TAG" == *"-beta"* ]] || [[ "$TAG" == *"-alpha"* ]] || [[ "$TAG" == *"-rc"* ]]; then
  JSON_FILE="beta.json"
  echo "Channel: BETA (tag=$TAG)"
else
  JSON_FILE="latest.json"
  echo "Channel: STABLE (tag=$TAG)"
fi

NOTES=$(gh release view "$TAG" -R "$REPO" --json body -q .body || echo "")

rm -rf sigs
mkdir -p sigs
gh release download "$TAG" -R "$REPO" -p "*.sig" -D sigs

echo "Downloaded signatures:"
ls -la sigs/

read_sig() {
  [ -f "$1" ] && cat "$1" || echo ""
}

DARWIN_SIG=$(read_sig "sigs/Rayburst_aarch64.app.tar.gz.sig")
DARWIN_X64_SIG=$(read_sig "sigs/Rayburst_x64.app.tar.gz.sig")
WINDOWS_SIG=$(read_sig "sigs/Rayburst_${VERSION}_x64-setup.exe.sig")
WINDOWS_ARM_SIG=$(read_sig "sigs/Rayburst_${VERSION}_arm64-setup.exe.sig")
LINUX_X64_SIG=$(read_sig "sigs/Rayburst_${VERSION}_amd64.AppImage.sig")
LINUX_ARM_SIG=$(read_sig "sigs/Rayburst_${VERSION}_aarch64.AppImage.sig")
LINUX_X64_DEB_SIG=$(read_sig "sigs/Rayburst_${VERSION}_amd64.deb.sig")
LINUX_ARM_DEB_SIG=$(read_sig "sigs/Rayburst_${VERSION}_arm64.deb.sig")
LINUX_X64_RPM_SIG=$(read_sig "sigs/Rayburst-${VERSION}-1.x86_64.rpm.sig")
LINUX_ARM_RPM_SIG=$(read_sig "sigs/Rayburst-${VERSION}-1.aarch64.rpm.sig")

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg notes "$NOTES" \
  --arg darwin_sig "$DARWIN_SIG" \
  --arg darwin_url "$BASE/Rayburst_aarch64.app.tar.gz" \
  --arg darwin_x64_sig "$DARWIN_X64_SIG" \
  --arg darwin_x64_url "$BASE/Rayburst_x64.app.tar.gz" \
  --arg win_sig "$WINDOWS_SIG" \
  --arg win_url "$BASE/Rayburst_${VERSION}_x64-setup.exe" \
  --arg wina_sig "$WINDOWS_ARM_SIG" \
  --arg wina_url "$BASE/Rayburst_${VERSION}_arm64-setup.exe" \
  --arg lx64_sig "$LINUX_X64_SIG" \
  --arg lx64_url "$BASE/Rayburst_${VERSION}_amd64.AppImage" \
  --arg larm_sig "$LINUX_ARM_SIG" \
  --arg larm_url "$BASE/Rayburst_${VERSION}_aarch64.AppImage" \
  --arg ldebx64_sig "$LINUX_X64_DEB_SIG" \
  --arg ldebx64_url "$BASE/Rayburst_${VERSION}_amd64.deb" \
  --arg ldebarm_sig "$LINUX_ARM_DEB_SIG" \
  --arg ldebarm_url "$BASE/Rayburst_${VERSION}_arm64.deb" \
  --arg lrpmx64_sig "$LINUX_X64_RPM_SIG" \
  --arg lrpmx64_url "$BASE/Rayburst-${VERSION}-1.x86_64.rpm" \
  --arg lrpmarm_sig "$LINUX_ARM_RPM_SIG" \
  --arg lrpmarm_url "$BASE/Rayburst-${VERSION}-1.aarch64.rpm" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": { signature: $darwin_sig, url: $darwin_url },
      "darwin-x86_64": { signature: $darwin_x64_sig, url: $darwin_x64_url },
      "windows-x86_64": { signature: $win_sig, url: $win_url },
      "windows-aarch64": { signature: $wina_sig, url: $wina_url },
      "linux-x86_64": { signature: $lx64_sig, url: $lx64_url },
      "linux-aarch64": { signature: $larm_sig, url: $larm_url },
      "linux-x86_64-deb": { signature: $ldebx64_sig, url: $ldebx64_url },
      "linux-aarch64-deb": { signature: $ldebarm_sig, url: $ldebarm_url },
      "linux-x86_64-rpm": { signature: $lrpmx64_sig, url: $lrpmx64_url },
      "linux-aarch64-rpm": { signature: $lrpmarm_sig, url: $lrpmarm_url }
    }
  }' > "$JSON_FILE"

echo "Generated $JSON_FILE:"
cat "$JSON_FILE"

gh release view rayburst-updater -R "$REPO" 2>/dev/null || \
  gh release create rayburst-updater \
    --title "Auto-Updater Assets" \
    --notes "Managed by CI. Do not delete. Contains latest.json and beta.json for the Tauri updater." \
    --latest=false \
    -R "$REPO"

gh release upload rayburst-updater "$JSON_FILE" --clobber -R "$REPO"
echo "Uploaded $JSON_FILE to 'rayburst-updater' release"
