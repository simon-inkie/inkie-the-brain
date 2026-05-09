---
title: "Test new platform patterns from the side that's not yours"
date: 2026-05-09
tags: [learnings, testing, distributed-systems, asymmetric-systems]
type: learning
---

# Test from the other side

When implementing a new platform pattern that has asymmetric roles (initiator vs recipient, leader vs follower, real-file vs symlink-mirror), your local-only test runs from one side. That side may be the side where the pattern works regardless of bugs in the other side.

## Concrete

The inbox-watcher v2 used `stat -c%s` on each file in the inbox to detect growth. On the platform's "thread file lives in initiator's inbox" model, that meant whoever held the canonical-file side got correct readings, while whoever held the symlink-mirror side got `49` forever (the symlink's own size, which never changes).

Author tested from their own inbox where threads they initiated were canonical files. Worked perfectly. Half the team's watchers were silently dead.

## The discipline

Before shipping a pattern that has asymmetric roles, ask: *if I'm on the side that's NOT the canonical / NOT the leader / NOT the writer, does this pattern work?* If you can't answer concretely, run the pattern from that side once before merging.

Generalises beyond watchers — same shape applies to consensus protocols (does the follower's view ever stabilise?), event sourcing (do downstream consumers see the same ordering?), schema migrations (does the read-replica's view drift?).
