"""Module extensions for the hermetic Electron caches and packaging toolsets.

    builder_tools = use_extension("@rules_electron//:extensions.bzl", "builder_tools")
    builder_tools.builder()
    use_repo(builder_tools, "electron_builder_tools")

    caches = use_extension("@rules_electron//:extensions.bzl", "electron_caches")
    caches.cache(version = "37.6.1", platforms = ["linux-x64", "macos-arm64"])
    use_repo(caches, "electron_cache_v37_6_1_linux_x64")
"""

load("//private:caches.bzl", _electron_caches = "electron_caches")
load("//private:tools.bzl", _builder_tools = "builder_tools")

builder_tools = _builder_tools
electron_caches = _electron_caches
