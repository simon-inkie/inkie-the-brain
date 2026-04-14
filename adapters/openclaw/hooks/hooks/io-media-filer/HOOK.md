---
name: io-media-filer
description: "Auto-saves incoming media (images, PDFs, audio) to brain/assets/ with .md sidecars"
metadata:
  openclaw:
    emoji: "📎"
    events: ["message:preprocessed"]
    requires:
      config: ["workspace.dir"]
---

# io-media-filer

Auto-saves incoming media attachments to `brain/assets/` with metadata sidecars.

On every `message:preprocessed` where `mediaPath` is present:

1. Checks `mediaPath` and `mediaType` — skips unsupported types
2. Generates filename: `YYYY-MM-DD-<slugified-description>.<ext>`
3. Copies file to `$BRAIN_DIR/assets/<filename>`
4. Writes `.md` sidecar with origin metadata

No LLM calls — pure file I/O. The existing `io-watcher` service handles
multimodal indexing of new files in `brain/assets/`.

Supported types: JPEG, PNG, GIF, WebP, PDF, OGG, MPEG, WAV, MP4 audio.
