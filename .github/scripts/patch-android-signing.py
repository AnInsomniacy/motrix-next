#!/usr/bin/env python3
"""Patch the Tauri-generated Android build.gradle.kts to add a release signing
config that reads from the keystore.properties file next to the project root.

Usage:
    python3 patch-android-signing.py src-tauri/gen/android/app/build.gradle.kts
"""
import re
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-android-signing.py <path/to/build.gradle.kts>", file=sys.stderr)
        return 1

    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Inject import at the top if not already present
    if "import java.io.FileInputStream" not in content:
        content = "import java.io.FileInputStream\n\n" + content

    # 2. Inject signingConfigs block before the first `buildTypes` block
    signing_block = """
signingConfigs {
    create("release") {
        val keystorePropertiesFile = rootProject.file("keystore.properties")
        val keystoreProperties = Properties()
        if (keystorePropertiesFile.exists()) {
            keystoreProperties.load(FileInputStream(keystorePropertiesFile))
        }
        keyAlias = keystoreProperties["keyAlias"] as String
        keyPassword = keystoreProperties["password"] as String
        storeFile = file(keystoreProperties["storeFile"] as String)
        storePassword = keystoreProperties["password"] as String
    }
}
"""

    if "signingConfigs" not in content and "signingConfig = signingConfigs.getByName" not in content:
        # Insert before buildTypes
        content = content.replace(
            "buildTypes {",
            signing_block + "buildTypes {",
        )

    # 3. Set signingConfig in the release build type (preserve existing body)
    if 'signingConfigs.getByName("release")' not in content:
        # Insert `signingConfig = ...` as the first statement of the release block
        pattern = r'getByName\("release"\)\s*\{'
        if re.search(pattern, content):
            content = re.sub(
                pattern,
                'getByName("release") {\n        signingConfig = signingConfigs.getByName("release")',
                content,
            )
        else:
            # No release block yet — inject one
            content = content.replace(
                "buildTypes {",
                'buildTypes {\n    getByName("release") {\n        signingConfig = signingConfigs.getByName("release")\n    }',
            )

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"Signing config patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())