"""Repository for the electron-builder packaging toolsets (SHA-256 pinned).

The builder_tools extension downloads the toolsets electron-builder would
otherwise fetch on demand (AppImage, WinCodeSign, NSIS, dmgbuild) from
electron-userland/electron-builder-binaries releases, and exposes each as a
filegroup. The electron_app macro maps packaging targets to the required
toolsets; the packager stages them as a pre-populated
ELECTRON_BUILDER_CACHE so packaging runs with the network blocked.

The dmgbuild sha256s are the ones electron-builder itself embeds in
dmgUtil.ts; the rest come from the release assets.
"""

_BUILDER_TOOLS = {
    "appimage": {
        "release": "appimage-12.0.1",
        "file": "appimage-12.0.1.7z",
        "sha256": "d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4",
    },
    "win_code_sign": {
        "release": "winCodeSign-2.6.0",
        "file": "winCodeSign-2.6.0.7z",
        "sha256": "cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4",
    },
    "nsis": {
        "release": "nsis-3.0.4.1",
        "file": "nsis-3.0.4.1.7z",
        "sha256": "9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa",
    },
    "nsis_resources": {
        "release": "nsis-resources-3.4.1",
        "file": "nsis-resources-3.4.1.7z",
        "sha256": "593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103",
    },
    "dmgbuild_arm64": {
        "release": "dmg-builder@1.2.0",
        "file": "dmgbuild-bundle-arm64-75c8a6c.tar.gz",
        "sha256": "a785f2a385c8c31996a089ef8e26361904b40c772d5ea65a36001212f1fc25e0",
    },
    "dmgbuild_x86_64": {
        "release": "dmg-builder@1.2.0",
        "file": "dmgbuild-bundle-x86_64-75c8a6c.tar.gz",
        "sha256": "87b3bb72148b11451ee90ede79cc8d59305c9173b68b0f2b50a3bea51fc4a4e2",
    },
}

def _builder_tools_repo_impl(rctx):
    build_lines = [
        "exports_files(glob([\"**/*\"]))",
        "filegroup(",
        "    name = \"all_files\",",
        "    srcs = glob([\"**/*\"]),",
        "    visibility = [\"//visibility:public\"],",
        ")",
    ]
    for tool, spec in sorted(_BUILDER_TOOLS.items()):
        rctx.download(
            url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/%s/%s" % (spec["release"], spec["file"]),
            sha256 = spec["sha256"],
            output = "%s/%s" % (spec["release"], spec["file"]),
        )
        build_lines.extend([
            "filegroup(",
            "    name = \"%s\"," % tool,
            "    srcs = [\"%s/%s\"]," % (spec["release"], spec["file"]),
            "    visibility = [\"//visibility:public\"],",
            ")",
        ])
    rctx.file("BUILD.bazel", "\n".join(build_lines) + "\n")

_builder_tools_repo = repository_rule(
    implementation = _builder_tools_repo_impl,
    doc = "Downloads the pinned packaging toolsets.",
)

def _builder_tools_ext_impl(module_ctx):
    for _mod in module_ctx.modules:
        _builder_tools_repo(name = "electron_builder_tools")

builder_tools = module_extension(
    implementation = _builder_tools_ext_impl,
    tag_classes = {
        "builder": tag_class(
            doc = "Declares the pinned packaging toolset repository " +
                  "(@electron_builder_tools). Declare once.",
        ),
    },
)
