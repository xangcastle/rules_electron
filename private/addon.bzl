"""Compilation of N-API native addons (.node) for macOS.

The addons are N-API only (ABI-stable): compiling against the headers of the
Electron version in use produces a binary valid for that whole release line,
no per-module rebuild needed.

Concession: the action runs without the sandbox because it needs the host
Xcode toolchain (xcrun clang++) and the macOS SDK frameworks. It stays
offline: nothing is downloaded.
"""

def _node_addon_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.name)

    args = ctx.actions.args()
    args.add_all([
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-arch",
        ctx.attr.arch,
        "-std=c++17",
        "-stdlib=libc++",
        "-mmacosx-version-min=10.13",
        "-DNODE_GYP_MODULE_NAME=" + ctx.attr.module_name,
        "-I" + ctx.file.node_headers.dirname,
    ])
    for inc in ctx.files.includes:
        args.add("-I" + inc.dirname)
    args.add_all(ctx.attr.defines, format_each = "-D%s")
    for fw in ctx.attr.frameworks:
        args.add("-framework", fw)
    for fw in ctx.attr.weak_frameworks:
        args.add("-weak_framework", fw)
    args.add("-o", out.path)
    args.add_all(ctx.files.srcs)

    ctx.actions.run_shell(
        inputs = depset(ctx.files.srcs + [ctx.file.node_headers] + ctx.files.includes),
        outputs = [out],
        arguments = [args],
        command = 'exec xcrun --sdk macosx clang++ "$@"',
        mnemonic = "NodeAddon",
        progress_message = "Compiling node addon %{output}",
        execution_requirements = {"no-sandbox": "1"},
    )

    return [DefaultInfo(files = depset([out]))]

node_addon = rule(
    implementation = _node_addon_impl,
    attrs = {
        "arch": attr.string(
            default = "arm64",
            doc = "Target architecture: arm64 or x86_64.",
        ),
        "defines": attr.string_list(
            doc = "Extra -D defines (e.g. NAPI_DISABLE_CPP_EXCEPTIONS).",
        ),
        "frameworks": attr.string_list(
            doc = "macOS frameworks to link (-framework).",
        ),
        "includes": attr.label_list(
            allow_files = True,
            doc = "Single header files whose dirname is added as -I (e.g. node-addon-api/napi.h).",
        ),
        "module_name": attr.string(
            mandatory = True,
            doc = "NODE_GYP_MODULE_NAME; must match the require() name in the addon sources.",
        ),
        "node_headers": attr.label(
            mandatory = True,
            allow_single_file = True,
            doc = "node_api.h from the electron_caches node_headers repository; its dirname is the -I.",
        ),
        "srcs": attr.label_list(
            allow_files = True,
            doc = ".cc/.mm sources of the addon.",
        ),
        "weak_frameworks": attr.string_list(
            doc = "macOS frameworks to weak-link (-weak_framework).",
        ),
    },
)
