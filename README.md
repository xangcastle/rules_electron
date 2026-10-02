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

The packaging action declares `block-network` and redirects `HOME` into the
staging area: a missing toolset fails the build naming it, and nothing
touches the developer's profile. Remaining platform requirements (offline,
host-provided): macOS signing/productbuild for mas/pkg, and Wine for
Windows icon stamping from Linux/macOS.

## Quickstart

```starlark
# MODULE.bazel
bazel_dep(name = "rules_electron", version = "0.1.0")
bazel_dep(name = "platforms", version = "0.0.11")

builder_tools = use_extension("@rules_electron//:extensions.bzl", "builder_tools")
builder_tools.builder()
use_repo(builder_tools, "electron_builder_tools")

caches = use_extension("@rules_electron//:extensions.bzl", "electron_caches")
caches.cache(version = "37.6.1", platforms = ["linux-x64", "macos-arm64"])
use_repo(caches, "electron_cache_v37_6_1_linux_x64")
use_repo(caches, "electron_cache_v37_6_1_macos_arm64")
```

```starlark
# BUILD.bazel — bundles come from any rule (webpack, vite, filegroups)
electron_app(
    name = "my_app",
    bundles = {"app": ":app_files"},
    node_modules = ":node_modules",
    package_json = "package.json",
    electron_builder_config = "electron-builder.json",
    electron_caches = {
        "linux-x64": "@electron_cache_v37_6_1_linux_x64//:zip",
        "macos-arm64": "@electron_cache_v37_6_1_macos_arm64//:zip",
    },
    builder_tools = "@electron_builder_tools",
    targets = ["tar.gz", "appimage", "dmg"],
    archs = ["x64", "arm64"],
)
```

`bazel build //:my_app.package` produces the linux/windows artifacts;
`:my_app.package.macos` the mac ones; `bazel run //:my_app.dev` launches the
app.

See e2e/app for a complete working module.
