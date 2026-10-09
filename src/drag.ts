import { moment } from "obsidian";
import { formatParsed } from "./dates";
import type { ParsedTime } from "./dates";
import { cleanLabel, NO_VALUE_KEY } from "./layout";
import type { Timed } from "./layout";

export type DragMode = "move" | "start" | "end";
export type Unit = "days" | "hours";

const UNIT_MS: Record<Unit, number> = { days: 24 * 60 * 60 * 1000, hours: 60 * 60 * 1000 };

/** Date-only values move in whole days; datetimes in whole hours, keeping their minutes. */
function unitOf(t: ParsedTime | null, fallback: ParsedTime): Unit {
	return (t ?? fallback).dateOnly ? "days" : "hours";
}

function shift(ms: number, steps: number, unit: Unit): number {
	return steps === 0 ? ms : moment(ms).add(steps, unit).valueOf();
}

export interface DragResult {
	start: number;
	/** Exclusive, like Timed.end. */
	end: number;
	/**
	 * The snapped edit as steps, applied to the note's *current* values on commit,
	 * so a drag started before the previous one re-rendered doesn't overwrite it.
	 */
	startSteps?: number;
	endSteps?: number;
	unit?: Unit;
}

/** Shift a parsed time by whole steps (calendar-aware for days). */
export function shiftParsed(t: ParsedTime, steps: number, unit: Unit): ParsedTime {
	return steps === 0 ? t : { ...t, ms: moment(t.ms).add(steps, unit).valueOf() };
}

/** Apply a horizontal drag of `deltaMs` to an item, snapped per the rules above. */
export function snapDrag(t: Timed, mode: DragMode, deltaMs: number): DragResult {
	if (mode === "move") {
		// Moving keeps the duration; a date-only side forces whole days for both.
		const unit: Unit = t.startTime.dateOnly || t.endTime?.dateOnly ? "days" : "hours";
		const steps = Math.round(deltaMs / UNIT_MS[unit]);
		return { start: shift(t.start, steps, unit), end: shift(t.end, steps, unit), startSteps: steps, endSteps: steps, unit };
	}
	if (mode === "start") {
		const unit = unitOf(t.startTime, t.startTime);
		let steps = Math.round(deltaMs / UNIT_MS[unit]);
		// Keep at least one unit of length.
		while (steps > 0 && shift(t.start, steps, unit) >= t.end) steps--;
		return { start: shift(t.start, steps, unit), end: t.end, startSteps: steps, endSteps: 0, unit };
	}
	const unit = unitOf(t.endTime, t.startTime);
	let steps = Math.round(deltaMs / UNIT_MS[unit]);
	while (steps < 0 && shift(t.end, steps, unit) <= t.start) steps++;
	return { start: t.start, end: shift(t.end, steps, unit), startSteps: 0, endSteps: steps, unit };
}

/**
 * Text to write for an exclusive end. Date-only ends are stored inclusive, so
 * step back a day. With no existing end value, follow the start's format.
 */
export function formatEnd(endMs: number, endTime: ParsedTime | null, startTime: ParsedTime): string {
	const t = endTime ?? startTime;
	const ms = t.dateOnly ? moment(endMs).subtract(1, "days").valueOf() : endMs;
	return formatParsed(ms, t);
}

/** Lane key for a raw frontmatter element, matching how buildLanes keys lanes. */
export function rawKey(raw: unknown): string {
	return cleanLabel(String(raw)).toLowerCase();
}

/**
 * Move a note from one lane to another by editing its group-by frontmatter.
 * Lists: replace the source lane's element with the target (or just drop it if
 * the target is already there). Plain values: replace. "(no value)" clears.
 * `targetRaw` is the exact value to write (e.g. "[[bob joe]]"); `preferList`
 * says whether to create a list when the property is currently empty.
 */
export function moveGroupValue(
	fm: Record<string, unknown>,
	name: string,
	fromKey: string,
	toKey: string,
	targetRaw: unknown,
	preferList: boolean,
): void {
	const current = fm[name];
	if (Array.isArray(current)) {
		const list = [...current];
		const from = list.findIndex((v) => rawKey(v) === fromKey);
		const hasTarget = toKey !== NO_VALUE_KEY && list.some((v) => rawKey(v) === toKey);
		if (toKey === NO_VALUE_KEY || hasTarget) {
			if (from >= 0) list.splice(from, 1);
		} else if (from >= 0) {
			list[from] = targetRaw;
		} else {
			list.push(targetRaw);
		}
		fm[name] = list;
		return;
	}
	if (toKey === NO_VALUE_KEY) {
		delete fm[name];
		return;
	}
	const empty = current === undefined || current === null || current === "";
	fm[name] = empty && preferList ? [targetRaw] : targetRaw;
}
