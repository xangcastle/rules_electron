"""Hermetic Electron caches derived from the app's own package.json.

electron_caches: one repository per declared app, with the Electron zips for
the version the APP's package.json declares (dependencies or
devDependencies) — the same source electron-builder reads — and checksums
taken from that release's SHASUMS256.txt, the same trust model as
electron's own installer. No manual version or checksum tables: bump the
electron devDependency and the cache follows.

For stricter pinning (air-gapped, mirrored): each tag accepts `mirror`
(URL prefixes tried first) and `shasums_sha256` (the checksum OF the
SHASUMS256.txt file itself).

node_headers: the Node headers tarballs for compiling N-API addons against
a given Electron release line (published at electronjs.org/headers).

builder_tools: the packaging toolsets electron-builder downloads on demand
(AppImage, WinCodeSign, NSIS, dmgbuild), pre-pinned so packaging runs with
the network blocked. Sources: electron-userland/electron-builder-binaries
releases; the dmgbuild sha256s are the ones embedded in electron-builder's
own dmgUtil.ts.
"""

def _read_electron_version(package_json_content):
    content = json.decode(package_json_content)
    for section in ("dependencies", "devDependencies"):
        deps = content.get(section, {})
        if "electron" in deps:
            return deps["electron"].lstrip("^~>=< v ")
    fail("electron_caches: no electron dependency found in the given " +
         "package.json; add electron to dependencies or devDependencies " +
         "so the cache version can be derived.")

def _electron_cache_repo_impl(rctx):
    version = rctx.attr.version
    base = "%s/v%s" % (rctx.attr.mirror.rstrip("/"), version)

    shasums_name = "SHASUMS256.txt"
    shasums_kwargs = {"sha256": rctx.attr.shasums_sha256} if rctx.attr.shasums_sha256 else {}
    rctx.download(
        url = base + "/" + shasums_name,
        output = shasums_name,
        **shasums_kwargs
    )

    build_lines = ["exports_files(glob([\"*.zip\"]))"]
    for platform, archs in sorted(rctx.attr.platforms.items()):
        asset_platform = {"macos": "darwin", "windows": "win32"}.get(platform, platform)
        for arch in archs:
            filename = "electron-v%s-%s-%s.zip" % (version, asset_platform, arch)
            sha = _shasum_for(rctx.read(shasums_name), filename)
            rctx.download(
                url = base + "/" + filename,
                sha256 = sha,
                output = filename,
            )
            build_lines.extend([
                "filegroup(",
                "    name = \"zip_%s_%s\"," % (platform, arch),
                "    srcs = [\"%s\"]," % filename,
                "    visibility = [\"//visibility:public\"],",
                ")",
            ])
    rctx.file("BUILD.bazel", "\n".join(build_lines) + "\n")

_electron_cache_repo = repository_rule(
    implementation = _electron_cache_repo_impl,
    attrs = {
        "mirror": attr.string(
            default = "https://github.com/electron/electron/releases/download",
            doc = "Base URL serving /v<version>/<file> (SHASUMS256.txt and zips).",
        ),
        "platforms": attr.string_list_dict(
            mandatory = True,
            doc = "electron_app platform -> arch list, e.g. " +
                  "{\"linux\": [\"x64\"], \"macos\": [\"arm64\"]}.",
        ),
        "shasums_sha256": attr.string(
            doc = "Optional checksum of SHASUMS256.txt itself, for fully " +
                  "pinned setups.",
        ),
        "version": attr.string(mandatory = True),
    },
)

def _shasum_for(shasums_content, filename):
    for line in shasums_content.splitlines():
        line = line.strip()
        sep = line.find(" ")
        target = line[sep:].strip().lstrip("*")
        if target == filename:
            return line[:sep]
    fail("electron_caches: %s not found in SHASUMS256.txt; check the " % filename +
         "electron version and platform-arch combos.")

def _electron_caches_impl(module_ctx):
    seen = {}
    for mod in module_ctx.modules:
        for tag in mod.tags.cache:
            version = _read_electron_version(module_ctx.read(module_ctx.path(tag.package_json)))
            if version in seen:
                continue
            seen[version] = tag.package_json
            repo_name = "electron_cache_v" + version.replace(".", "_")
            _electron_cache_repo(
                name = repo_name,
                platforms = tag.platforms,
                version = version,
                mirror = tag.mirror,
                shasums_sha256 = tag.shasums_sha256,
            )

electron_caches = module_extension(
    implementation = _electron_caches_impl,
    tag_classes = {
        "cache": tag_class(
            attrs = {
                "mirror": attr.string(
                    default = "https://github.com/electron/electron/releases/download",
                    doc = "Base URL serving /v<version>/<file>.",
                ),
                "package_json": attr.label(
                    mandatory = True,
                    doc = "The app package.json; its electron dependency version " +
                          "drives the cache.",
                ),
                "platforms": attr.string_list_dict(
                    mandatory = True,
                    doc = "electron_app platform -> arch list, e.g. " +
                          "{\"linux\": [\"x64\"], \"macos\": [\"arm64\"]}.",
                ),
                "shasums_sha256": attr.string(
                    doc = "Optional checksum of SHASUMS256.txt itself.",
                ),
            },
        ),
    },
)

_HEADERS_SHAS = {
    "29.3.0": "25a44510bd7de8b085b1bccdc353d0745b76ae49b26f0760a5518ddb1e95bbea",
    "37.6.1": "9436cc46b45139cba2bc785776abd9884bc927ee43140a387c6574242d7ff05b",
}

def _node_headers_impl(rctx):
    sha = _HEADERS_SHAS.get(rctx.attr.version)
    if not sha:
        fail("node_headers: no pinned sha256 for node headers %s; add it to " % rctx.attr.version +
             "_HEADERS_SHAS in @rules_electron//private:caches.bzl.")
    rctx.download_and_extract(
        url = "https://electronjs.org/headers/v%s/node-v%s-headers.tar.gz" % (rctx.attr.version, rctx.attr.version),
        sha256 = sha,
        strip_prefix = "node_headers",
    )
    rctx.file(
        "BUILD.bazel",
        "\n".join([
            "filegroup(",
            "    name = \"node_api_h\",",
            "    srcs = [\"include/node/node_api.h\"],",
            "    visibility = [\"//visibility:public\"],",
            ")",
        ]),
    )

node_headers = repository_rule(
    implementation = _node_headers_impl,
    attrs = {
        "version": attr.string(
            mandatory = True,
            doc = "Electron version; the headers line up with its embedded Node.",
        ),
    },
)
