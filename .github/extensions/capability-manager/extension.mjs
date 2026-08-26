// The canvas source lives with the plugin it ships inside. This re-export makes
// it discoverable by the CLI's `.github/extensions/` scan while developing in
// this repo, without keeping a second copy of the implementation.
import "../../../packages/copilot-plugin/canvas/capability-manager/extension.mjs";
