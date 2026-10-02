"""Electron dev target: launches the app against pre-built bundles.

The executable is a compiled native stub running node on a driver script.
The driver stages the bundles into an ephemeral dist/ layout, extracts the
pinned Electron zip (electron_caches), symlinks the linked node_modules, and
executes the Electron binary with stdio inherited and signals forwarded.
The stage is removed on exit; bundle changes require re-running bazel run.
"""

load("@hermetic_launcher//launcher:lib.bzl", "launcher")
load("//private/helpers:js_stub_binary.bzl", "js_stub_binary")

def _electron_dev_impl(ctx):
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo.node

    def runfiles_rel(file):
        sp = file.short_path
        return sp[3:] if sp.startswith("../") else sp

    bundle_rels = [{"src": runfiles_rel(f), "dest": "dist"} for f in ctx.files.bundles]
    electron_zip_rel = runfiles_rel(ctx.file.electron_zip) if ctx.attr.electron_zip else "-"
    native_addon_args = []
    for addon, pkg in ctx.attr.native_addons.items():
        for f in addon[DefaultInfo].files.to_list():
            native_addon_args.append({"pkg": pkg, "rel": runfiles_rel(f)})
    packaged_modules = sorted(set(ctx.attr.packaged_node_modules +
                                  [a["pkg"] for a in native_addon_args]))
    resource_args = []
    resource_paths = []
    for f in ctx.files.resources:
        rel = runfiles_rel(f)
        dest = rel[len(ctx.label.package) + 1:] if ctx.label.package else rel
        resource_args.append({"src": rel, "dest": dest})
        resource_paths.append(rel)

    nm_dir = None
    for f in ctx.files.node_modules:
        d = f.dirname
        if d.endswith("/node_modules") and (nm_dir == None or len(d) < len(nm_dir)):
            nm_dir = d

    manifest = ctx.actions.declare_file(ctx.label.name + "_manifest.json")
    ctx.actions.write(
        output = manifest,
        content = json.encode({
            "app_main": ctx.attr.app_main,
            "bundles": bundle_rels,
            "resources": resource_args,
            "packaged_modules": packaged_modules,
            "native_addons": native_addon_args,
            "node_modules_root": nm_dir,
        }),
    )

    executable = js_stub_binary(
        ctx,
        node,
        ctx.file._driver,
        runfiles = [manifest, ctx.file.package_json] +
                   ([ctx.file.electron_zip] if ctx.attr.electron_zip else []),
        embedded_args = [
            str(len(bundle_rels)),
            str(len(resource_args)),
            ctx.attr.app_main,
        ],
    )

    runfiles = ctx.runfiles(
        files = [ctx.file.package_json, ctx.file._driver, node, manifest] +
                list(ctx.files.bundles) +
                list(ctx.files.resources) +
                [f for addon in ctx.attr.native_addons for f in addon[DefaultInfo].files.to_list()] +
                ([ctx.file.electron_zip] if ctx.attr.electron_zip else []),
        transitive_files = depset(transitive = [
            dep[DefaultInfo].files
            for dep in ctx.attr.node_modules
        ]),
    )

    return [
        DefaultInfo(executable = executable, runfiles = runfiles),
        RunEnvironmentInfo(environment = dict(ctx.attr.env)),
    ]

_electron_dev = rule(
    implementation = _electron_dev_impl,
    attrs = {
        "app_main": attr.string(
            doc = "Entry point relative to dist/ that package.json main resolves to.",
            default = "index.js",
        ),
        "bundles": attr.label_list(
            doc = "Bundle outputs staged into dist/ (contents merged).",
            allow_files = True,
        ),
        "electron_zip": attr.label(
            allow_single_file = True,
            doc = "The pinned Electron zip (electron_caches) for the host platform; " +
                  "extracted and executed instead of any node_modules binary.",
        ),
        "env": attr.string_dict(
            doc = "Extra environment variables for the app.",
        ),
        "native_addons": attr.label_keyed_string_dict(
            doc = ".node files injected into the staged node_modules, keyed by " +
                  "package name.",
        ),
        "node_modules": attr.label_list(
            doc = "Linked node_modules targets symlinked into the stage (runtime deps).",
        ),
        "packaged_node_modules": attr.string_list(
            doc = "npm package names copied as real dirs into the staged " +
                  "node_modules (runtime requires the symlink cannot serve).",
        ),
        "resources": attr.label_list(
            allow_files = True,
            doc = "Resource files staged preserving their package-relative paths " +
                  "(e.g. the plain-JS main process under electron/).",
        ),
        "package_json": attr.label(
            allow_single_file = True,
            doc = "The app package.json, staged at the stage root.",
        ),
        "_driver": attr.label(
            allow_single_file = True,
            default = Label("//private/tools:dev_driver.mjs"),
        ),
    },
    executable = True,
    toolchains = [
        launcher.finalizer_toolchain_type,
        launcher.template_toolchain_type,
        "@rules_nodejs//nodejs:toolchain_type",
    ],
)

def electron_dev(
        name,
        bundles,
        package_json,
        electron_zip = None,
        node_modules = [],
        native_addons = None,
        packaged_node_modules = None,
        app_main = "index.js",
        env = {},
        tags = [],
        visibility = None,
        **kwargs):
    """Launches the Electron app in development mode (`bazel run`).

    Stages bundles into an ephemeral dist/, extracts the pinned Electron zip
    and executes it against the stage. Stdio is inherited; Ctrl+C reaches the
    app. The stage is removed on exit.

    Args:
        name: Target name.
        bundles: Bundle outputs staged into dist/ (contents merged).
        package_json: The app package.json (its main field selects the entry).
        electron_zip: Pinned Electron zip for the host platform; pass a
            select() across the electron_caches targets.
        node_modules: Linked node_modules targets symlinked into the stage.
        native_addons: .node files injected into the staged node_modules,
            keyed by package name.
        packaged_node_modules: npm package names copied as real dirs into
            the staged node_modules.
        app_main: Entry point under dist/ (informational; package.json main
            governs).
        env: Extra environment variables for the app.
        tags: Standard tags.
        visibility: Standard visibility (None = package default).
        **kwargs: Forwarded to the rule.
    """
    _electron_dev(
        name = name,
        app_main = app_main,
        bundles = bundles,
        electron_zip = electron_zip,
        native_addons = native_addons,
        packaged_node_modules = packaged_node_modules,
        env = env,
        node_modules = node_modules,
        package_json = package_json,
        tags = tags,
        visibility = visibility,
        **kwargs
    )
