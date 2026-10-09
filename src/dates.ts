import { moment } from "obsidian";
import type { App, BasesEntry, BasesPropertyId, Value } from "obsidian";

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParsedTime {
	ms: number;
	/** True when the source had no time-of-day component. */
	dateOnly: boolean;
	/** moment format that reproduces how the value was written, for write-back. */
	format: string;
	/** UTC offset (minutes) the value was written with, if it carried one ("Z", "+05:30"). */
	utcOffset?: number;
}

/** Format a time the way its source was written (same precision, separator and zone). */
export function formatParsed(ms: number, t: ParsedTime): string {
	const m = t.utcOffset !== undefined ? moment(ms).utcOffset(t.utcOffset) : moment(ms);
	return m.format(t.format);
}

const DATE_FORMAT = "YYYY-MM-DD";
const DATETIME_FORMAT = "YYYY-MM-DDTHH:mm";

export type DeclaredType = "date" | "datetime" | "other" | null;

/**
 * The type a frontmatter property is declared as in Obsidian's property types
 * (Settings → Properties), or null when unknown / not a note property. Uses
 * Obsidian's internal type registry; returns null if that ever changes.
 */
export function declaredType(app: App, prop: BasesPropertyId | null | undefined): DeclaredType {
	const id = prop ? String(prop) : "";
	if (!id.startsWith("note.")) return null;
	const name = id.slice("note.".length);
	const registry = (app as unknown as {
		metadataTypeManager?: {
			getAssignedWidget?(name: string): string | null | undefined;
			getPropertyInfo?(name: string): { widget?: string } | undefined;
		};
	}).metadataTypeManager;
	let widget: string | null | undefined;
	try {
		widget = registry?.getAssignedWidget?.(name) ?? registry?.getPropertyInfo?.(name.toLowerCase())?.widget;
	} catch {
		return null;
	}
	if (!widget) return null;
	return widget === "date" ? "date" : widget === "datetime" ? "datetime" : "other";
}

/**
 * How to write a brand-new value for a property: its declared type decides date
 * vs date-and-time; otherwise follow `fallback` (e.g. the start value's format).
 */
export function newValueFormat(type: DeclaredType, fallback: ParsedTime | null): ParsedTime {
	if (type === "date") return { ms: 0, dateOnly: true, format: DATE_FORMAT };
	if (type === "datetime") return { ms: 0, dateOnly: false, format: DATETIME_FORMAT };
	return fallback ? { ...fallback, ms: 0 } : { ms: 0, dateOnly: true, format: DATE_FORMAT };
}

/** Pick a write-back format matching the original text (separator, seconds). */
function formatOf(str: string): string {
	const sep = /\d \d/.test(str) ? " " : "T";
	const seconds = /\d{2}:\d{2}:\d{2}/.test(str) ? ":ss" : "";
	const zone = /Z$/i.test(str) ? "[Z]" : /[+-]\d{2}:?\d{2}$/.test(str) ? (str.includes(":", str.length - 6) ? "Z" : "ZZ") : "";
	return `YYYY-MM-DD${sep}HH:mm${seconds}${zone}`;
}

const ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a raw frontmatter / string value into a timestamp, in local time. */
export function parseRaw(raw: unknown): ParsedTime | null {
	if (raw === undefined || raw === null || raw === "") return null;
	if (raw instanceof Date) {
		return isNaN(raw.getTime()) ? null : { ms: raw.getTime(), dateOnly: false, format: DATETIME_FORMAT };
	}
	// Numbers aren't dates in frontmatter (20261006 would otherwise land in 1970).
	if (typeof raw === "number") return null;
	const str = String(raw).trim();
	if (DATE_ONLY_RE.test(str)) {
		const m = moment(str, "YYYY-MM-DD", true);
		return m.isValid() ? { ms: m.valueOf(), dateOnly: true, format: DATE_FORMAT } : null;
	}
	const m = moment(str, [moment.ISO_8601, "YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss"], true);
	if (m.isValid()) {
		const parsed: ParsedTime = { ms: m.valueOf(), dateOnly: false, format: formatOf(str) };
		if (ZONE_RE.test(str)) parsed.utcOffset = moment.parseZone(str).utcOffset();
		return parsed;
	}
	// Last resort for other full dates; needs a 4-digit year so "Oct 5" isn't read as 2001.
	if (!/\d{4}/.test(str)) return null;
	const d = new Date(str);
	return isNaN(d.getTime()) ? null : { ms: d.getTime(), dateOnly: false, format: DATETIME_FORMAT };
}

/**
 * Read a property as a time. `note.*` properties are read from the frontmatter
 * cache so the exact written value (date vs datetime) is known; formula and file
 * properties fall back to the Bases Value.
 */
export function readTime(app: App, entry: BasesEntry, prop: BasesPropertyId): ParsedTime | null {
	const str = String(prop);
	if (str.startsWith("note.")) {
		const fm = app.metadataCache.getFileCache(entry.file)?.frontmatter;
		const parsed = parseRaw(fm?.[str.slice("note.".length)]);
		if (parsed) return parsed;
	}
	let value: Value | null = null;
	try {
		value = entry.getValue(prop);
	} catch {
		return null;
	}
	if (!value || !value.isTruthy()) return null;
	// DateValue keeps its JS Date on a non-public field; use it when present.
	const inner = (value as unknown as { date?: unknown }).date;
	if (inner instanceof Date && !isNaN(inner.getTime())) {
		const dateOnly = DATE_ONLY_RE.test(value.toString());
		return { ms: inner.getTime(), dateOnly, format: dateOnly ? DATE_FORMAT : DATETIME_FORMAT };
	}
	return parseRaw(value.toString());
}
