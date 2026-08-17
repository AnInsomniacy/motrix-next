#!/usr/bin/env python3
"""Patch the generated Tauri AndroidManifest.xml for Motrix Next.

Adds the permissions the app needs (INTERNET, POST_NOTIFICATIONS, WAKE_LOCK,
media reads, network state) and deep-link intent filters for magnet://,
ed2k://, thunder:// and motrixnext:// schemes.

Run from the repo root after `tauri android init`:
    python3 .github/scripts/patch-android-manifest.py
"""
import os
import re
import sys

MANIFEST_PATH = "src-tauri/gen/android/app/src/main/AndroidManifest.xml"

PERMISSIONS = """    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
"""

DEEP_LINK_INTENTS = """            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="magnet" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="ed2k" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="thunder" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="motrixnext" />
            </intent-filter>
"""


def main() -> int:
    if not os.path.exists(MANIFEST_PATH):
        print(f"Manifest not found: {MANIFEST_PATH}", file=sys.stderr)
        return 1

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    if "android.permission.POST_NOTIFICATIONS" not in content:
        content = content.replace("<manifest ", PERMISSIONS + "<manifest ", 1)

    if 'android:scheme="magnet"' not in content:
        match = re.search(r"<activity\b[^>]*>", content)
        if match:
            content = content.replace(
                match.group(0), match.group(0) + DEEP_LINK_INTENTS, 1
            )

    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print("Manifest patched OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
