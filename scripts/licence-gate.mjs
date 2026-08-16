#!/usr/bin/env node
/**
 * licence-gate: fail the build if the licence is not intact, not real, or not
 * the licence the package claims to be under.
 *
 * A licence file is unusual among repository files in that nothing else
 * breaks when it goes wrong. Tests pass, types check, the code runs. The
 * damage from a truncated licence body, a placeholder copyright holder, or a
 * package manifest that advertises a different licence from the one in the
 * file is legal rather than technical, and it surfaces at the worst possible
 * moment: after adoption, when correcting it stops being a one-line edit and
 * becomes a conversation with everyone who relied on it. So the checks live
 * here, where they run on every commit.
 *
 * This gate was ported from a sibling project whose licence is Apache-2.0 and
 * whose copyright holder was a deliberate placeholder awaiting a company
 * registration. Neither is true here: this repository is MIT and already
 * names a real holder, so the gate is written to hold that state rather than
 * to block until it arrives. What it protects against is the state DRIFTING:
 * the licence body being partly overwritten by a copy from elsewhere, the
 * copyright line being blanked to something generic during a scrub pass, or
 * the manifest and the file disagreeing after one of the two is edited alone.
 *
 * USAGE
 *   node scripts/licence-gate.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LICENSE_PATH = path.join(REPO_ROOT, "LICENSE");
const MANIFEST_PATH = path.join(REPO_ROOT, "package.json");

/** The SPDX identifier this repository is published under. */
const EXPECTED_SPDX = "MIT";

/**
 * Phrases that mean the copyright holder has not actually been filled in.
 * Compared case-insensitively against the holder alone, not the whole file.
 */
const PLACEHOLDER_HOLDERS = [
  "todo",
  "tbd",
  "placeholder",
  "your name",
  "yourname",
  "copyright holder",
  "author name",
  "company",
  "example",
  "foo",
  "bar",
  "n/a",
  "unknown",
  "redacted",
  "anonymous",
];

/** @param {string[]} lines */
function fail(lines) {
  console.error(["licence-gate: " + lines[0], ...lines.slice(1)].join("\n"));
  process.exit(1);
}

if (!fs.existsSync(LICENSE_PATH)) {
  fail(["LICENSE is missing from the repository root."]);
}

const text = fs.readFileSync(LICENSE_PATH, "utf8");

// -- The body is the licence it claims to be, in full -----------------------
// Header alone is not enough. A file can carry the title and lose the grant
// or the disclaimer to a bad merge or a truncating copy, and the result reads
// like a licence to anyone skimming while granting or disclaiming nothing.
if (!/^MIT License\s*$/m.test(text)) {
  fail([
    "LICENSE does not carry the MIT License title line.",
    `The package is published as ${EXPECTED_SPDX}; the file must be the MIT text.`,
  ]);
}

/**
 * The clause checks run against a whitespace-normalised copy, not the raw
 * file. The MIT text is distributed at whatever wrap width the tool that
 * emitted it chose, so any given clause may or may not have a line break
 * inside it. Matching the raw text made the gate fail on a perfectly valid
 * LICENSE because "IN NO EVENT SHALL THE / AUTHORS OR COPYRIGHT HOLDERS"
 * happened to wrap between those two words, and it would equally have PASSED
 * a file whose clause was intact only by wrapping luck. Normalising first
 * makes the check about the words, which is what the check is for.
 */
const flowed = text.replace(/\s+/g, " ");

const REQUIRED_CLAUSES = [
  {
    what: "the permission grant",
    re: /Permission is hereby granted, free of charge, to any person obtaining a copy/,
  },
  {
    what: "the notice-retention condition",
    re: /above copyright notice and this permission notice shall be included/,
  },
  {
    what: "the warranty disclaimer",
    re: /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/,
  },
  {
    what: "the liability limitation",
    re: /IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/,
  },
];

const missingClauses = REQUIRED_CLAUSES.filter(({ re }) => !re.test(flowed));
if (missingClauses.length > 0) {
  fail([
    "LICENSE is missing part of the MIT text.",
    "",
    ...missingClauses.map(({ what }) => `  missing: ${what}`),
    "",
    "A licence file that has lost a clause still reads as a licence but no",
    "longer grants or disclaims what it appears to. Restore the full text.",
  ]);
}

// -- There is a real copyright holder ---------------------------------------
const copyright = text.match(/^Copyright \(c\) (\d{4}(?:\s*-\s*\d{4})?)\s+(.+?)\s*$/m);
if (!copyright) {
  fail([
    "LICENSE has no recognisable copyright line.",
    "",
    "Expected a line of the form: Copyright (c) <year> <holder>",
    "The MIT grant is anchored to that notice; without it the notice-retention",
    "condition has nothing to retain.",
  ]);
}

const [, year, holder] = copyright;
const holderLower = holder.toLowerCase();

if (PLACEHOLDER_HOLDERS.some((p) => holderLower === p || holderLower.includes(p))) {
  fail([
    `the LICENSE copyright holder is still a placeholder (${JSON.stringify(holder)}).`,
    "",
    "Replace it with the exact legal name of the person or company that holds",
    "copyright. This is deliberately a build failure rather than a TODO: it",
    "becomes very expensive to correct after the first external contribution,",
    "because by then it is everyone's copyright line and not just yours.",
  ]);
}

if (holder.length < 3) {
  fail([`the LICENSE copyright holder (${JSON.stringify(holder)}) is too short to be a real name.`]);
}

// -- The manifest agrees with the file --------------------------------------
// The realistic failure here is not malice, it is a one-sided edit. Someone
// changes the licence in the manifest during a dependency pass, or replaces
// LICENSE wholesale from a template, and the two drift. Consumers read the
// manifest; courts read the file. They must say the same thing.
if (!fs.existsSync(MANIFEST_PATH)) {
  fail(["package.json is missing from the repository root."]);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
if (manifest.license !== EXPECTED_SPDX) {
  fail([
    `package.json declares license ${JSON.stringify(manifest.license)} but LICENSE is the ${EXPECTED_SPDX} text.`,
    "",
    "Consumers and package registries read the manifest field; the legal",
    "instrument is the file. Make them agree, and change the file rather than",
    "the field if the intent was to relicense.",
  ]);
}

console.log(
  `licence-gate: LICENSE is the complete ${EXPECTED_SPDX} text, copyright ${year} to a real holder, and package.json agrees.`,
);
