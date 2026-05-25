/** Logical CLI name (frontmatter `cli`) → executables to try on PATH, in order. */
const CLI_BIN_CANDIDATES: Record<string, string[]> = {
	antigravity: ["agy", "antigravity"],
	agy: ["agy", "antigravity"],
};

export function cliBinCandidates(cli: string, bin?: string): string[] {
	if (bin) return [bin];
	return CLI_BIN_CANDIDATES[cli] ?? [cli];
}

export function defaultCliBin(cli: string, bin?: string): string {
	return cliBinCandidates(cli, bin)[0]!;
}

export function isAntigravityCli(cli: string): boolean {
	return cli === "antigravity" || cli === "agy";
}
