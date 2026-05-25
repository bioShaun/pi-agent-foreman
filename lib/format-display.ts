export function truncate(text: string, max = 72): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Strip `bash -lc` / `/bin/zsh -lc` wrappers from Codex command_execution. */
export function stripShellWrapper(command: string): string {
	let cmd = command.trim();
	const wrapper = cmd.match(/^(\/?(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
	if (!wrapper) return cmd;

	cmd = wrapper[2]!.trim();
	if (
		(cmd.startsWith("'") && cmd.endsWith("'")) ||
		(cmd.startsWith('"') && cmd.endsWith('"'))
	) {
		cmd = cmd.slice(1, -1);
	}
	return cmd.trim();
}

function pathsInCommand(text: string): string[] {
	const paths: string[] = [];
	const re = /(?:^|[\s'"=])(~?[\w./-]+\.(?:py|ts|tsx|js|md|json|yaml|yml|toml|sh|txt|log))/gi;
	for (const m of text.matchAll(re)) {
		paths.push(m[1]!);
	}
	return paths;
}

function shortenPathsInText(text: string): string {
	return text.replace(/(?:~\/[\w./-]+|\/Users\/[\w./-]+|\/[\w./-]+\.\w+)/g, (p) => shortenDisplayPath(p));
}

/** Compress raw shell commands into loader-friendly summaries. */
export function summarizeShellCommand(command: string, max = 88): string {
	let cmd = stripShellWrapper(command).replace(/\s+/g, " ");
	if (!cmd) return truncate(command.trim(), max);

	if (/^git\s+/i.test(cmd)) {
		const m = cmd.match(/^git\s+\S+(?:\s+\S+)?/i);
		return truncate(m?.[0] ?? cmd, max);
	}

	if (/(?:^|;\s*|&&\s*)(?:python3?\s+-m\s+)?pytest\b/i.test(cmd)) {
		const paths = pathsInCommand(cmd).map((p) => shortenDisplayPath(p));
		const summary = paths.length ? `pytest ${paths.slice(0, 2).join(" ")}` : "pytest";
		const extra = paths.length > 2 ? ` (+${paths.length - 2})` : "";
		return truncate(`${summary}${extra}`, max);
	}

	if (/\bpython3?\s+-m\s+\w+/i.test(cmd)) {
		const m = cmd.match(/\bpython3?\s+-m\s+(\S+)(?:\s+(.+))?/i);
		if (m) {
			const tail = m[2] ? ` ${shortenPathsInText(m[2]).split(" ").slice(0, 3).join(" ")}` : "";
			return truncate(`python -m ${m[1]}${tail}`, max);
		}
	}

	if (/\bnl\b/i.test(cmd) && /\bsed\b/i.test(cmd)) {
		const paths = pathsInCommand(cmd);
		if (paths[0]) return truncate(`read ${shortenDisplayPath(paths[0])}`, max);
	}

	const toolMatch = cmd.match(/\b(cat|head|tail|sed|awk|grep|rg|ripgrep|find|wc|ls|nl)\b/i);
	if (toolMatch) {
		const tool = toolMatch[1]!.toLowerCase();
		const paths = pathsInCommand(cmd);
		if (tool === "grep" || tool === "rg" || tool === "ripgrep") {
			const pat = cmd.match(/(?:grep|rg)\s+(['"]?)(.+?)\1(?:\s|$)/i)?.[2];
			const target = paths.at(-1) ? shortenDisplayPath(paths.at(-1)!) : ".";
			if (pat) return truncate(`grep /${pat.slice(0, 36)}/ in ${target}`, max);
		}
		if (paths.length) {
			return truncate(`${tool} ${shortenDisplayPath(paths.at(-1)!)}`, max);
		}
	}

	if (cmd.includes("|")) {
		const segments = cmd.split("|").map((s) => s.trim());
		const inner = summarizeShellCommand(segments.at(-1) ?? cmd, max - 3);
		return segments.length > 1 ? truncate(`${inner} │…`, max) : inner;
	}

	return truncate(shortenPathsInText(cmd), max);
}

export function shortenDisplayPath(p: string, relativeTo?: string): string {
	let path = p.replace(/^file:\/\//, "");
	if (relativeTo && path.startsWith(`${relativeTo}/`)) {
		return path.slice(relativeTo.length + 1);
	}
	return path.replace(/^\/Users\/[^/]+/, "~");
}

export function progressLine(body: string): string {
	const t = body.trim();
	return t.startsWith("$ ") ? t : `$ ${t}`;
}
