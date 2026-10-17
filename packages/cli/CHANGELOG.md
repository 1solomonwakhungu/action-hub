# Changelog

## 0.1.0 (2026-10-17)


### Features

* **auth:** OAuth 2.0 and refresh-token rotation for remote MCP servers ([#23](https://github.com/1solomonwakhungu/action-hub/issues/23)) ([492e514](https://github.com/1solomonwakhungu/action-hub/commit/492e5149a0e345c4e67aa5714920d8009fd9b67e))
* **bundles:** action-hub bundle --export prints a bundle as JSON ([#43](https://github.com/1solomonwakhungu/action-hub/issues/43)) ([712a57c](https://github.com/1solomonwakhungu/action-hub/commit/712a57cac67e84951875bcec29165e3ff66a9dea))
* **cli:** Action Hub Developer CLI suite ([e828c4d](https://github.com/1solomonwakhungu/action-hub/commit/e828c4d87cc72b70145d31530c6672235e371bcb))
* **cli:** action-hub harness setup/export command (packet 3) ([#40](https://github.com/1solomonwakhungu/action-hub/issues/40)) ([7da99b2](https://github.com/1solomonwakhungu/action-hub/commit/7da99b2d840f0478baccea92ce4218ed273bea4f))
* **cli:** add Action Hub Developer CLI suite (Closes [#9](https://github.com/1solomonwakhungu/action-hub/issues/9)) ([47044d5](https://github.com/1solomonwakhungu/action-hub/commit/47044d5f6206b5ed9fc7aad98278123af3364eb9))
* **cli:** expand doctor diagnostics with redacted transport details ([#37](https://github.com/1solomonwakhungu/action-hub/issues/37)) ([11a180b](https://github.com/1solomonwakhungu/action-hub/commit/11a180bc8ca66cee58eece0df9629adc1a96fd21))
* **cli:** extend --source filters to multi-harness sources ([#38](https://github.com/1solomonwakhungu/action-hub/issues/38)) ([876f2b6](https://github.com/1solomonwakhungu/action-hub/commit/876f2b6004d0f25ac715700a93ccb5cdd62e6ad7))
* **core:** add OpenTelemetry observability and trace propagation ([#25](https://github.com/1solomonwakhungu/action-hub/issues/25)) ([97405f4](https://github.com/1solomonwakhungu/action-hub/commit/97405f49fa6c0e4d22524b6f91420ba008a833c1))
* **core:** circuit recovery, heartbeats, and Node memory limits ([#21](https://github.com/1solomonwakhungu/action-hub/issues/21)) ([8159b88](https://github.com/1solomonwakhungu/action-hub/commit/8159b883e75c8416edc4ac4b7d774087aba954a1))
* **core:** result caching for idempotent reads and tool annotation propagation ([#28](https://github.com/1solomonwakhungu/action-hub/issues/28)) ([593e428](https://github.com/1solomonwakhungu/action-hub/commit/593e428c57169d3e4442144f43b13b1e4ad7f8e7))
* **http:** Action Hub MCP over Streamable HTTP with bearer-token auth ([#31](https://github.com/1solomonwakhungu/action-hub/issues/31)) ([2eb51ab](https://github.com/1solomonwakhungu/action-hub/commit/2eb51abf3173fb998cdc4fb46f2f4d73abcfa386))
* **migration:** Universal capability migration for MCPs, skills, and plugins ([#19](https://github.com/1solomonwakhungu/action-hub/issues/19)) ([b1fc9a6](https://github.com/1solomonwakhungu/action-hub/commit/b1fc9a6b49e9ea4ae6201618c6dd02aaf8b2e065))
* **search:** local MiniLM embeddings for semantic search (SQ4 / F49 part 3) ([#92](https://github.com/1solomonwakhungu/action-hub/issues/92)) ([9bc2f9a](https://github.com/1solomonwakhungu/action-hub/commit/9bc2f9abd5ca3fc241b52bd9ba6c14006ebd9455))
* standalone binary packaging and release distribution ([#22](https://github.com/1solomonwakhungu/action-hub/issues/22)) ([212a6c3](https://github.com/1solomonwakhungu/action-hub/commit/212a6c3e7ead0578c2fee896e5bdbd32e9ddc66a))


### Bug Fixes

* **adapters:** remove stash conflict markers from SDK client adapters ([#29](https://github.com/1solomonwakhungu/action-hub/issues/29)) ([ade6874](https://github.com/1solomonwakhungu/action-hub/commit/ade6874044e5e185bfe2f727d2a88dbbb836d90a))
* **cli:** anchored, reuse-safe process-group teardown (F39/F39b) ([#77](https://github.com/1solomonwakhungu/action-hub/issues/77)) ([e8f2688](https://github.com/1solomonwakhungu/action-hub/commit/e8f2688a964b620ee2ce0985eb520d7209e6b3fc))
* **cli:** deterministic doctor under flapping servers (F17) ([#61](https://github.com/1solomonwakhungu/action-hub/issues/61)) ([8c357a0](https://github.com/1solomonwakhungu/action-hub/commit/8c357a01e61912c06a65de590a0049f051bda2ee))
* **cli:** deterministic winner-path identity check (F63) ([#97](https://github.com/1solomonwakhungu/action-hub/issues/97)) ([bcca48c](https://github.com/1solomonwakhungu/action-hub/commit/bcca48cc72c8182c315737f767a6dc456cb99cf0))
* **cli:** harness export leaks existing config secrets; win32 paths; --json on TOML ([#42](https://github.com/1solomonwakhungu/action-hub/issues/42)) ([f9d85f9](https://github.com/1solomonwakhungu/action-hub/commit/f9d85f9afdf85ea64900d24ac034992e4733c4f6))
* **cli:** harness snippets use bare node; add pi target ([#44](https://github.com/1solomonwakhungu/action-hub/issues/44)) ([fa209c5](https://github.com/1solomonwakhungu/action-hub/commit/fa209c5cfbe538de1ac1acf36700d88360d13bca))
* **cli:** pipe truncation over 64 KiB; list registers skills; list --server indexes one server (FX4) ([#53](https://github.com/1solomonwakhungu/action-hub/issues/53)) ([bb8d590](https://github.com/1solomonwakhungu/action-hub/commit/bb8d590d6d1af99141584b6e6e48c5d5fbe0c9ba))
* **cli:** preserve raw config on import --write; atomic 0600 writes ([#39](https://github.com/1solomonwakhungu/action-hub/issues/39)) ([ab9ae41](https://github.com/1solomonwakhungu/action-hub/commit/ab9ae41b20508a40f8cdabc5d2b0a813e980ecb9))
* **cli:** progress-aware daemon start readiness (FX10/F25) ([#70](https://github.com/1solomonwakhungu/action-hub/issues/70)) ([b1add6f](https://github.com/1solomonwakhungu/action-hub/commit/b1add6f5f8f2de8c1c00af388875b4edac8f1fc9))
* **cli:** redact credentials in import output and isolate import test ([#35](https://github.com/1solomonwakhungu/action-hub/issues/35)) ([097e07b](https://github.com/1solomonwakhungu/action-hub/commit/097e07bc9b100b97e928a51a907596fd0d6ecc8f))
* **cli:** winner-path exit-event grace closes the F63 false-green race ([#96](https://github.com/1solomonwakhungu/action-hub/issues/96)) ([72121aa](https://github.com/1solomonwakhungu/action-hub/commit/72121aa173063ed35c42617fb60d687f1da587ae))
* **core:** activation deadline for MCP servers (F27) ([#65](https://github.com/1solomonwakhungu/action-hub/issues/65)) ([4af1880](https://github.com/1solomonwakhungu/action-hub/commit/4af18807264835b73290694b8601c65941b3d926))
* **core:** execute-time connection errors trip the circuit breaker (F16) ([#59](https://github.com/1solomonwakhungu/action-hub/issues/59)) ([aca7050](https://github.com/1solomonwakhungu/action-hub/commit/aca7050b2fb4cba2680a7aae91a080e0542f9f7b))
* **core:** isolate servers with repeated execute timeouts (F26) ([#73](https://github.com/1solomonwakhungu/action-hub/issues/73)) ([01a9f24](https://github.com/1solomonwakhungu/action-hub/commit/01a9f247849de5c46cbefd02b523038392dda291))
* **types:** add typed ToolAnnotations to McpClient.listTools and drop casts ([#32](https://github.com/1solomonwakhungu/action-hub/issues/32)) ([df8484c](https://github.com/1solomonwakhungu/action-hub/commit/df8484cd56523f1eddd6f5635ee3e6546809cc3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @action-hub/mcp-server bumped from * to 0.1.0
    * @action-hub/core bumped from * to 0.1.0
