# rules_electron

Bazel rules for packaging Electron applications hermetically with
electron-builder.

## Rules

- `electron_app` — the standard target family for one app (bundles in,
  packaged artifacts out, dev target).
- `electron_builder` — one packaged artifact per electron-builder
  target/arch, with the network blocked.
- `electron_dev` — development launcher (`bazel run`).
- `node_addon` — macOS N-API addon linking against Electron's Node headers.

## Hermeticity

Every input that electron-builder would download is pre-pinned by SHA-256
and fetched by Bazel instead:

- the Electron binary, via the `electron_caches` extension (official zips);
- the packaging toolsets (AppImage, WinCodeSign, NSIS, dmgbuild), via the
  `builder_tools` extension (electron-builder-binaries releases; the dmgbuild
  hashes are the ones electron-builder itself embeds).

Linux and Windows packaging actions run sandboxed with `block-network`:
`HOME`/`XDG` are redirected into the staging area, a missing toolset fails
the build naming it, and a post-run receipt fails the build if anything
wrote to the redirected profile.

macOS `dmg`/`mas`/`pkg` targets mount and write a disk image volume and run
the host signing/productbuild tools, so they WAIVE the sandbox — they stay
offline (`block-network` still enforced) and keep the HOME redirection.

Remaining platform requirements (offline, host-provided): macOS signing
identities for signed mas/pkg builds, and Wine for Windows icon stamping
from Linux/macOS (disabled by default; `ELECTRON_BUILDER_WINE=1` re-enables
it on runners that have Wine).

## Dev target

`bazel run //:my_app.dev` stages the bundles into `dist/`, the `resources`
at their package-relative paths, rewrites the staged `package.json` `main`
to `app_main`, extracts the pinned Electron zip for the HOST platform (pass
the host entry of `electron_caches` via a `select()`), symlinks the linked
`node_modules`, and launches the app. Stdio is inherited; Ctrl+C reaches
the app. The stage is removed on exit.

Requirements:

- `electron_caches` must include the host platform's entry (the dev target
  picks it with a `select()` on OS).
- `7zip-bin` must be a dependency of the app (the packager and the dev
  launcher use `7za` to extract the pinned toolsets).

## Quickstart

```starlark
# MODULE.bazel
bazel_dep(name = "rules_electron", version = "0.1.0")
bazel_dep(name = "platforms", version = "0.0.11")

builder_tools = use_extension("@rules_electron//:extensions.bzl", "builder_tools")
builder_tools.builder()
use_repo(builder_tools, "electron_builder_tools")

caches = use_extension("@rules_electron//:extensions.bzl", "electron_caches")
# The Electron version comes from this package.json's electron dependency.
caches.cache(package_json = "//:package.json", platforms = {"linux": ["x64"], "macos": ["arm64"]})
use_repo(caches, "electron_cache_v37_6_1")
```

```starlark
# BUILD.bazel — bundles come from any rule (webpack, vite, filegroups)
electron_app(
    name = "my_app",
    bundles = {"app": ":app_files"},
    node_modules = ":node_modules",
    package_json = "package.json",
    electron_builder_config = "electron-builder.json",
    electron_cache = "@electron_cache_v37_6_1",
    builder_tools = "@electron_builder_tools",
    targets = ["tar.gz", "appimage", "dmg"],
    archs = ["x64", "arm64"],
)
```

`bazel build //:my_app.package` produces the linux/windows artifacts;
`:my_app.package.macos` the mac ones; `bazel run //:my_app.dev` launches the
app.

See e2e/app for a complete working module.
