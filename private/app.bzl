"""Public macro for Electron applications.

Creates the standard target family for one app:

- <name>.dev                    launches the app in development mode (bazel run)
- <name>.packager               the js_binary runner shared by packaging actions
- <name>.package.<target>.<arch>  packaged artifact per electron-builder target
- <name>.package.<target>       one target across all archs
- <name>.package.<platform>     all artifacts of a platform (linux/macos/windows)
- <name>.package                linux + windows artifacts (CI defaults)

The app's bundles are inputs, not generated here: webpack (aspect_rules_webpack),
vite (rules_vite) or plain filegroups all work — whatever produces the dist
layout is the consumer's choice. The hermeticity inputs come from the
electron_cache (Electron binary) and builder_tools (packaging
toolsets) module extensions, both shipped by this ruleset.
"""

load("@aspect_rules_js//js:defs.bzl", "js_binary")
load("//private:addon.bzl", _node_addon = "node_addon")
load("//private:builder.bzl", _electron_builder = "electron_builder")
load("//private:dev.bzl", _electron_dev = "electron_dev")

node_addon = _node_addon

_MACOS_TARGETS = ["dmg", "mas", "mas-dev", "pkg"]
_WINDOWS_TARGETS = ["nsis", "squirrel.windows", "msi", "portable", "appx", "zip"]

_TARGET_TOOLS = {
    "appimage": ["appimage"],
    "dmg": ["dmgbuild"],
    "mas": ["dmgbuild"],
    "mas-dev": ["dmgbuild"],
    "pkg": ["dmgbuild"],
    "nsis": ["win_code_sign", "nsis", "nsis_resources"],
    "portable": ["win_code_sign", "nsis", "nsis_resources"],
    "appx": ["win_code_sign"],
}

def _tool_labels(required_tools, builder_tools):
    labels = []
    for tool in required_tools:
        if tool == "dmgbuild":
            # The dmgbuild/python tooling runs on the HOST to assemble the DMG
            # for any target arch: both host bundles are required.
            labels.append(builder_tools + "//:dmgbuild_arm64")
            labels.append(builder_tools + "//:dmgbuild_x86_64")
        else:
            labels.append(builder_tools + "//:" + tool)
    return labels

def _host_electron_zip(electron_cache):
    """A select() over the host OS picking the cached Electron zip, or None."""
    if not electron_cache:
        return None
    branches = {}
    for os_label, key in [
        ("@platforms//os:linux", "zip_linux_x64"),
        ("@platforms//os:macos", "zip_macos_arm64"),
        ("@platforms//os:windows", "zip_windows_x64"),
    ]:
        branches[os_label] = electron_cache + "//:" + key
    branches["//conditions:default"] = electron_cache + "//:zip_linux_x64"
    return select(branches)

def electron_app(
        name,
        node_modules,
        package_json,
        electron_builder_config,
        bundles,
        renderer = None,
        renderer_subdir = "renderer",
        renderer_entrypoints = None,
        app_main = "index.js",
        runner_tools = None,
        scripts = None,
        resources = None,
        env = None,
        targets = None,
        archs = None,
        electron_cache = None,
        builder_tools = None,
        packaged_node_modules = None,
        dev_args = None,
        native_addons = None,
        visibility = None,
        **kwargs):
    """Creates all targets for an Electron application.

    Args:
        name: Base name, must end with '_app'.
        node_modules: The npm_link_all_packages target of the app.
        package_json: Label of the app package.json.
        electron_builder_config: Label of the electron-builder.json config.
        bundles: Dict kind -> bundle output label staged into dist/ (contents
            merged; webpack bundles, vite outputs, or filegroups).
        renderer: Optional label staged at dist/<renderer_subdir>/ instead of
            the dist root (e.g. a vite output that owns its layout).
        renderer_subdir: dist/ subdirectory for the renderer ('renderer' by
            default, '.' to keep the renderer's own layout).
        renderer_entrypoints: HTML entrypoints (renderer-root-relative)
            validated after staging. Default: index.html + welcomeScreen.html.
        app_main: Main-process entry inside the package ('index.js' default;
            '.webpack/main' for forge layouts, 'electron/main.js' for
            plain-JS mains).
        runner_tools: npm packages the packager needs at runtime. Default:
            electron-builder + 7zip-bin (fuses-flipping apps add
            @electron/fuses); 7zip-bin is always appended (it extracts the
            packaging toolsets) and must be a dependency of the app.
        scripts: electron-builder lifecycle scripts (afterpack, afterSign,
            afterAllArtifactBuild); *.bazel.js variants are wired automatically.
        resources: Additional resources staged preserving package-relative paths.
        env: Env vars for packaging and the dev target.
        targets: electron-builder targets (e.g. tar.gz, appimage, deb, nsis,
            dmg, mas). Default: ['tar.gz'].
        archs: Architectures (default ['x64']).
        electron_cache: Repository name of the Electron zip cache from the
            electron_caches extension (e.g. "@electron_cache_v37_6_1",
            with the version derived from this app's package.json).
            Packaging never downloads the Electron binary when provided;
            the dev target requires it for the host platform.
        builder_tools: Repository name of the packaging toolset cache
            ("@electron_builder_tools", from the builder_tools extension).
            Required for appimage/dmg/nsis targets.
        packaged_node_modules: Extra npm package names force-shipped into the
            package's node_modules (runtime requires the files matcher would
            drop, e.g. native-addon helpers).
        dev_args: Extra args for the dev target (passed to electron).
        native_addons: Dict arch -> {npm package name: [node_addon targets]}.
            Only macOS targets consume addons.
        visibility: Standard visibility (None = package default).
        **kwargs: Forwarded to the generated rules.
    """
    if not name.endswith("_app"):
        fail("electron_app(%s): name must end with '_app'" % name)
    app_name = name[:-4]

    if renderer_entrypoints == None:
        renderer_entrypoints = ["index.html", "welcomeScreen.html"]
    if runner_tools == None:
        runner_tools = ["electron-builder", "7zip-bin"]
    if "7zip-bin" not in runner_tools:
        # Required to extract the pinned packaging toolsets.
        runner_tools.append("7zip-bin")
    if scripts == None:
        scripts = []
    if resources == None:
        resources = []
    if targets == None:
        targets = ["tar.gz"]
    if archs == None:
        archs = ["x64"]
    if env == None:
        env = {"NODE_ENV": "production"}
    if electron_cache == None:
        electron_cache = None
    if packaged_node_modules == None:
        packaged_node_modules = []
    if dev_args == None:
        dev_args = []

    bundle_labels = [bundles[kind] for kind in sorted(bundles.keys())]

    _electron_dev(
        name = app_name + ".dev",
        app_main = app_main,
        bundles = bundle_labels + ([renderer] if renderer else []),
        electron_zip = _host_electron_zip(electron_cache),
        env = env,
        native_addons = {
            label: pkg
            for arch, pkgs in (native_addons or {}).items()
            for pkg, labels in pkgs.items()
            for label in labels
        },
        node_modules = [node_modules],
        packaged_node_modules = packaged_node_modules,
        package_json = package_json,
        resources = resources,
        args = dev_args,
        visibility = visibility,
        **kwargs
    )

    packager_name = app_name + ".packager"
    js_binary(
        name = packager_name,
        entry_point = "@rules_electron//private/tools:packager_mjs",
        data = [node_modules] + [node_modules + "/" + tool for tool in runner_tools],
        env = {"BAZEL_BINDIR": "."},
        visibility = visibility,
    )

    pkg_by_platform = {"linux": [], "macos": [], "windows": []}

    for target in targets:
        safe = target.replace(".", "_").replace("-", "_")
        if target in _MACOS_TARGETS:
            plat = "macos"
        elif target in _WINDOWS_TARGETS:
            plat = "windows"
        else:
            plat = "linux"

        required_tools = _TARGET_TOOLS.get(target, [])
        if required_tools and not builder_tools:
            fail(
                "electron_app(%s): target %s needs the packaging toolsets; " % (name, target) +
                "declare the builder_tools extension and pass " +
                "\"@electron_builder_tools\" as builder_tools.",
            )

        for arch in archs:
            label = "%s.package.%s.%s" % (app_name, safe, arch)
            cache_key = "%s-%s" % (plat, arch)
            builder_kwargs = dict(
                bundles = bundle_labels,
                renderer_bundle = renderer,
                config = electron_builder_config,
                package_json = package_json,
                scripts = scripts,
                resources = resources,
                node_modules = node_modules,
                runner = ":" + packager_name,
                target = target,
                arch = arch,
                app_main = app_main,
                renderer_subdir = renderer_subdir,
                renderer_entrypoints = renderer_entrypoints,
                extra_env = env,
                packaged_node_modules = packaged_node_modules,
                visibility = visibility,
            )
            if kwargs:
                builder_kwargs.update(kwargs)
            if target in _MACOS_TARGETS:
                builder_kwargs["target_compatible_with"] = ["@platforms//os:macos"]
                addons = (native_addons or {}).get(arch)
                if addons:
                    builder_kwargs["native_addons"] = {
                        label: pkg
                        for pkg, labels in addons.items()
                        for label in labels
                    }
            if electron_cache:
                builder_kwargs["electron_cache"] = electron_cache + "//:zip_" + cache_key.replace("-", "_")
            if required_tools:
                builder_kwargs["builder_cache"] = _tool_labels(required_tools, builder_tools)
            _electron_builder(
                name = label,
                **builder_kwargs
            )
            pkg_by_platform[plat].append(":" + label)

        native.filegroup(
            name = "%s.package.%s" % (app_name, safe),
            srcs = [":%s.package.%s.%s" % (app_name, safe, a) for a in archs],
            visibility = visibility,
        )

    for plat, plat_srcs in pkg_by_platform.items():
        if plat_srcs:
            native.filegroup(
                name = "%s.package.%s" % (app_name, plat),
                srcs = plat_srcs,
                visibility = visibility,
            )

    aggregate = pkg_by_platform["linux"] + pkg_by_platform["windows"]
    if aggregate:
        native.filegroup(
            name = app_name + ".package",
            srcs = aggregate,
            visibility = visibility,
        )
