# Privacy Policy

**Last updated:** 2026-05-11

Motrix Next is an open-source desktop download manager licensed under the [MIT License](https://opensource.org/licenses/MIT). This document describes what data the application handles and what network connections it makes.

## Data Collection

Motrix Next does **not** collect, store, or transmit telemetry, analytics, usage profiles, account data, or advertising identifiers. There is no account system and no third-party analytics SDK.

## Local Data Storage

Application data is stored locally on your device and is not synced by Motrix Next:

| Data              | Location                                | Purpose                            |
| ----------------- | --------------------------------------- | ---------------------------------- |
| Preferences       | `config.json` (app data directory)      | User settings                      |
| Engine options    | `system.json` (app data directory)      | Aria2 Next runtime configuration   |
| Download history  | `history.db` (local SQLite database)    | Task records                       |
| Engine task manifest | `download.session` (app data directory) | Restore the task list |
| Engine transfer state | `engine/state` (app data directory) | Restore protocol progress and sharing state |
| Application logs  | app log directory                       | Diagnostics and troubleshooting    |
| Download files    | User-specified directory                | Downloaded content                 |

Diagnostic log exports are created only when the user chooses **Advanced Settings → Export Diagnostic Logs**. The exported ZIP contains the Motrix Next and Aria2 Next logs plus `diagnostics.json`, which combines system/runtime metadata with sanitized configuration. RPC secrets, Extension API secrets, cookies, and proxy credentials are redacted before export.

## Automatic Network Connections

Motrix Next can make the following automatic network connections. They can be disabled in Settings.

### 1. Update Check

|                   |                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **Default**       | Enabled, every application startup                                                                |
| **Contacts**      | GitHub-hosted updater metadata and release assets                                                 |
| **Purpose**       | Check if a newer version of Motrix Next is available                                              |
| **Data sent**     | Standard HTTPS request metadata, including client IP as seen by GitHub                            |
| **Data received** | Version metadata, release notes, signatures, and update package when the user downloads an update |
| **Disable**       | Settings → General → uncheck "Check for updates automatically"                                    |

The update channel can be Stable, Beta, or Latest Across Channels. If a proxy is configured for app updates, update checks use that proxy.

### 2. BT Tracker List Sync

|                   |                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **Default**       | Enabled, at most once every 12 hours                                                              |
| **Contacts**      | Configured community tracker list URLs, such as `cdn.jsdelivr.net` or `raw.githubusercontent.com` |
| **Purpose**       | Update BitTorrent tracker lists for better peer discovery                                         |
| **Data sent**     | Standard HTTP GET request (no user data)                                                          |
| **Data received** | Plain-text tracker URL list                                                                       |
| **Disable**       | Settings → BitTorrent → uncheck "Auto-update tracker list"                                        |

## User-Initiated Network Connections

When you add a download task, Motrix Next and its Aria2 Next sidecar connect to the servers or peers needed for that task. This can include HTTP, HTTPS, or SFTP servers, BitTorrent trackers, DHT nodes, peers, and metadata endpoints.

Some task creation flows resolve filenames before download. This may issue HTTP requests to the URL you submit so the app can inspect response headers such as `Content-Disposition`.

If UPnP is enabled, the app may contact your local network gateway to map BitTorrent ports. If system proxy detection is used, the app reads operating-system proxy settings locally.

## Browser Extension API

Motrix Next includes an embedded Extension API for browser extensions. It defaults to port `16801` and uses an Extension API secret that is independent from the aria2 RPC secret.

The Extension API can receive download URLs, referer values, cookie headers, and filename hints from the browser extension. These requests are routed into the desktop app and processed according to the user's confirmation and auto-submit settings.

The API is intended for browser-extension integration. Users can change the port or clear the secret in Advanced Settings. Running without a secret disables API authentication and is not recommended.

## Website Privacy

The project website is a static site. It may request GitHub API endpoints in the visitor's browser to display release, download, and repository statistics. These website requests are separate from the desktop application.

## Third-Party Components

| Component                                                               | Purpose                    | Network behavior                                                          |
| ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| [Aria2 Next](https://github.com/AnInsomniacy/aria2-next)                | Download engine            | Connects to download servers and BitTorrent peers as directed by the user |
| [DB-IP](https://db-ip.com/)                                             | GeoIP database (CC BY 4.0) | **Offline only** — bundled database, no network requests                  |
| [Tauri Updater Plugin](https://github.com/tauri-apps/plugins-workspace) | Auto-update framework      | Used for update checks and update installation                            |

## Children's Privacy

Motrix Next does not knowingly collect any data from children or any other users. The application does not collect data from anyone.

## Changes to This Policy

Updates to this privacy policy will be posted in this file within the project's GitHub repository. The "Last updated" date at the top will be revised accordingly.

## Contact

For privacy-related questions, please open an issue on GitHub:
https://github.com/AnInsomniacy/motrix-next/issues
