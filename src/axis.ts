import { moment } from "obsidian";

type Unit = "minute" | "hour" | "day" | "week" | "month" | "year";

interface TickStep {
	unit: Unit;
	step: number;
	/** Approximate length, used only to pick a step for the zoom level. */
	approxMs: number;
	format: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Finest to coarsest. Each minor step is paired with the major step drawn above it.
const STEPS: { minor: TickStep; major: TickStep }[] = [
	{ minor: { unit: "minute", step: 5, approxMs: 5 * MIN, format: "HH:mm" }, major: { unit: "hour", step: 1, approxMs: HOUR, format: "ddd D MMM, HH:mm" } },
	{ minor: { unit: "minute", step: 15, approxMs: 15 * MIN, format: "HH:mm" }, major: { unit: "hour", step: 1, approxMs: HOUR, format: "ddd D MMM, HH:mm" } },
	{ minor: { unit: "minute", step: 30, approxMs: 30 * MIN, format: "HH:mm" }, major: { unit: "day", step: 1, approxMs: DAY, format: "ddd D MMM YYYY" } },
	{ minor: { unit: "hour", step: 1, approxMs: HOUR, format: "HH:mm" }, major: { unit: "day", step: 1, approxMs: DAY, format: "ddd D MMM YYYY" } },
	{ minor: { unit: "hour", step: 3, approxMs: 3 * HOUR, format: "HH:mm" }, major: { unit: "day", step: 1, approxMs: DAY, format: "ddd D MMM YYYY" } },
	{ minor: { unit: "hour", step: 6, approxMs: 6 * HOUR, format: "HH:mm" }, major: { unit: "day", step: 1, approxMs: DAY, format: "ddd D MMM YYYY" } },
	{ minor: { unit: "day", step: 1, approxMs: DAY, format: "dd D" }, major: { unit: "month", step: 1, approxMs: 30 * DAY, format: "MMMM YYYY" } },
	{ minor: { unit: "week", step: 1, approxMs: 7 * DAY, format: "[W]w D" }, major: { unit: "month", step: 1, approxMs: 30 * DAY, format: "MMMM YYYY" } },
	{ minor: { unit: "month", step: 1, approxMs: 30 * DAY, format: "MMM" }, major: { unit: "year", step: 1, approxMs: 365 * DAY, format: "YYYY" } },
	{ minor: { unit: "month", step: 3, approxMs: 91 * DAY, format: "[Q]Q" }, major: { unit: "year", step: 1, approxMs: 365 * DAY, format: "YYYY" } },
	{ minor: { unit: "year", step: 1, approxMs: 365 * DAY, format: "YYYY" }, major: { unit: "year", step: 10, approxMs: 3650 * DAY, format: "YYYY" } },
	{ minor: { unit: "year", step: 5, approxMs: 5 * 365 * DAY, format: "YYYY" }, major: { unit: "year", step: 50, approxMs: 50 * 365 * DAY, format: "YYYY" } },
	{ minor: { unit: "year", step: 10, approxMs: 3650 * DAY, format: "YYYY" }, major: { unit: "year", step: 100, approxMs: 36500 * DAY, format: "YYYY" } },
	{ minor: { unit: "year", step: 25, approxMs: 25 * 365 * DAY, format: "YYYY" }, major: { unit: "year", step: 100, approxMs: 36500 * DAY, format: "YYYY" } },
	{ minor: { unit: "year", step: 50, approxMs: 50 * 365 * DAY, format: "YYYY" }, major: { unit: "year", step: 500, approxMs: 500 * 365 * DAY, format: "YYYY" } },
];

export interface Tick {
	ms: number;
	label: string;
}

export interface Ticks {
	minor: Tick[];
	major: Tick[];
}

/** Choose the finest step whose ticks are at least `minPx` apart. */
function pickStep(msPerPx: number, minPx: number) {
	for (const s of STEPS) {
		if (s.minor.approxMs / msPerPx >= minPx) return s;
	}
	return STEPS[STEPS.length - 1];
}

function alignedStart(ms: number, s: TickStep): moment.Moment {
	const unitForStart = s.unit === "week" ? "isoWeek" : s.unit;
	const m = moment(ms).startOf(unitForStart);
	// Align multi-step units so ticks don't shift while panning.
	if (s.step > 1) {
		const getter: Record<Unit, () => number> = {
			minute: () => m.minute(),
			hour: () => m.hour(),
			day: () => m.date() - 1,
			week: () => 0,
			month: () => m.month(),
			year: () => m.year(),
		};
		const offset = getter[s.unit]() % s.step;
		m.subtract(offset, s.unit);
	}
	return m;
}

function generate(from: number, to: number, s: TickStep): Tick[] {
	const out: Tick[] = [];
	const m = alignedStart(from, s);
	// Hard cap guards against pathological zoom levels.
	for (let i = 0; i < 2000 && m.valueOf() <= to; i++) {
		out.push({ ms: m.valueOf(), label: m.format(s.format) });
		m.add(s.step, s.unit);
	}
	return out;
}

export function computeTicks(from: number, to: number, msPerPx: number): Ticks {
	const s = pickStep(msPerPx, 48);
	return { minor: generate(from, to, s.minor), major: generate(from, to, s.major) };
}
