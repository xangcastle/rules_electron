"""SHA-256 pins for the hermetic Electron build toolsets.

electron_caches: official Electron zips (the binary electron-builder embeds),
one repository per version/platform/arch, downloaded lazily on first use.

node_headers: the Node headers tarballs for compiling N-API addons against a
given Electron release line (published at electronjs.org/headers).

builder_tools: the packaging toolsets electron-builder downloads on demand
(AppImage, WinCodeSign, NSIS, dmgbuild), pre-pinned so packaging runs with
the network blocked. Sources: electron-userland/electron-builder-binaries
releases; the dmgbuild sha256s are the ones embedded in electron-builder's
own dmgUtil.ts.
"""

_ASSET_PLATFORM = {
    "macos": "darwin",
    "windows": "win32",
}

_ELECTRON_SHAS = {
    "37.6.1": {
        "darwin-arm64": "90283ffbf443f3675deaad5b5c8011e04418d87215a0788e74056d5613e6dc84",
        "darwin-x64": "c6840760d48163badc3f253a4a6d6c432ab582b4df304389a1123f90d8313ed4",
        "linux-arm64": "0e6a05cc3cdb2b2434b83284a33f50c448b15c85d762595770daf8eddd6d76ba",
        "linux-x64": "d2bf4fe94de47fb28d45911fbbadb91acf42ee64dc96033797a80515dbec3965",
        "win32-arm64": "bbf39ee45ea12d92263553214a4bd75ff3a800e25fc291fcb39d2b6757ec1761",
        "win32-x64": "12766a649339a2736cd9d87a24c6859c6ab48aaa6d5ec72ff9f0b03dd951da9d",
    },
    "36.9.0": {
        "darwin-arm64": "2173b703277ee73d07b23789e78ef4d5d9b520070593c38b94ecaeddfb1d242c",
        "darwin-x64": "1d87cdc08ceeb8bf6e0621697277d0a1560d1cb7cae59eed6e83fa106b26cce5",
        "win32-arm64": "9cd46c3823e1ba05af7aea1d807f405dbfcf8b6023378cc980a01467c111dcdb",
        "win32-x64": "65fe66e6c2cd1257c896aed661a0de1eb585305065ec748f8150c4de40948881",
    },
    "29.3.0": {
        "darwin-arm64": "b3145bbd45007918c2365b1df59a35b4d0636222cd43eea4803580de36b9a17d",
        "darwin-x64": "88873a315ddd2a70b82e83f2cb7495c0d9d7c7fb5c9ad14fcfee16af4ab89d5e",
        "linux-arm64": "bd74743eb03a77f40b65739b9ca751af264c6f428e16728d7e0332a4c94789a9",
        "linux-x64": "7274fe2bbb2e3b71f8fc084921e22d10e529220d380a354827b274f9567261da",
        "win32-arm64": "15a003da0779be6d3192c25d6170a43e16fee6cf76de85f1f41a255d687bd3ba",
        "win32-x64": "4c7adf366cd0747d072aec23ff22837c9b016336a0bc26d64bffdd7869ad4bd2",
    },
    "20.1.3": {
        "darwin-arm64": "a09f83442f1e9f4b1edc07445a1dca73d9597529b23d62731eaa3fa0488f4ab0",
        "darwin-x64": "134714291dcbecbf10cbc27c490a6501e2810bd4147a74f3b2671503445f2ce8",
        "linux-arm64": "8f39562f20210d7cdedbb063683d632df442c8553f62104c7d676121f3d9a357",
        "linux-x64": "219fb6f01305669f78cf1881d257e3cc48e5563330338516f8b6592d85fdb4a3",
        "win32-arm64": "f3e04391adfb1fb1b55381198108274679fce5cf90a8abb7200ec1cbaad4128a",
        "win32-x64": "4bcd4a58efd584a5a6d61ca824fa56ce2fca20c42bc5b685ad8d32643d96ceb5",
    },
}

_HEADERS_SHAS = {
    "29.3.0": "25a44510bd7de8b085b1bccdc353d0745b76ae49b26f0760a5518ddb1e95bbea",
    "37.6.1": "9436cc46b45139cba2bc785776abd9884bc927ee43140a387c6574242d7ff05b",
}

def _electron_cache_impl(rctx):
    plat, arch = rctx.attr.platform_arch.split("-", 1)
    asset_platform = _ASSET_PLATFORM.get(plat, plat)
    asset_key = "%s-%s" % (asset_platform, arch)
    shas = _ELECTRON_SHAS.get(rctx.attr.version, {})
    sha = shas.get(asset_key)
    if not sha:
        fail(
            "electron_caches: no pinned sha256 for electron %s %s; add it to " % (rctx.attr.version, asset_key) +
            "_ELECTRON_SHAS in @rules_electron//electron:caches.bzl (source: SHASUMS256.txt of the release).",
        )
    filename = "electron-v%s-%s-%s.zip" % (rctx.attr.version, asset_platform, arch)
    rctx.download(
        url = "https://github.com/electron/electron/releases/download/v%s/%s" % (rctx.attr.version, filename),
        sha256 = sha,
        output = filename,
    )
    rctx.file(
        "BUILD.bazel",
        "\n".join([
            "filegroup(",
            "    name = \"zip\",",
            "    srcs = [\"%s\"]," % filename,
            "    visibility = [\"//visibility:public\"],",
            ")",
        ]),
    )

_electron_cache = repository_rule(
    implementation = _electron_cache_impl,
    attrs = {
        "platform_arch": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)

def _electron_caches_impl(module_ctx):
    for mod in module_ctx.modules:
        for tag in mod.tags.cache:
            version_tag = "v" + tag.version.replace(".", "_")
            for platform_arch in tag.platforms:
                _electron_cache(
                    name = "electron_cache_%s_%s" % (version_tag, platform_arch.replace("-", "_")),
                    platform_arch = platform_arch,
                    version = tag.version,
                )

electron_caches = module_extension(
    implementation = _electron_caches_impl,
    tag_classes = {
        "cache": tag_class(
            attrs = {
                "platforms": attr.string_list(
                    mandatory = True,
                    doc = "Platform-arch combos in electron_app naming (linux/macos/windows + x64/arm64).",
                ),
                "version": attr.string(
                    mandatory = True,
                    doc = "Electron version; keep in sync with the electron devDependency of the app.",
                ),
            },
        ),
    },
)

def _node_headers_impl(rctx):
    sha = _HEADERS_SHAS.get(rctx.attr.version)
    if not sha:
        fail(
            "node_headers: no pinned sha256 for node headers %s; add it to " % rctx.attr.version +
            "_HEADERS_SHAS in @rules_electron//electron:caches.bzl.",
        )
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
