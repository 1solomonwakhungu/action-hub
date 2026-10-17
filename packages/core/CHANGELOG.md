# Changelog

## 0.1.0 (2026-10-17)


### Features

* add auto-discovery, speculative schema search, and execution timeouts ([#12](https://github.com/1solomonwakhungu/action-hub/issues/12)) ([28bea09](https://github.com/1solomonwakhungu/action-hub/commit/28bea090d64e7365fc785fa72f985ad269b152ce))
* **auth:** OAuth 2.0 and refresh-token rotation for remote MCP servers ([#23](https://github.com/1solomonwakhungu/action-hub/issues/23)) ([492e514](https://github.com/1solomonwakhungu/action-hub/commit/492e5149a0e345c4e67aa5714920d8009fd9b67e))
* **bundles:** action-hub bundle --export prints a bundle as JSON ([#43](https://github.com/1solomonwakhungu/action-hub/issues/43)) ([712a57c](https://github.com/1solomonwakhungu/action-hub/commit/712a57cac67e84951875bcec29165e3ff66a9dea))
* **canvas:** interactive capability manager controls ([#5](https://github.com/1solomonwakhungu/action-hub/issues/5)) ([fbc78d5](https://github.com/1solomonwakhungu/action-hub/commit/fbc78d5a6529be10cd26224d30f90ff5f9e2181e))
* **cli:** expand doctor diagnostics with redacted transport details ([#37](https://github.com/1solomonwakhungu/action-hub/issues/37)) ([11a180b](https://github.com/1solomonwakhungu/action-hub/commit/11a180bc8ca66cee58eece0df9629adc1a96fd21))
* **core:** Action Bundles for compound workflow discovery and batch loading ([a80b42c](https://github.com/1solomonwakhungu/action-hub/commit/a80b42c6565fff6d902386cea9cca68fe59ddf85))
* **core:** Action Bundles for compound workflow discovery and batch loading ([#8](https://github.com/1solomonwakhungu/action-hub/issues/8)) ([23020c2](https://github.com/1solomonwakhungu/action-hub/commit/23020c2da37cfc31b02c16ab093279d3614328e3))
* **core:** add dependency-free local semantic scorer ([#4](https://github.com/1solomonwakhungu/action-hub/issues/4)) ([00cb89b](https://github.com/1solomonwakhungu/action-hub/commit/00cb89b2ab02b7e1b042a2c5bb6af5f5dd22b75e))
* **core:** add OpenTelemetry observability and trace propagation ([#25](https://github.com/1solomonwakhungu/action-hub/issues/25)) ([97405f4](https://github.com/1solomonwakhungu/action-hub/commit/97405f49fa6c0e4d22524b6f91420ba008a833c1))
* **core:** circuit recovery, heartbeats, and Node memory limits ([#21](https://github.com/1solomonwakhungu/action-hub/issues/21)) ([8159b88](https://github.com/1solomonwakhungu/action-hub/commit/8159b883e75c8416edc4ac4b7d774087aba954a1))
* **core:** Connection health monitoring, auto-reconnect, and circuit breaker ([#10](https://github.com/1solomonwakhungu/action-hub/issues/10)) ([f2ab2c8](https://github.com/1solomonwakhungu/action-hub/commit/f2ab2c8e6ec8dd8fba0a064e12af5c53e0051b50))
* **core:** connection resilience, health checks, and circuit breaker ([#10](https://github.com/1solomonwakhungu/action-hub/issues/10)) ([4fb063d](https://github.com/1solomonwakhungu/action-hub/commit/4fb063da12b20c0d54feb9a1e8aa54ae91132a23))
* **core:** persist the indexed catalog across restarts ([#2](https://github.com/1solomonwakhungu/action-hub/issues/2)) ([d2d577a](https://github.com/1solomonwakhungu/action-hub/commit/d2d577a3930276202f7ed26f3bc9fb807948c831))
* **core:** result caching for idempotent reads and tool annotation propagation ([#28](https://github.com/1solomonwakhungu/action-hub/issues/28)) ([593e428](https://github.com/1solomonwakhungu/action-hub/commit/593e428c57169d3e4442144f43b13b1e4ad7f8e7))
* **discovery:** multi-harness MCP server auto-discovery ([#26](https://github.com/1solomonwakhungu/action-hub/issues/26)) ([c408c3b](https://github.com/1solomonwakhungu/action-hub/commit/c408c3b8128390a94bda51568cb8fb71fb50647f))
* **migration:** Universal capability migration for MCPs, skills, and plugins ([#19](https://github.com/1solomonwakhungu/action-hub/issues/19)) ([b1fc9a6](https://github.com/1solomonwakhungu/action-hub/commit/b1fc9a6b49e9ea4ae6201618c6dd02aaf8b2e065))
* **permissions:** gate untrusted actions behind single-use approval tokens ([#3](https://github.com/1solomonwakhungu/action-hub/issues/3)) ([2d105e0](https://github.com/1solomonwakhungu/action-hub/commit/2d105e092dc5eb92722eda8f17a88a33d7baa567))
* scaffold Action Hub ([94ec9be](https://github.com/1solomonwakhungu/action-hub/commit/94ec9be5a842c01217f2dd7e3fc70c64007c8a3e))
* **search:** compressed server directory (list_servers) and goal-only recall gate ([#104](https://github.com/1solomonwakhungu/action-hub/issues/104)) ([4363f26](https://github.com/1solomonwakhungu/action-hub/commit/4363f26c0bcb5c12ea502c599a3344149d85d453))
* **search:** curated verb-synonym query expansion (SQ2 / F49 part 1) ([#83](https://github.com/1solomonwakhungu/action-hub/issues/83)) ([0eb706a](https://github.com/1solomonwakhungu/action-hub/commit/0eb706a833f113ee21a33b1898e43cdedb92d14c))
* **search:** local MiniLM embeddings for semantic search (SQ4 / F49 part 3) ([#92](https://github.com/1solomonwakhungu/action-hub/issues/92)) ([9bc2f9a](https://github.com/1solomonwakhungu/action-hub/commit/9bc2f9abd5ca3fc241b52bd9ba6c14006ebd9455))
* **search:** query-side stopwords, unicode-aware tokenization, token cap, optional min-score ([#52](https://github.com/1solomonwakhungu/action-hub/issues/52)) ([ce22e69](https://github.com/1solomonwakhungu/action-hub/commit/ce22e6902bced3a70b6f2b6eba6bef0598d3f691))
* **server:** scan ~/.action-hub/skills for skills added after migration ([#34](https://github.com/1solomonwakhungu/action-hub/issues/34)) ([b36f02f](https://github.com/1solomonwakhungu/action-hub/commit/b36f02f024375ae502e22e657e38d4044ccdeb76))


### Bug Fixes

* **cli:** redact credentials in import output and isolate import test ([#35](https://github.com/1solomonwakhungu/action-hub/issues/35)) ([097e07b](https://github.com/1solomonwakhungu/action-hub/commit/097e07bc9b100b97e928a51a907596fd0d6ecc8f))
* **core:** activation deadline for MCP servers (F27) ([#65](https://github.com/1solomonwakhungu/action-hub/issues/65)) ([4af1880](https://github.com/1solomonwakhungu/action-hub/commit/4af18807264835b73290694b8601c65941b3d926))
* **core:** collision-safe skill ids and first-wins duplicate tool names ([#50](https://github.com/1solomonwakhungu/action-hub/issues/50)) ([fadae38](https://github.com/1solomonwakhungu/action-hub/commit/fadae384cad87d98aa4f20f4059ecdc38563eb08))
* **core:** execute-time connection errors trip the circuit breaker (F16) ([#59](https://github.com/1solomonwakhungu/action-hub/issues/59)) ([aca7050](https://github.com/1solomonwakhungu/action-hub/commit/aca7050b2fb4cba2680a7aae91a080e0542f9f7b))
* **core:** isolate servers with repeated execute timeouts (F26) ([#73](https://github.com/1solomonwakhungu/action-hub/issues/73)) ([01a9f24](https://github.com/1solomonwakhungu/action-hub/commit/01a9f247849de5c46cbefd02b523038392dda291))
* **daemon:** cooperative index embedding and reindex settle state ([#63](https://github.com/1solomonwakhungu/action-hub/issues/63)) ([7f0daa5](https://github.com/1solomonwakhungu/action-hub/commit/7f0daa541eca6d3ec07b96a090b8b8a0d6307fe4))
* **eval:** parameterize recall calculation by retrieval depth K ([0834303](https://github.com/1solomonwakhungu/action-hub/commit/0834303ec77ff526af629974c48bcabd03648dcf))
* **eval:** parameterize recall calculation by retrieval depth K ([#6](https://github.com/1solomonwakhungu/action-hub/issues/6), [#7](https://github.com/1solomonwakhungu/action-hub/issues/7)) ([d1b6f47](https://github.com/1solomonwakhungu/action-hub/commit/d1b6f47946c2669e972ffb2cd84e7c85cc047cc4))
* **output:** cap action_hub response sizes and redact known secret prefixes ([#51](https://github.com/1solomonwakhungu/action-hub/issues/51)) ([f0ae071](https://github.com/1solomonwakhungu/action-hub/commit/f0ae07194d0a4e038739244fa76b86a8fcd46ca2))
* **server:** deferred startup refresh (stdio/HTTP/daemon), cached flag, debounced snapshot (F23/F24/F18 + FX12-R5) ([#68](https://github.com/1solomonwakhungu/action-hub/issues/68)) ([f53adbc](https://github.com/1solomonwakhungu/action-hub/commit/f53adbc142b93c9acc7319f4d8e25097e933b16e))
* **types:** add typed ToolAnnotations to McpClient.listTools and drop casts ([#32](https://github.com/1solomonwakhungu/action-hub/issues/32)) ([df8484c](https://github.com/1solomonwakhungu/action-hub/commit/df8484cd56523f1eddd6f5635ee3e6546809cc3b))


### Performance Improvements

* **search:** memoize corpus stats per catalog version (F18) ([#67](https://github.com/1solomonwakhungu/action-hub/issues/67)) ([4e4bd8e](https://github.com/1solomonwakhungu/action-hub/commit/4e4bd8e8a889b4af0f25cb3f3f2da611a417ba9d))


### Documentation

* F48/F51 framing + minScoreRatio corrections, pinned pi source ([#86](https://github.com/1solomonwakhungu/action-hub/issues/86)) ([945a393](https://github.com/1solomonwakhungu/action-hub/commit/945a393994a4d1a1149f013e02175842d7e28ae5))
