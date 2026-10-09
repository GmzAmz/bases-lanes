import { ListValue } from "obsidian";
import type { BasesEntry, BasesPropertyId, Value } from "obsidian";
import { getPalette } from "./palette";

export const COLOR_PROPERTY = "lanes_color";
export const BUCKET_PROPERTY = "lanes_bucket_color";
export const GROUP_PROPERTY = "lanes_group";
export const TITLE_PROPERTY = "lanes_title";

/**
 * Read a property, preferring a base formula of that name over the note's own
 * frontmatter. This lets a base define e.g. `lanes_color: color` or
 * `lanes_bucket_color: file.tags` without touching the notes.
 */
export function readNamed(entry: BasesEntry, name: string): Value | null {
	for (const prefix of ["formula", "note"]) {
		try {
			const value = entry.getValue(`${prefix}.${name}` as BasesPropertyId);
			if (value && value.isTruthy()) return value;
		} catch {
			// Formula not defined in this base, or it errored: fall through.
		}
	}
	return null;
}

export function valueToText(value: Value): string {
	if (value instanceof ListValue) {
		const parts: string[] = [];
		for (let i = 0; i < value.length(); i++) parts.push(value.get(i).toString().trim());
		return parts.filter((p) => p.length > 0).join(", ");
	}
	return value.toString().trim();
}

function isCssColor(text: string): boolean {
	return text.length > 0 && CSS.supports("color", text);
}

/**
 * Resolve colors for a whole result set. A note's own `lanes_color` wins;
 * otherwise each distinct `lanes_bucket_color` value takes the next palette
 * color, in the order the values first appear in `entries` (the base's sort).
 * Notes with neither are left out, so they keep the theme accent.
 */
export function assignColors(entries: BasesEntry[]): Map<string, string> {
	const palette = getPalette();
	const buckets = new Map<string, string>();
	const colors = new Map<string, string>();

	for (const entry of entries) {
		const path = entry.file.path;
		if (colors.has(path)) continue;

		const manual = readNamed(entry, COLOR_PROPERTY);
		if (manual) {
			const text = valueToText(manual);
			if (isCssColor(text)) {
				colors.set(path, text);
				continue;
			}
		}

		const bucket = readNamed(entry, BUCKET_PROPERTY);
		const key = bucket ? valueToText(bucket).toLowerCase() : "";
		if (key.length === 0) continue;
		let color = buckets.get(key);
		if (!color) {
			color = palette[buckets.size % palette.length];
			buckets.set(key, color);
		}
		colors.set(path, color);
	}
	return colors;
}
