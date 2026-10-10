import { ListValue } from "obsidian";
import type { BasesEntry, BasesPropertyId, Value } from "obsidian";
import { getPalette } from "./palette";

/** Read a property or formula chosen in the view options; null when unset or empty. */
export function readProp(entry: BasesEntry, prop: BasesPropertyId | null): Value | null {
	if (!prop) return null;
	try {
		const value = entry.getValue(prop);
		return value && value.isTruthy() ? value : null;
	} catch {
		// Formula removed from the base, or it errored.
		return null;
	}
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
 * Resolve colors for a whole result set. A note's color property wins;
 * otherwise each distinct color-bucket value takes the next palette color, in
 * the order the values first appear in `entries` (the base's sort). Notes with
 * neither are left out, so they keep the theme accent.
 */
export function assignColors(entries: BasesEntry[], colorProp: BasesPropertyId | null, bucketProp: BasesPropertyId | null): Map<string, string> {
	if (!colorProp && !bucketProp) return new Map();
	const palette = getPalette();
	const buckets = new Map<string, string>();
	const colors = new Map<string, string>();

	for (const entry of entries) {
		const path = entry.file.path;
		if (colors.has(path)) continue;

		const manual = readProp(entry, colorProp);
		if (manual) {
			const text = valueToText(manual);
			if (isCssColor(text)) {
				colors.set(path, text);
				continue;
			}
		}

		const bucket = readProp(entry, bucketProp);
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
