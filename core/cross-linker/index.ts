import { readFile, writeFile, access } from "fs/promises";
import { basename, relative } from "path";
import { glob } from "glob";
import { config } from "../config.js";
import { embedText } from "../embedder/text.js";
import { search, ensureCollections } from "../qdrant/client.js";

const CROSS_LINK_THRESHOLD = 0.45;
const MAX_LINKS = 5;
const SECTION_HEADER = "## Related Brain Files";

function relativePath(filePath: string): string {
  return relative(config.workspaceRoot, filePath);
}

function sourceToWikiLink(source: string): string {
  // source is like "brain/ideas/cosmos-so.md" -> [[ideas/cosmos-so]]
  const withoutBrain = source.replace(/^brain\//, "");
  const withoutExt = withoutBrain.replace(/\.md$/, "");
  return `[[${withoutExt}]]`;
}

export async function crossLinkFile(observationPath: string): Promise<number> {
  // Read the observation
  const content = await readFile(observationPath, "utf-8");

  // Skip if already cross-linked
  if (content.includes(SECTION_HEADER)) {
    return 0;
  }

  // Embed the observation text
  const queryVector = await embedText(content, "RETRIEVAL_QUERY");

  // Search brain-vault only
  const results = await search(
    [config.collections.brain],
    queryVector,
    MAX_LINKS,
    CROSS_LINK_THRESHOLD
  );

  if (results.length === 0) {
    return 0;
  }

  // Deduplicate by source file (multiple chunks from same file)
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    if (seen.has(r.source)) return false;
    seen.add(r.source);
    return true;
  });

  // Build the cross-link section
  const links = unique.map((r) => {
    const wikiLink = sourceToWikiLink(r.source);
    const preview = r.title.replace(/^.* > /, ""); // Use leaf title
    return `- ${wikiLink} (${r.score.toFixed(2)}) — ${preview}`;
  });

  const section = `\n\n${SECTION_HEADER}\n${links.join("\n")}\n`;

  // Append to observation file
  await writeFile(observationPath, content.trimEnd() + section);

  return unique.length;
}

export async function crossLinkAll(): Promise<{ linked: number; skipped: number }> {
  let linked = 0;
  let skipped = 0;

  for (const dir of config.sources.observations) {
    let files: string[];
    try {
      files = await glob(`${dir}/**/*.md`);
    } catch {
      continue;
    }

    for (const file of files) {
      const content = await readFile(file, "utf-8");
      if (content.includes(SECTION_HEADER)) {
        skipped++;
        continue;
      }

      try {
        const count = await crossLinkFile(file);
        if (count > 0) {
          console.error(`Cross-linked: ${relativePath(file)} (${count} links)`);
          linked++;
        } else {
          console.error(`No matches: ${relativePath(file)}`);
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error cross-linking ${relativePath(file)}: ${msg}`);
      }
    }
  }

  return { linked, skipped };
}
