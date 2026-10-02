"""Packages an Electron app with electron-builder, hermetically.

The rule stages the project directory (dist/, node_modules, scripts,
resources) and runs the packager driver, which invokes electron-builder with:

- ELECTRON_CACHE pointing at a staged directory with the SHA-256-pinned
  Electron zip (electron_caches extension), so the binary is never fetched.
- ELECTRON_BUILDER_CACHE pointing at a staged, pre-populated toolset cache
  (builder_tools extension): AppImage, WinCodeSign, NSIS and dmgbuild
  archives extracted next to their pinned archives.
- HOME / XDG_CACHE_HOME / XDG_CONFIG_HOME redirected into the staging area.

The action declares "block-network": with the caches pre-populated the
packaging makes no network request, and any unexpected fetch or profile
write fails loudly. macOS signing targets (mas/pkg) still execute the host
Xcode signing tools offline; building Windows NSIS from Linux/macOS requires
Wine on the runner when icon stamping is enabled.

Output: a TreeArtifact holding the produced artifacts (.deb, .tar.gz,
.appimage, .dmg, ...).
"""

def _electron_builder_impl(ctx):
    out_dir = ctx.actions.declare_directory(ctx.attr.name)

    addon_files = []
    args = ctx.actions.args()
    args.add("--out", out_dir.path)
    args.add("--target", ctx.attr.target)
    args.add("--arch", ctx.attr.arch)
    args.add("--config", ctx.file.config.path)
    args.add("--package_json", ctx.file.package_json.path)
    args.add("--project_dir", ctx.label.package)
    args.add("--main", ctx.attr.app_main)
    args.add("--renderer_dir", ctx.attr.renderer_subdir)
    for entrypoint in ctx.attr.renderer_entrypoints:
        args.add("--renderer_entrypoint=" + entrypoint)

    for b in ctx.files.bundles:
        args.add("--bundle=" + b.path)
    for r in (ctx.files.renderer_bundle if ctx.attr.renderer_bundle else []):
        args.add("--renderer_bundle", r.path)
    for s in ctx.files.scripts:
        args.add("--script=" + s.path)
    for r in ctx.files.resources:
        args.add("--resource=" + r.path)
    for addon, pkg in ctx.attr.native_addons.items():
        for f in addon[DefaultInfo].files.to_list():
            args.add("--native_addon=%s=%s" % (pkg, f.path))
            addon_files.append(f)

    if ctx.attr.node_modules and ctx.files.node_modules:
        nm_dir = None
        for f in ctx.files.node_modules:
            d = f.dirname
            if d.endswith("/node_modules") and (nm_dir == None or len(d) < len(nm_dir)):
                nm_dir = d
        args.add("--node_modules", nm_dir)

    if ctx.attr.electron_cache and ctx.files.electron_cache:
        args.add("--electron_cache", ctx.files.electron_cache[0].path)

    builder_cache_files = []
    for f in ctx.files.builder_cache:
        # short_path for the external tools repository is
        # ../<canonical>/<release>/<filename>; the layout after the canonical
        # segment is what the packager mirrors into ELECTRON_BUILDER_CACHE.
        sp = f.short_path
        if sp.startswith("../"):
            sp = sp.split("/", 2)[2]
        args.add("--builder_tool=%s=%s" % (sp, f.path))
        builder_cache_files.append(f)

    for m in ctx.attr.packaged_node_modules:
        args.add("--packaged_module=" + m)

    if ctx.attr.extra_env:
        args.add("--extra_env", json.encode(ctx.attr.extra_env))

    inputs = depset(
        ctx.files.bundles +
        ctx.files.scripts +
        ctx.files.resources +
        ctx.files.config +
        ctx.files.package_json +
        (ctx.files.node_modules if ctx.attr.node_modules else []) +
        (ctx.files.electron_cache if ctx.attr.electron_cache else []) +
        (ctx.files.renderer_bundle if ctx.attr.renderer_bundle else []) +
        builder_cache_files +
        addon_files,
        transitive = [ctx.attr.runner[DefaultInfo].default_runfiles.files],
    )

    ctx.actions.run(
        executable = ctx.executable.runner,
        inputs = inputs,
        outputs = [out_dir],
        arguments = [args],
        mnemonic = "ElectronBuilder",
        progress_message = "Packaging Electron app (%{input})",
        execution_requirements = {"block-network": "1"},
        env = {"BAZEL_BINDIR": "."},
    )

    return [DefaultInfo(files = depset([out_dir]))]

electron_builder = rule(
    implementation = _electron_builder_impl,
    attrs = {
        "app_main": attr.string(
            default = "index.js",
            doc = "Main-process entry point inside the package.",
        ),
        "arch": attr.string(
            default = "x64",
            doc = "Target architecture: x64, arm64, ia32, universal.",
        ),
        "builder_cache": attr.label_list(
            allow_files = True,
            doc = "The pinned packaging toolset archives (@electron_builder_tools " +
                  "filegroups); pre-populates ELECTRON_BUILDER_CACHE so no toolset " +
                  "is downloaded.",
        ),
        "renderer_bundle": attr.label(
            doc = "Bundle staged at dist/<renderer_subdir>/ instead of the dist root.",
        ),
        "bundles": attr.label_list(
            doc = "Bundle output directories staged into dist/ (main, preload, renderer).",
            allow_files = True,
        ),
        "config": attr.label(
            mandatory = True,
            allow_single_file = True,
            doc = "electron-builder.json config file.",
        ),
        "electron_cache": attr.label(
            doc = "The pinned Electron zip (electron_caches extension); pre-populates " +
                  "ELECTRON_CACHE so the binary is never downloaded.",
        ),
        "extra_env": attr.string_dict(
            doc = "Extra environment variables for electron-builder.",
        ),
        "native_addons": attr.label_keyed_string_dict(
            doc = ".node targets injected into the staged node_modules, valued by their npm package name.",
        ),
        "node_modules": attr.label(
            doc = "The linked node_modules target of the app.",
        ),
        "packaged_node_modules": attr.string_list(
            doc = "Extra npm package names force-shipped into the package node_modules " +
                  "(runtime requires the files matcher would drop).",
        ),
        "package_json": attr.label(
            mandatory = True,
            allow_single_file = True,
            doc = "package.json (used for app metadata).",
        ),
        "renderer_entrypoints": attr.string_list(
            default = ["index.html", "welcomeScreen.html"],
            doc = "HTML entrypoints (renderer-root-relative) validated after staging.",
        ),
        "renderer_subdir": attr.string(
            default = "renderer",
            doc = "dist/ subdirectory where the renderer bundle lands ('.' = dist root).",
        ),
        "resources": attr.label_list(
            allow_files = True,
            doc = "Additional resource files/dirs staged preserving their package-relative paths.",
        ),
        "runner": attr.label(
            mandatory = True,
            executable = True,
            cfg = "exec",
            doc = "js_binary target wrapping the packager driver with the app's node_modules.",
        ),
        "scripts": attr.label_list(
            allow_files = True,
            doc = "electron-builder lifecycle scripts (afterpack, afterSign, afterAllArtifactBuild).",
        ),
        "target": attr.string(
            mandatory = True,
            doc = "electron-builder target: deb, tar.gz, appimage, rpm, nsis, dmg, mas, etc.",
        ),
    },
)
