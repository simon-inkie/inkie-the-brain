---
title: "Use Gemini 2.5 Flash for the permission-classifier hot path"
date: 2026-05-09
tags: [decisions, classifier, latency, cost]
type: decision
---

# Gemini 2.5 Flash for stage 1 + 2

Decided: stage 1 (fast LLM, plain-text ALLOW/BLOCK) and stage 2 (thinking LLM, JSON output with reasoning) both default to `google/gemini-2.5-flash`. Either stage can be swapped to a different provider via config — Anthropic, OpenAI, Ollama for self-hosted — but the shipped default is all-Gemini.

## Why

- p50 ~800ms stage 1, ~4.5s stage 2 over real workload (3,000 classifications)
- Cost: pennies per agentic-dev day; the classifier scales with how often it escalates, not with how often the agent runs commands
- Static-pattern layer covers ~30% of calls at 0ms before any LLM fires
- Self-hosted users run Ollama with no provider lock-in

## What we considered

Anthropic Sonnet (more reasoning headroom but ~5x cost), OpenAI gpt-4o-mini (similar cost, slower at p90). The decision wasn't obviously right at the time but proved out under load.
