/**
 * Load the master protocol index skill file.
 * Returns markdown content with all protocols, categories, operations, and chain coverage.
 */
export declare function getProtocolIndex(): string;
/**
 * Load a specific protocol's skill file by slug.
 * Returns markdown describing the protocol, its operations,
 * SauceScript examples, contract addresses, and ABI methods.
 */
export declare function getProtocolSkill(slug: string): string;
/**
 * List all available protocol skill slugs.
 */
export declare function listSkillSlugs(): string[];
/**
 * Absolute path to the skills directory (for direct file access).
 */
export declare const SKILLS_DIR: string;
//# sourceMappingURL=loader.d.ts.map