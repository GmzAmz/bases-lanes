// Bases Lanes row metrics. Each export gets (notes, ctx) and returns text, a number,
// or { text, tooltip, color }. ctx.windowStart / ctx.windowEnd are the visible range in ms.

/** Note spans clipped to the visible window, sorted by start. */
function clipped(notes, ctx) {
	return notes
		.map((n) => [Math.max(n.start, ctx.windowStart), Math.min(n.end, ctx.windowEnd)])
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0]);
}

/** Time covered by at least `min` notes at once. */
function coveredBy(spans, min) {
	const edges = [];
	for (const [a, b] of spans) edges.push([a, 1], [b, -1]);
	edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	let depth = 0, last = 0, total = 0;
	for (const [t, d] of edges) {
		if (depth >= min) total += t - last;
		depth += d;
		last = t;
	}
	return total;
}

module.exports = {
	/** Share of the visible window with at least one note. */
	coverage(notes, ctx) {
		const busy = coveredBy(clipped(notes, ctx), 1);
		const pct = Math.round((100 * busy) / (ctx.windowEnd - ctx.windowStart));
		return { text: pct + "%", tooltip: (busy / 864e5).toFixed(1) + " days busy in view" };
	},

	/** Time double-booked in the visible window; red when there is any. */
	overlap(notes, ctx) {
		if (ctx.scope === "group") return null;
		const days = coveredBy(clipped(notes, ctx), 2) / 864e5;
		if (days === 0) return "";
		return { text: days < 1 ? Math.round(days * 24) + "h" : days.toFixed(1) + "d", tooltip: "Overlapping notes in view", color: "var(--text-error)" };
	},

	/** Notes in the visible window. */
	count(notes, ctx) {
		return clipped(notes, ctx).length;
	},
};
