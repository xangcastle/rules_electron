"""Public API of rules_electron."""

load("//private:addon.bzl", _node_addon = "node_addon")
load("//private:app.bzl", _electron_app = "electron_app")
load("//private:builder.bzl", _electron_builder = "electron_builder")
load("//private:dev.bzl", _electron_dev = "electron_dev")

electron_app = _electron_app
electron_builder = _electron_builder
electron_dev = _electron_dev
node_addon = _node_addon
