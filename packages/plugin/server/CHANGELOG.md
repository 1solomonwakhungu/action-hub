# Changelog

## 0.1.0 (2026-10-17)


### Features

* **search:** compressed server directory (list_servers) and goal-only recall gate ([#104](https://github.com/1solomonwakhungu/action-hub/issues/104)) ([4363f26](https://github.com/1solomonwakhungu/action-hub/commit/4363f26c0bcb5c12ea502c599a3344149d85d453))
* **search:** local MiniLM embeddings for semantic search (SQ4 / F49 part 3) ([#92](https://github.com/1solomonwakhungu/action-hub/issues/92)) ([9bc2f9a](https://github.com/1solomonwakhungu/action-hub/commit/9bc2f9abd5ca3fc241b52bd9ba6c14006ebd9455))
* **server:** flagged 'no confident match' abstention for search (SQ3) ([#82](https://github.com/1solomonwakhungu/action-hub/issues/82)) ([f0a482c](https://github.com/1solomonwakhungu/action-hub/commit/f0a482cac030936a4dfae91ce1eb88b65e702882))


### Bug Fixes

* **cli:** deterministic winner-path identity check (F63) ([#97](https://github.com/1solomonwakhungu/action-hub/issues/97)) ([bcca48c](https://github.com/1solomonwakhungu/action-hub/commit/bcca48cc72c8182c315737f767a6dc456cb99cf0))
* **core:** activation deadline for MCP servers (F27) ([#65](https://github.com/1solomonwakhungu/action-hub/issues/65)) ([4af1880](https://github.com/1solomonwakhungu/action-hub/commit/4af18807264835b73290694b8601c65941b3d926))
* **core:** isolate servers with repeated execute timeouts (F26) ([#73](https://github.com/1solomonwakhungu/action-hub/issues/73)) ([01a9f24](https://github.com/1solomonwakhungu/action-hub/commit/01a9f247849de5c46cbefd02b523038392dda291))
* **daemon:** cooperative index embedding and reindex settle state ([#63](https://github.com/1solomonwakhungu/action-hub/issues/63)) ([7f0daa5](https://github.com/1solomonwakhungu/action-hub/commit/7f0daa541eca6d3ec07b96a090b8b8a0d6307fe4))
* **server:** -32602 for empty search query and unknown tools/list cursor (FX19) ([#81](https://github.com/1solomonwakhungu/action-hub/issues/81)) ([704a140](https://github.com/1solomonwakhungu/action-hub/commit/704a1408f2cc8de0f92ce6d837659e6ef2e55a49))
* **server:** answer stateless HTTP POSTs with plain JSON, not a per-request SSE stream (F47) ([#88](https://github.com/1solomonwakhungu/action-hub/issues/88)) ([225fb6f](https://github.com/1solomonwakhungu/action-hub/commit/225fb6fb0c13ff4a080555ea73fa836680ef2d6d))
* **server:** deferred startup refresh (stdio/HTTP/daemon), cached flag, debounced snapshot (F23/F24/F18 + FX12-R5) ([#68](https://github.com/1solomonwakhungu/action-hub/issues/68)) ([f53adbc](https://github.com/1solomonwakhungu/action-hub/commit/f53adbc142b93c9acc7319f4d8e25097e933b16e))
* **server:** reply to malformed stdio JSON-RPC frames (F53) ([#89](https://github.com/1solomonwakhungu/action-hub/issues/89)) ([ce5a9f5](https://github.com/1solomonwakhungu/action-hub/commit/ce5a9f562421e98d49b3cd7176eac2c71e8cfa14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @action-hub/core bumped from * to 0.1.0
