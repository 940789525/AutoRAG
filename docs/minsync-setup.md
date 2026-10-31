# MinSync migration

The embedding runtime has moved to FastEmbed (local Qwen3-Embedding-0.6B) or an explicitly authorized API. See [the current setup and migration procedure](embedding-setup.md).

The new runtime does not install, start, probe or dynamically load MinSync. Existing shared MinSync processes and `~/.cache/minsync/models` remain untouched. `minSync.embedder`, `minsync` method selections and `syncMinSync` are deprecated compatibility inputs; they route to AutoRAG's own index and the configured HTTP embedder. MinSync installer/client execution exports were removed.

Old MinSync state may exist at `<workspace>/.autorag/minsync/.minsync`, including `config.toml` and `embedding-identity.json`. This release retains that directory for an operator-directed rollback with the old application. New indexes live under `<workspace>/.autorag/local-index`; the ONNX cache is separate. Do not delete or overwrite either as part of setup.
