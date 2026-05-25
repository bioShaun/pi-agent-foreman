export function truncate(text: string, max = 72): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
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
