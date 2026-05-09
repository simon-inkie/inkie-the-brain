---
title: "Flat-file markdown is enough for sub-million-doc vector search"
date: 2026-05-09
tags: [vector-search, qdrant, learnings, scale]
type: learning
---

# Flat-file vector search holds up

For corpora under ~1M documents, you don't need a heavyweight document store on top of the vector index. The pattern is:

- Markdown on disk (Obsidian-shaped vault is fine)
- Vector index (Qdrant, embedded by Gemini Embedding 2)
- Cross-link auto-population (`Related` blocks)
- Filesystem watcher for incremental re-index on file change

Read latency is dominated by Qdrant's HNSW lookup (~10ms) plus the markdown read for each top-K hit (~1ms cached). Write latency is the embedding API call (~200-500ms) plus the upsert (~5ms). Neither is a bottleneck under typical loads.

## Where this falls over

Above ~1M docs, the on-disk file count starts hurting filesystem operations (find, rsync, fsck on inode tables). A real document store with chunked binary storage starts paying for itself. Below that mark, the simplicity of "markdown on disk + vector index" wins on portability, debuggability, and grep-ability.
