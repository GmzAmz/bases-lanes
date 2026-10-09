import { ListValue, NullValue, moment } from "obsidian";
import type { App, BasesEntry, BasesPropertyId, TFile, Value } from "obsidian";
import type { Timed } from "./layout";

/** A note as handed to a metric function. */
export interface MetricNote {
	file: TFile;
	path: string;
	name: string;
	/** Start and (exclusive) end in ms; a date-only end covers its whole day. */
	start: number;
	end: number;
	/** True when the start value has no time of day. */
	dateOnly: boolean;
	/** Read a property: `formula.x`, `note.x`, `file.x`, or a bare name (formula first, then note). */
	get(name: string): unknown;
}

export interface MetricContext {
	/** Visible time range, in ms. */
	windowStart: number;
	windowEnd: number;
	/** "row" for a row, "group" for a lanes_group section header. */
	scope: "row" | "group";
	/** Row name (scope "row"), else null. */
	row: string | null;
	/** Link target when the row's value is a link, else null. */
	link: string | null;
	/** Section name (scope "group"), else null. */
	group: string | null;
	app: App;
	moment: typeof moment;
}

export type MetricResult = string | number | null | undefined | { text?: unknown; tooltip?: unknown; color?: unknown };
export type MetricFn = (notes: MetricNote[], ctx: MetricContext) => MetricResult;

export interface LoadedScript {
	fns: Record<string, MetricFn>;
	error: string | null;
}

/**
 * Evaluate a CommonJS-style script (`module.exports = { name(notes, ctx) {...} }`)
 * and collect its exported functions.
 */
export function evaluateScript(code: string, path: string): LoadedScript {
	try {
		const module = { exports: {} as Record<string, unknown> };
		const req = (window as unknown as { require?: unknown }).require;
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		new Function("module", "exports", "require", "moment", `${code}\n//# sourceURL=${encodeURI(path)}`)(module, module.exports, req, moment);
		const fns: Record<string, MetricFn> = {};
		const exported = module.exports;
		if (exported && typeof exported === "object") {
			for (const [name, value] of Object.entries(exported)) {
				if (typeof value === "function") fns[name] = value as MetricFn;
			}
		}
		const error = Object.keys(fns).length === 0 ? "The script exports no functions (use module.exports = { name(notes, ctx) { ... } })." : null;
		return { fns, error };
	} catch (e) {
		return { fns: {}, error: errorText(e) };
	}
}

export function errorText(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Convert a Bases value to plain JS: null, number, string, boolean, Date or array. */
export function toPlain(value: Value | null | undefined): unknown {
	if (!value || value instanceof NullValue) return null;
	if (value instanceof ListValue) {
		const out: unknown[] = [];
		for (let i = 0; i < value.length(); i++) out.push(toPlain(value.get(i)));
		return out;
	}
	// Not public API: dates keep a Date in `date`, primitives their value in `data`.
	const raw = value as unknown as { date?: unknown; data?: unknown };
	if (raw.date instanceof Date) return raw.date;
	const data = raw.data;
	if (typeof data === "number" || typeof data === "string" || typeof data === "boolean") return data;
	return value.toString();
}

export function makeNote(timed: Timed): MetricNote {
	const entry: BasesEntry = timed.entry;
	const read = (id: string): unknown => {
		try {
			return toPlain(entry.getValue(id as BasesPropertyId));
		} catch {
			return null;
		}
	};
	return Object.freeze({
		file: entry.file,
		path: entry.file.path,
		name: entry.file.basename,
		start: timed.start,
		end: timed.end,
		dateOnly: timed.startTime.dateOnly,
		get(name: string): unknown {
			if (/^(formula|note|file)\./.test(name)) return read(name);
			const formula = read(`formula.${name}`);
			return formula !== null ? formula : read(`note.${name}`);
		},
	});
}

/** How a result is shown: text, optional tooltip and colour. */
export function describeResult(result: MetricResult): { text: string; tooltip: string | null; color: string | null } {
	if (result === null || result === undefined) return { text: "", tooltip: null, color: null };
	if (typeof result === "object") {
		const color = typeof result.color === "string" && CSS.supports("color", result.color) ? result.color : null;
		const tooltip = result.tooltip === null || result.tooltip === undefined ? null : String(result.tooltip);
		return { text: formatValue(result.text), tooltip, color };
	}
	return { text: formatValue(result), tooltip: null, color: null };
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return String(value);
		return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
	}
	return String(value);
}
