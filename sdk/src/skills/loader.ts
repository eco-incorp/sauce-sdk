import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// At runtime this file is at dist/skills/loader.js, so package root is ../..
// The .md files live at src/skills/ which ships with the package
const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(thisDir, "..", "..");
const skillsDir = join(packageRoot, "src", "skills");

/**
 * Load the master protocol index skill file.
 * Returns markdown content with all protocols, categories, operations, and chain coverage.
 */
export function getProtocolIndex(): string {
  return readFileSync(join(skillsDir, "index.md"), "utf-8");
}

/**
 * Load a specific protocol's skill file by slug.
 * Returns markdown describing the protocol, its operations,
 * SauceScript examples, contract addresses, and ABI methods.
 */
export function getProtocolSkill(slug: string): string {
  const filePath = join(skillsDir, `${slug}.md`);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `No skill file found for protocol "${slug}". Check listSkillSlugs() for valid slugs.`,
    );
  }
}

/**
 * List all available protocol skill slugs.
 */
export function listSkillSlugs(): string[] {
  return readdirSync(skillsDir)
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .map((f) => f.replace(".md", ""))
    .sort();
}

/**
 * Absolute path to the skills directory (for direct file access).
 */
export const SKILLS_DIR = skillsDir;
