import { ListValue, NullValue } from "obsidian";
import type { BasesEntry, BasesPropertyId, BasesViewConfig, Value } from "obsidian";
import type { ParsedTime } from "./dates";
import { readProp, valueToText } from "./colors";

export interface LaneItem {
	/** Unique per rendered copy: `path::rowKey`. */
	id: string;
	entry: BasesEntry;
	start: number;
	end: number;
	/** Sub-row inside the lane, assigned by packLane. */
	track: number;
	/** Key of the lane this copy is rendered in. */
	laneKey: string;
	timed: Timed;
}

export interface Lane {
	key: string;
	label: string;
	items: LaneItem[];
	trackCount: number;
	/** Sections this row is shown under (from the view's sections option); empty for none. */
	groups: string[];
	/** Link target when the row's value is a link (e.g. a person note), else null. */
	link: string | null;
}

export const NO_VALUE_KEY = "\u0000none";
export const ALL_KEY = "\u0000all";

export interface GroupBy {
	property: BasesPropertyId;
	descending: boolean;
}

/**
 * BasesViewConfig carries the native group-by at runtime, but the public d.ts
 * doesn't declare it. Returns null when there is no group-by (or the internal
 * shape changes).
 */
export function getNativeGroupBy(config: BasesViewConfig): GroupBy | null {
	const groupBy = (config as unknown as { groupBy?: { property?: unknown; direction?: unknown } }).groupBy;
	const raw = groupBy?.property;
	if (typeof raw !== "string" || raw.length === 0) return null;
	return {
		property: (/^(note|file|formula)\./.test(raw) ? raw : `note.${raw}`) as BasesPropertyId,
		descending: String(groupBy?.direction).toUpperCase() === "DESC",
	};
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function cleanLabel(s: string): string {
	const t = s.trim();
	// [[Alice]] / [[Alice|Al]] -> Alice: rows key on the link target, so an alias
	// doesn't split one person into two rows.
	const link = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(t);
	if (link) return link[1].trim();
	return t;
}

/** Split a group-by value into one label per row it should appear in. */
export function splitValue(value: Value | null): string[] {
	return splitEntries(value).map((e) => e.label);
}

const LINK_RE = /^\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*$/;

/** Like splitValue, but also reports which values are links (and to what). */
export function splitEntries(value: Value | null): { label: string; link: string | null }[] {
	if (!value || value instanceof NullValue || !value.isTruthy()) return [];
	if (value instanceof ListValue) {
		const out: { label: string; link: string | null }[] = [];
		for (let i = 0; i < value.length(); i++) out.push(...splitEntries(value.get(i)));
		return out;
	}
	const text = value.toString();
	const label = cleanLabel(text);
	if (label.length === 0) return [];
	const link = LINK_RE.exec(text);
	return [{ label, link: link ? link[1].trim() : null }];
}

/** Every group name in a value, flattening nested lists. */
export function groupTexts(value: Value | null): string[] {
	if (!value || value instanceof NullValue || !value.isTruthy()) return [];
	if (value instanceof ListValue) {
		const out: string[] = [];
		for (let i = 0; i < value.length(); i++) out.push(...groupTexts(value.get(i)));
		return out;
	}
	const text = cleanLabel(valueToText(value));
	return text.length > 0 ? [text] : [];
}

/** Add a group to a lane once, matching case-insensitively. */
export function addGroup(lane: Lane, name: string): void {
	const key = name.toLowerCase();
	if (!lane.groups.some((g) => g.toLowerCase() === key)) lane.groups.push(name);
}

export interface Timed {
	entry: BasesEntry;
	start: number;
	/** Exclusive end: a date-only end covers its whole day. */
	end: number;
	startTime: ParsedTime;
	/** Null when the note has no end value (end is derived from start). */
	endTime: ParsedTime | null;
}

/**
 * Flatten Bases groups into lanes, giving a note one lane per value of the
 * group-by property. Lanes are sorted by label in the group-by direction;
 * "no value" goes last. Entry order within Bases' groups (the user's sort) is kept.
 */
/**
 * Source rows for buildLanes. With a known group-by property, pass the plain
 * sorted entries as one group: the property is split here, so Bases' own
 * grouping isn't needed (and grouping by a list property is slow in Bases: one
 * group per distinct combination). Without one, pass Bases' groupedData and the
 * group keys are used as row labels.
 */
export interface EntrySource {
	key: Value | null;
	entries: BasesEntry[];
}

export function buildLanes(
	groups: EntrySource[],
	groupBy: GroupBy | null,
	timeOf: (entry: BasesEntry) => Timed | null,
	/** View option "Row sections": the property or formula that groups rows. */
	sectionProp: BasesPropertyId | null = null,
): Lane[] {
	const lanes = new Map<string, Lane>();
	const getLane = (key: string, label: string): Lane => {
		let lane = lanes.get(key);
		if (!lane) {
			lane = { key, label, items: [], trackCount: 1, groups: [], link: null };
			lanes.set(key, lane);
		}
		return lane;
	};

	// Row key -> link target, for rows whose value is a link.
	const linkOf = new Map<string, string>();
	for (const group of groups) {
		for (const entry of group.entries) {
			const timed = timeOf(entry);
			if (!timed) continue;

			let labels: string[];
			if (groupBy) {
				let value: Value | null = null;
				try {
					value = entry.getValue(groupBy.property);
				} catch {
					value = null;
				}
				const entries = splitEntries(value);
				labels = entries.map((e) => e.label);
				for (const e of entries) if (e.link) linkOf.set(e.label.toLowerCase(), e.link);
			} else {
				// Group-by unreadable: fall back to Bases' group keys (none configured: one row).
				labels = group.key ? splitValue(group.key) : [];
				if (labels.length === 0) labels = [group.key ? NO_VALUE_KEY : ALL_KEY];
			}

			// Sections: a list the same length as the group-by values pairs up by
			// position (e.g. each assignee's departments); anything else applies to all.
			// Any value, or paired element, may itself be a list: the row joins every group.
			const groupValue = readProp(entry, sectionProp);
			const perLabel = groupValue instanceof ListValue && groupValue.length() === labels.length;
			const groupsFor = (i: number): string[] => {
				if (!groupValue) return [];
				return groupTexts(perLabel ? (groupValue as ListValue).get(i) : groupValue);
			};

			const seen = new Set<string>();
			if (labels.length === 0) labels = [NO_VALUE_KEY];
			for (const [i, label] of labels.entries()) {
				const key = label === ALL_KEY || label === NO_VALUE_KEY ? label : label.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				const display = key === ALL_KEY ? "" : key === NO_VALUE_KEY ? "(no value)" : label;
				const lane = getLane(key, display);
				lane.link ??= linkOf.get(key) ?? null;
				// Sections only make sense between rows; the single no-group-by row has none.
				if (key !== ALL_KEY) for (const g of groupsFor(i)) addGroup(lane, g);
				lane.items.push({
					id: `${entry.file.path}::${key}`,
					entry,
					start: timed.start,
					end: timed.end,
					track: 0,
					laneKey: key,
					timed,
				});
			}
		}
	}

	const dir = groupBy?.descending ? -1 : 1;
	const ordered = [...lanes.values()].sort((a, b) => {
		if (a.key === NO_VALUE_KEY || b.key === NO_VALUE_KEY) {
			return (a.key === NO_VALUE_KEY ? 1 : 0) - (b.key === NO_VALUE_KEY ? 1 : 0);
		}
		return dir * collator.compare(a.label, b.label);
	});
	for (const lane of ordered) packLane(lane);
	return ordered;
}

/** Greedy interval packing: each item goes in the first sub-row it fits. */
export function packLane(lane: Lane): void {
	const items = [...lane.items].sort((a, b) => a.start - b.start || b.end - a.end);
	const trackEnds: number[] = [];
	for (const item of items) {
		// Zero-length items still occupy their instant, so several at the same time stack.
		const end = Math.max(item.end, item.start + 1);
		let t = trackEnds.findIndex((e) => e <= item.start);
		if (t < 0) {
			t = trackEnds.length;
			trackEnds.push(end);
		} else {
			trackEnds[t] = end;
		}
		item.track = t;
	}
	lane.trackCount = Math.max(1, trackEnds.length);
}
