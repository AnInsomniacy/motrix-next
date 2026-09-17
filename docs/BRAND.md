# Rayburst brand

Product: **Rayburst**. Package: `rayburst`. Application ID: `dev.aninsomniacy.rayburst`.

Seize the ray, forge the real.

`public/logo.svg` is the artwork source. Run `pnpm icons` to generate desktop icons
with the Tauri CLI. The tray uses the same mark; macOS renders its alpha channel as
a native template image. `docs/brand/banner.png` is the approved English README banner.

The default interface seed is `#946ECE`, softened from the original purple while
preserving its hue. Material Color Utilities generates both themes through the
standard source palette.
The original logo artwork retains its purple gradients.
The empty-list background reuses `public/logo.svg` as a monochrome CSS mask,
without a wordmark. It follows the rendered list immediately, independent of
engine startup or database readiness.
CSS, Naive UI and canvas drawing use semantic roles. Warning, error and success
colors describe state; they are not aliases for the brand color. Button foregrounds
must remain readable in normal, hover, focus and pressed states.

Use the product name without translation. Keep interface labels short and literal.
Use the slogan in the README, website and About panel. Review prose with Sepia;
remove unsupported claims and unnecessary adjectives.

The engine remains aria2-next. Its code, protocols and binary contents are independent
of this branding change. The desktop bundle uses the engine's actual executable name.

Interface slogans use the existing i18n dictionaries in all 27 supported locales.
The approved Simplified Chinese slogan is “捕光捉影，化虚为实。”
Use its Traditional Chinese equivalent for zh-TW. Preserve the approved English
slogan in English interfaces, README banners and promotional artwork.

The website remains a standalone HTML, CSS and JavaScript site. Its light and dark
colors use the desktop's default palette; the SVG logos retain their original colors.
Website artwork copies come from `public/logo.svg`, Rayburst Connect's
`public/icon/icon.svg`, and the screenshots in `docs/media/`.
Keep the transition notice and release availability accurate. Browser media discovery
and native HLS/DASH downloads are upcoming release features, not features of the
currently published Motrix Next stable build. Keep working repository URLs until
the repositories move. Localize website copy in all 27 languages.
