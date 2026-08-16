#!/usr/bin/env node
/**
 * leak-gate: denylist scan for internal material that must never appear in
 * this repository.
 *
 * This repository is the OPEN version of a system that also runs privately.
 * A clean-room process governs what crosses from the private side, and this
 * gate is the mechanical backstop for the categories that process exists to
 * keep out: real personal and agent names, private hostnames and repository
 * names, IP addresses, absolute paths under a real home directory, private
 * issue-tracker identifiers, and company email addresses. Credential scanning
 * proper is a secret scanner's job; this file owns the identity denylist that
 * a generic secret scanner cannot know about.
 *
 * HOW THE PATTERNS ARE WRITTEN, and why it looks odd.
 *
 * Every rule's regex source and its self-test sample are assembled at
 * runtime from split fragments. Written whole, each denied string would
 * itself ship in the repository, be greppable and indexable, and trip the
 * gate on this very file. Split, the repository never contains a literal
 * instance of anything on the list, and this file is scanned like any other.
 *
 * HOW TO EXTEND THE LIST.
 *
 * Add a rule() entry below. Split the fragments mid-word, keep the sample
 * matching the pattern, and say in `why` what the entry prevents, because
 * the next reader cannot infer that from a split string. Give it a
 * `mustNotMatch` list whenever the rule has a deliberate carve-out, so the
 * carve-out is proved rather than assumed. Then run
 * `node scripts/leak-gate.mjs --self-test` to prove the new rule fires.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE SIBLING GATE THIS WAS PORTED FROM.
 *
 * 1. There is no `literal-em-dash` rule here. In the sibling project a
 *    U+2014 is a header field separator in a message protocol, so a literal
 *    one anywhere is a parsing hazard. No such parser exists in this
 *    project, and this repository carries a large body of copied source
 *    comments that legitimately use the character. Porting the rule would
 *    have forced a mass rewrite of prose for a hazard that does not exist
 *    here. House style still avoids em dashes in documentation, enforced by
 *    review rather than by this gate.
 *
 * 2. The private-repository-name rule does NOT list this project's own name.
 *    It is the public name of the published product and appears throughout
 *    the documentation by design.
 *
 * EXEMPTIONS.
 *
 * A small number of (file, rule) pairs are exempt, listed in EXEMPTIONS
 * below with a reason each. An exemption is deliberately narrow: it names one
 * exact repo-relative path and one exact rule label, so it cannot silently
 * widen the way a loosened regex can. Every run prints how many are active,
 * and the self-test fails if an exemption has gone stale, so a carve-out that
 * has outlived its reason cannot sit here unnoticed.
 *
 * USAGE
 *   node scripts/leak-gate.mjs                  scan every file in the working
 *                                               tree that is not gitignored
 *   node scripts/leak-gate.mjs <file>...        scan the given files only
 *   node scripts/leak-gate.mjs --self-test      prove every rule catches its
 *                                               own sample, and every
 *                                               carve-out holds, using temp
 *                                               files outside the repository
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * @param {{
 *   label: string,
 *   why: string,
 *   pattern: string[],
 *   flags?: string,
 *   sample: string[],
 *   where?: "both" | "filename",
 *   mustNotMatch?: string[],
 * }} spec
 */
function rule({ label, why, pattern, flags = "i", sample, where = "both", mustNotMatch = [] }) {
  return {
    label,
    why,
    re: new RegExp(pattern.join(""), flags),
    sample: sample.join(""),
    where,
    mustNotMatch,
  };
}

const RULES = [
  // -- People ---------------------------------------------------------------
  // Names in this section are matched as BARE SUBSTRINGS, with no \b on
  // either side, on purpose. A word-boundary anchor is silently disarmed by
  // adjacent word characters: the observed case was a name preceded by a
  // backslash-n ESCAPE in test source, where the "n" of the escape is a word
  // character and kills the boundary, so a \b-anchored rule read the line and
  // passed it. These names are distinctive enough that a substring match has
  // no realistic false positives, so they get the stronger form.
  rule({
    label: "principal-first-name",
    why: "First name of the person the private deployment serves. A real person's name in the open repo is a clean-room breach. Substring match with ONE carve-out: the public GitHub owner slug (the first name followed by a hyphen and the company name) is the repository's own published address and must keep working in clone URLs. Every other shape still fires, including the bare name, an absolute home path built from it, and the fused surname form.",
    pattern: ["si", "mon(?!-inkie)"],
    sample: ["si", "mon"],
    // Written whole because it is the ALLOWED form, and it already appears in
    // README.md and QUICKSTART.md as the real public clone URL.
    mustNotMatch: ["github.com/simon-inkie/inkie-the-brain"],
  }),
  rule({
    label: "second-principal-first-name",
    why: "First name of the second person the private deployment serves. Substring match: distinctive, no \\b (see section comment).",
    pattern: ["sop", "hie"],
    sample: ["sop", "hie"],
  }),

  // -- Agent names ----------------------------------------------------------
  // The private fleet's agents have individual names. Any of them appearing
  // here means private persona or conversation material crossed over. The
  // list is split by match strength:
  //   - DISTINCTIVE names match as bare substrings (no \b), so a name fused
  //     into an identifier or preceded by an escape sequence still fires.
  //     Observed leak shapes: names fused into camelCase variable names, and
  //     into repo/worktree names, both invisible to \b-bounded rules.
  //   - Names that are ordinary English words or too short to be distinctive
  //     keep \b on both sides, or a substring rule would drown the gate in
  //     false positives. The trade-off is real: \b can be defeated by
  //     adjacent word characters, so those entries are the gate's weakest
  //     ones and reviewers should keep that in mind.
  rule({
    label: "fleet-agent-name-distinctive",
    why: "Name of an agent on the private fleet, distinctive enough for substring matching (fires even fused inside identifiers). Public examples must use invented names (alice, bob, courier, ...). The double-consonant form of the first name here is the PERSON; the single-consonant runtime name it resembles is a public product name and is deliberately not matched.",
    pattern: [
      "(?:ag", "gy|al", "dus|hop", "kins|mon",
      "tani|mag", "gie|fo", "lio|doc", "tor[-_ ]?(?:2|two))",
    ],
    sample: ["ag", "gy"],
    // The single-g runtime name ships in this repository on purpose (adapter
    // directory, fixtures, docs). Proving it does not fire is the whole point
    // of writing the pattern with a doubled consonant.
    mustNotMatch: ["a", "gy-workspace"],
  }),
  rule({
    label: "fleet-agent-name-wordlike",
    why: "Name of an agent on the private fleet that is also an English word or too short for substring matching, so it keeps \\b bounds and is weaker than the distinctive rule; a fused occurrence will NOT fire. One roster name is deliberately absent from this list: an ordinary English noun meaning a manual or handbook, which this project's own documentation uses constantly. A \\b rule on it would fire on every honest sentence and would be tuned off within a week, so it is left to human review instead.",
    pattern: [
      "\\b(?:se", "th|p", "ea|an", "dor|ir", "is)\\b",
    ],
    sample: ["se", "th"],
  }),
  rule({
    label: "private-agent-persona-name-io",
    why: "Two-letter name of the agent this memory layer was first built for. Case-SENSITIVE with \\b on both sides, deliberately narrow: the lowercase form is a legitimate hook-directory prefix that ships here, and the all-caps form is the ordinary abbreviation for input/output. Only the capitalised standalone word, which is always the persona, fires.",
    pattern: ["\\bI", "o\\b"],
    flags: "",
    sample: ["I", "o"],
    mustNotMatch: ["io-observer", "io-message-indexer", "disk IO throughput", "IOPS"],
  }),
  rule({
    label: "private-agent-roster-entry",
    why: "Structural signature of the private fleet's agent-mapping table: an object literal pairing a directory-slug `pattern` field with an `agent` field. That table maps real session directories to real agent names and is the densest single source of private roster material in the codebase. Matching the SHAPE rather than the names means the rule keeps working when the roster changes, and fires even if every name in a copied table has been renamed but the table itself was left behind.",
    pattern: ["pat", "tern:\\s*\"[^\"]*\"\\s*,\\s*a", "gent:\\s*\""],
    sample: ["pat", "tern: \"-x-y\", a", "gent: \"z\""],
  }),

  // -- Private repositories, hosts and tooling ------------------------------
  rule({
    label: "private-repo-or-host-name",
    why: "Name of a private repository, project or host. Their names alone reveal private topology and invite links back into closed material. This project's own name is deliberately NOT on the list: it is the published product name (see the header note).",
    pattern: [
      "\\b(?:mission-", "control|io-", "projects|inkie-", "pgr|inkie-",
      "app-v2|inkie-", "worker|inkie-", "functions|inkie-", "gtm|inkie-",
      "io)\\b",
    ],
    sample: ["mission-", "control"],
    mustNotMatch: ["the-brain", "inkie-the-brain", "~/.the-brain/"],
  }),
  rule({
    label: "private-product-name",
    why: "The private deployment's control-plane product name (two words, also seen fused or underscore/hyphen-joined). It appearing anywhere means private UI copy, docs or push text crossed over uncleaned. Substring, case-insensitive, so fused identifiers fire too.",
    pattern: ["mis", "sion[-_ ]?con", "trol"],
    sample: ["Mis", "sion Con", "trol"],
  }),
  rule({
    label: "private-tracker-org-slug",
    why: "The company's real issue-tracker organisation slug (as in linear.app/<slug>). It links straight back to the private workspace; public examples use the example-org placeholder. Substring, case-insensitive.",
    pattern: ["ink", "ie-ai"],
    sample: ["ink", "ie-ai"],
  }),
  rule({
    label: "private-scm-host",
    why: "The private mirror of this project lives on a different SCM host from the public one. Any URL on that host in this repository is a clone instruction pointing at a repository the reader cannot reach, and it usually carries the owner's real account slug with it. The public remote is on GitHub; nothing here should reference the other host.",
    pattern: ["git", "lab\\.com"],
    sample: ["git", "lab.com"],
  }),
  rule({
    label: "private-review-tooling",
    why: "Name of the automated code-review service wired into the private repository. Its configuration file and its review vocabulary in comments both describe an internal review process, not this project's public one.",
    pattern: ["code", "rabbit"],
    sample: ["code", "rabbit"],
  }),

  // -- Never-ship file classes ----------------------------------------------
  // These match the PATH ONLY. Their strings appear legitimately in prose
  // here (this project documents an agent harness that uses several of these
  // filenames), so a content rule would fire on every honest mention. What
  // must never ship is a FILE of that class, and the path is where that is
  // visible.
  rule({
    label: "agent-persona-file",
    why: "Filename class of the private agent-home material: persona and identity files, session handover notes, and the private working-notes directory. These are one agent's private character, memory and in-flight work; none of it is part of the product. Path-scoped only, because the product documentation legitimately discusses several of these filenames by name.",
    pattern: [
      "(?:^|/)(?:CLA", "UDE|IDEN", "TITY|SO", "UL|TO", "OLS|US", "ER|CO",
      "RE|GEM", "INI)\\.md$|(?:^|/)HAND", "OVER[-.]|(?:^|/)\\.no", "tes/",
    ],
    flags: "",
    where: "filename",
    sample: ["CLA", "UDE.md"],
    mustNotMatch: [
      "adapters/claude-code/README.md",
      "docs/ARCHITECTURE.md",
      "core/config.ts",
      "templates/skills/the-brain-setup.md",
    ],
  }),
  rule({
    label: "private-harness-config-file",
    why: "Filename class of the private agent harness's own configuration: the file-write permission gate, the code-review service config, and the read-only database credential descriptor. Each describes how the private fleet is operated and grants nothing to a public reader. Path-scoped only.",
    pattern: [
      "(?:^|/)\\.io-", "auto-mode\\.json$|(?:^|/)\\.code", "rabbit\\.ya?ml$|(?:^|/)\\.p", "gr-agent\\.json$",
    ],
    flags: "",
    where: "filename",
    sample: [".io-", "auto-mode.json"],
    mustNotMatch: [".github/workflows/install-test.yml", "vitest.config.ts"],
  }),

  // -- Network --------------------------------------------------------------
  rule({
    label: "tailnet-host-fragment",
    why: "Fragment of the private Tailscale hostname or its tailnet domain (the machine name, the tailnet id, or the tailnet MagicDNS domain suffix). Each fragment alone identifies private network topology, so all three fire independently and as substrings.",
    pattern: ["(?:a8", "max|tail", "495df7|\\.ts\\.", "net)"],
    sample: ["a8", "max"],
  }),
  rule({
    label: "cgnat-ipv4-address",
    why: "A concrete CGNAT-range address (the 100.64/10 block, the range Tailscale assigns) is private network topology exactly like an RFC 1918 address, but the private-ipv4-address rule below cannot see it because CGNAT is not RFC 1918.",
    pattern: [
      "\\b100\\.(?:6[4-9]|",
      "[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}\\b",
    ],
    flags: "",
    sample: ["100.64", ".0.1"],
  }),
  rule({
    label: "private-ipv4-address",
    why: "A concrete RFC 1918 address is private network topology. Docs that need an address use 203.0.113.x (TEST-NET-3) or a hostname placeholder.",
    pattern: [
      "\\b(?:192\\.168|10\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01]))",
      "\\.\\d{1,3}\\.\\d{1,3}\\b",
    ],
    flags: "",
    sample: ["192.168", ".0.1"],
  }),

  // -- Filesystem -----------------------------------------------------------
  rule({
    label: "absolute-home-path",
    why: "An absolute path under a real home directory ties content to a real machine and usually embeds a real username. Docs use ~, an angle-bracket placeholder, or one of the placeholder users you/user/example/test/test-user.",
    // Two changes from the gate this was ported from, both deliberate.
    //
    // The placeholder list gained test and test-user. Those are the names this
    // project's existing suite already uses for synthetic home directories in
    // assertions about path parsing. They embed no real username and tie to no
    // real machine, so the reason the rule exists does not reach them; the only
    // thing excluding them would have bought is a rewrite of two dozen fixture
    // paths in tests that are otherwise copied verbatim from the private side,
    // which is exactly the kind of churn that makes a copy diverge silently.
    //
    // The username segment no longer has to be followed by a slash. Requiring
    // one meant a path ending at the home directory itself did not fire, which
    // is the shape a real one takes in prose ("hardcoded /home/<name>") rather
    // than in code. The one live instance in this repository happened to be
    // caught by a name rule instead, so the hole was invisible; it would not
    // have been for any other username. The segment now just has to END, which
    // the placeholder lookahead matches on too, so test and /home/test-user/
    // are both still exempt.
    pattern: [
      "/(?:home|Users)/",
      "(?!(?:you|user|example|test|test-user)(?![A-Za-z0-9_.-]))",
      "[A-Za-z][A-Za-z0-9_.-]*",
    ],
    flags: "",
    sample: ["/home/", "leaked", "user/x"],
    mustNotMatch: [
      "/home/you/brain",
      "/Users/example/brain",
      "/home/test-user/.the-brain/agents",
      'parseConfig(undefined, "/home/test")',
      "cwd is /home/<user>/<your-project>",
      "~/.the-brain/agents",
    ],
  }),

  // -- Tickets --------------------------------------------------------------
  rule({
    label: "private-ticket-id",
    why: "Private issue-tracker identifiers point straight at closed ticket content and private project structure.",
    pattern: ["\\bIN", "K-\\d+\\b"],
    flags: "",
    sample: ["IN", "K-123"],
  }),
  rule({
    label: "private-ticket-id-nonnumeric",
    why: "Private issue-tracker identifiers with a non-numeric suffix (the tracker also mints ids with word suffixes, e.g. ...-ROLLOUT-2), which the numeric rule above cannot see. Case-sensitive, no leading \\b so a fused occurrence still fires.",
    pattern: ["IN", "K-[A-Z0-9]+"],
    flags: "",
    sample: ["IN", "K-FUSED2"],
  }),
  rule({
    label: "private-ticket-id-fused",
    why: "Private ticket id with the hyphen dropped and the prefix fused straight onto the number (seen fused into a test FILENAME). Substring, case-insensitive, so it fires inside identifiers and paths.",
    pattern: ["in", "k\\d+"],
    sample: ["in", "k700"],
  }),
  rule({
    label: "private-ticket-id-lowercase-hyphenated",
    why: "Private ticket id with the hyphen kept but lowercased. Git branch conventions lowercase everything, so a real id survives inside a branch-name string in neither the case the numeric rule requires nor the no-hyphen shape the fused rule requires. It also survives inside a lowercased example agent name in a template. Case-insensitive with a hyphen, but a leading \\b so it does not fire inside an unrelated word ending in the same letters.",
    pattern: ["\\bin", "k-\\d+"],
    sample: ["in", "k-691"],
  }),

  // -- Email ----------------------------------------------------------------
  rule({
    label: "company-email-address",
    why: "Addresses on the company mail domain are personal contact details, not public repo content.",
    pattern: ["[A-Za-z0-9._-]+@ink", "ie\\.ink\\b"],
    sample: ["someone@ink", "ie.ink"],
  }),

  // -- Credentials (backstop; a dedicated secret scanner is the primary) ----
  rule({
    label: "private-key-block",
    why: "A pasted private key is a leak whatever else it is. A dedicated secret scanner covers this properly; this entry keeps the local gate able to catch it too.",
    pattern: ["-----BEGIN [A-Z ]*", "PRIVATE KEY-----"],
    flags: "",
    sample: ["-----BEGIN ", "PRIVATE KEY-----"],
  }),
];

/**
 * Narrow, audited carve-outs: one exact repo-relative path paired with one
 * exact rule label.
 *
 * Both entries here exist for the same reason, and it is a reason no regex
 * can encode. An open-source project is legally required to name its
 * copyright holder, and a published package is expected to name a
 * contactable author. In those two fields the real identity is not a leak
 * that slipped through: it is the field's entire purpose, and removing it
 * would make the licence unenforceable and the package unattributable.
 * Everywhere else in this repository the same strings are leaks, and the
 * rules still fire on them.
 *
 * The alternative was a gate that is permanently red on two lines that are
 * never going to change, which within a fortnight becomes a gate nobody
 * reads. Whether the author field should carry a personal address or a role
 * address is an open question for the owner; if it becomes a role address,
 * the second entry here should be deleted and the self-test will insist on
 * it.
 */
const EXEMPTIONS = [
  {
    file: "LICENSE",
    label: "principal-first-name",
    why: "The copyright holder's real name is what makes the licence grant enforceable. A licence naming nobody grants nothing.",
  },
  {
    file: "package.json",
    label: "principal-first-name",
    why: "The package manifest's author field. Attribution metadata, published on purpose.",
  },
  {
    file: "package.json",
    label: "company-email-address",
    why: "The author field's contact address, in the same line as the entry above.",
  },
];

/** @param {string} relativePath @param {string} label */
function isExempt(relativePath, label) {
  return EXEMPTIONS.some((e) => e.file === relativePath && e.label === label);
}

/**
 * How far into a file a NUL byte still means "this file is binary".
 *
 * Git's own buffer_is_binary sniffs a LEADING WINDOW rather than the whole
 * file, and the reason it does is exactly the case this gate met. A whole-file
 * `buffer.includes(0)` exempted any file holding a NUL anywhere from all
 * rules, and the file that tripped it was a test whose hostile-input fixture
 * carries one deliberate literal NUL 20KB in. That single byte took the one
 * uncleaned file in an extraction - real names, paths and ticket ids intact -
 * out of scope, and the gate printed "clean" over it in the same words it uses
 * when it means it.
 *
 * A leading window separates the two real populations correctly: this
 * repository's genuine binaries all carry their first NUL within the first ten
 * bytes, and text that merely CONTAINS a NUL is scanned like the text it is.
 */
const BINARY_SNIFF_BYTES = 8000;

/** @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]} */
function scanFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return []; // binary file (NUL in the first 8000 bytes, matching git's own heuristic)
  }
  const relative = path.relative(REPO_ROOT, filePath);
  const findings = [];
  const lines = buffer.toString("utf8").split("\n");
  for (const [index, lineText] of lines.entries()) {
    for (const { label, why, re, where } of RULES) {
      if (where === "filename") continue;
      if (isExempt(relative, label)) continue;
      if (re.test(lineText)) {
        findings.push({ file: filePath, line: index + 1, label, why });
      }
    }
  }
  return findings;
}

/**
 * Denied material can live in a file's NAME with no trace in its content:
 * the observed case was a private ticket id fused into a test filename,
 * where every in-content reference had been cleaned and the path itself was
 * the only remaining copy. Content scanning cannot see that, so the
 * repo-relative path is run through the same rule set. Findings are
 * reported as line 0 to distinguish them from content findings.
 *
 * @param {string} filePath @returns {{ file: string, line: number, label: string, why: string }[]}
 */
function scanFileName(filePath) {
  const relative = path.relative(REPO_ROOT, filePath);
  const findings = [];
  for (const { label, why, re } of RULES) {
    if (isExempt(relative, label)) continue;
    if (re.test(relative)) {
      findings.push({ file: filePath, line: 0, label: `${label} (in filename)`, why });
    }
  }
  return findings;
}

/**
 * Every file in the working tree that git would consider part of the
 * repository: tracked, plus untracked-and-not-ignored.
 *
 * The `--others --exclude-standard` half is load-bearing rather than
 * defensive. Material arrives here by being copied in from the private
 * side, and it is untracked for as long as it takes to clean it, which is
 * exactly the window in which the gate is the only thing standing between
 * that material and a commit. Enumerating tracked files alone made the
 * sibling gate report "clean (39 files scanned)" over a working tree holding
 * 291 uncleaned files and 2,763 findings: a pass that meant nothing, printed
 * in the same words as a pass that means everything.
 */
function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(REPO_ROOT, relative))
    .filter((absolute) => fs.existsSync(absolute) && fs.statSync(absolute).isFile());
}

/** @param {string} message */
function fail(message) {
  console.error(`leak-gate self-test: ${message}`);
  process.exit(1);
}

/**
 * Prove every rule can fire, and that every deliberate carve-out holds,
 * without a single denied string ever existing inside the repository. Each
 * rule's sample is assembled at runtime and written to a temp file under the
 * OS temp dir; the gate is then pointed at that file and must report the rule.
 * A rule whose pattern rots (or whose sample drifts from it) fails the
 * self-test, so a silently dead denylist entry cannot pass CI.
 *
 * The negative half matters as much as the positive half. Several rules here
 * exist ONLY because of a carve-out (an owner slug that must keep working, a
 * hook-directory prefix that ships, a doubled consonant that separates a
 * person from a product). A rule can rot in that direction too, by starting
 * to fire on the thing it was written to permit, and the failure mode is a
 * maintainer widening the pattern to make the noise stop.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "leak-gate-self-test-"));
  const file = path.join(dir, "sample.txt");
  try {
    const contentRules = RULES.filter((r) => r.where !== "filename");
    const filenameRules = RULES.filter((r) => r.where === "filename");

    // --- positive: content rules ---
    fs.writeFileSync(file, contentRules.map((r) => r.sample).join("\n") + "\n", "utf8");
    const findings = scanFile(file);
    const missed = contentRules.filter((r) => !findings.some((f) => f.label === r.label));
    if (missed.length > 0) {
      for (const r of missed) {
        console.error(`leak-gate self-test: rule ${r.label} failed to catch its own sample`);
      }
      process.exit(1);
    }

    // --- positive: filename rules ---
    // These are skipped by content scanning by design, so they are proved on
    // the path they actually run on: a real file whose NAME is the sample.
    for (const r of filenameRules) {
      const named = path.join(dir, r.sample);
      fs.mkdirSync(path.dirname(named), { recursive: true });
      fs.writeFileSync(named, "clean content\n", "utf8");
      if (!scanFileName(named).some((f) => f.label.startsWith(r.label))) {
        fail(`filename rule ${r.label} failed to catch its own sample name`);
      }
      if (scanFile(named).some((f) => f.label === r.label)) {
        fail(`filename-only rule ${r.label} fired during a CONTENT scan; it will produce false positives on honest prose`);
      }
    }

    // --- negative: every declared carve-out must hold ---
    for (const r of RULES) {
      for (const allowed of r.mustNotMatch) {
        if (r.re.test(allowed)) {
          fail(
            `rule ${r.label} fires on ${JSON.stringify(allowed)}, which it is written to permit. Fix the pattern; do NOT delete the carve-out to make this pass.`,
          );
        }
      }
    }

    // --- the FILENAME scanning path is alive at all ---
    // A check that only exercised content would pass while a denied string
    // hid in a file's name. One representative content rule proves the path.
    const fusedSample = RULES.find((r) => r.label === "private-ticket-id-fused");
    if (!fusedSample) fail("private-ticket-id-fused rule missing");
    const namedFile = path.join(dir, `${fusedSample.sample}.txt`);
    fs.writeFileSync(namedFile, "clean content\n", "utf8");
    if (scanFileName(namedFile).length === 0) {
      fail("filename scanning failed to catch a denied string in a file name");
    }

    // --- the BINARY SNIFF is a leading window, not a whole-file check ---
    // This is the regression pin for an observed miss, not a hypothetical: one
    // real test file carried a deliberate literal NUL 20KB into a hostile-input
    // fixture, and under a whole-file check that byte exempted the entire file
    // from all rules while the gate reported clean over it. Two files here,
    // because the fix has two halves and either can rot alone: a NUL PAST the
    // window must not stop the scan, and a NUL INSIDE the window must still
    // skip the file (or the gate starts reading binaries and reporting noise).
    const pinned = RULES.find((r) => r.label === "private-ticket-id");
    if (!pinned) fail("private-ticket-id rule missing");
    const lateNulFile = path.join(dir, "late-nul.txt");
    fs.writeFileSync(
      lateNulFile,
      `${pinned.sample}\n${"filler line\n".repeat(1000)}\0 trailing binary-ish fixture\n`,
      "utf8",
    );
    if (fs.readFileSync(lateNulFile).indexOf(0) <= BINARY_SNIFF_BYTES) {
      fail("fixture is wrong, its NUL is inside the sniff window");
    }
    if (!scanFile(lateNulFile).some((f) => f.label === pinned.label)) {
      fail("a text file with a NUL past the sniff window was skipped, so any file holding one anywhere is unscanned");
    }
    const earlyNulFile = path.join(dir, "early-nul.bin");
    fs.writeFileSync(earlyNulFile, Buffer.concat([Buffer.from("\0PNG-ish\n"), Buffer.from(pinned.sample)]));
    if (scanFile(earlyNulFile).length > 0) {
      fail("a real binary was scanned as text; the sniff window is not being honoured");
    }

    // --- no exemption may outlive its reason ---
    // An exemption suppresses a real finding. If the finding is gone, the
    // exemption is dead weight that will silently cover the NEXT one to
    // appear in that file. Proving it is still load-bearing costs one scan.
    for (const { file: relative, label, why } of EXEMPTIONS) {
      const absolute = path.join(REPO_ROOT, relative);
      if (!fs.existsSync(absolute)) {
        fail(`exemption for ${relative} [${label}] names a file that does not exist`);
      }
      const r = RULES.find((x) => x.label === label);
      if (!r) fail(`exemption for ${relative} names rule ${label}, which does not exist`);
      const text = fs.readFileSync(absolute, "utf8");
      const stillFires = text.split("\n").some((line) => r.re.test(line)) || r.re.test(relative);
      if (!stillFires) {
        fail(
          `exemption for ${relative} [${label}] is stale: nothing in that file trips the rule any more. Delete the exemption (reason on record: ${why}).`,
        );
      }
    }

    console.log(
      `leak-gate self-test: all ${RULES.length} rules fire correctly and every carve-out holds ` +
        `(content, filename, negative, binary-sniff and exemption-freshness paths; ${EXEMPTIONS.length} exemptions, all still load-bearing)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    selfTest();
    return;
  }
  const files = args.length > 0 ? args : repositoryFiles();
  const findings = files.flatMap((file) => [...scanFileName(file), ...scanFile(file)]);
  const exemptionNote =
    EXEMPTIONS.length > 0 ? `, ${EXEMPTIONS.length} exemption(s) active (see EXEMPTIONS in scripts/leak-gate.mjs)` : "";
  if (findings.length > 0) {
    for (const { file, line, label, why } of findings) {
      console.error(`${path.relative(REPO_ROOT, file)}:${line}: [${label}] ${why}`);
    }
    console.error(
      `\nleak-gate: ${findings.length} finding(s)${exemptionNote}. This material must not enter the repository; see the rule comments in scripts/leak-gate.mjs.`,
    );
    process.exit(1);
  }
  console.log(`leak-gate: clean (${files.length} files scanned, ${RULES.length} rules${exemptionNote})`);
}

main();
