import { BasesView, Keymap, Menu, moment, Notice, setIcon, TFile } from "obsidian";
import type { BasesEntry, BasesPropertyId, HoverParent, HoverPopover, QueryController, Value } from "obsidian";
import { computeTicks } from "./axis";
import { assignColors, readProp, valueToText } from "./colors";
import { DAY_MS, declaredType, formatParsed, newValueFormat, parseRaw, readTime } from "./dates";
import type { ParsedTime } from "./dates";
import { formatEnd, moveGroupValue, rawKey, shiftParsed, snapDrag } from "./drag";
import type { DragMode, DragResult } from "./drag";
import { addGroup, ALL_KEY, buildLanes, cleanLabel, getNativeGroupBy, NO_VALUE_KEY } from "./layout";
import type { GroupBy, Lane, LaneItem, Timed } from "./layout";
import type BasesLanesPlugin from "./main";
import { describeResult, errorText, makeNote } from "./metrics";
import type { MetricContext, MetricNote, MetricResult } from "./metrics";

export const VIEW_TYPE = "lanes-timeline";

const ITEM_HEIGHT = 24;
const PROP_LINE_HEIGHT = 18;
const ITEM_GAP = 3;
const LANE_PAD = 4;
const MIN_ITEM_PX = 8;
// Below this width a bar is "narrow": no title, no resize handles (a press always moves it).
const NARROW_PX = 24;
// A save still running after this long gets a visible "not saved yet" notice.
const SLOW_SAVE_MS = 3000;
// Automatic retries for a failed save (ms to wait before each), to ride out short drops.
const RETRY_DELAYS_MS = [2000, 5000, 10000];

/**
 * What a save changed, so a retry can tell whether an earlier attempt that
 * reported failure actually landed (common on flaky network drives) and must not
 * be applied twice.
 */
interface SaveMemo {
	fields?: string[];
	beforeValues?: Record<string, unknown>;
	before?: string;
	after?: Record<string, unknown>;
	afterKey?: string;
}
const DEFAULT_LABEL_WIDTH = 160;
const MIN_LABEL_WIDTH = 60;
const MAX_LABEL_WIDTH = 600;
// Zoom limits: one pixel per second up to one pixel per ~1.5 months.
const MIN_MS_PER_PX = 1000;
const MAX_MS_PER_PX = (365 * DAY_MS) / 8;
// Pointer travel before a press on a bar becomes a drag instead of a click.
const DRAG_THRESHOLD_PX = 4;

interface RenderedItem {
	item: LaneItem;
	el: HTMLElement;
	labelEl: HTMLElement;
	/** Layout the element was last written with, to skip unchanged writes. */
	placed?: string;
	pad?: string;
}

/**
 * A lane's DOM skeleton plus an index for finding visible items. Item elements
 * are only built when they first scroll into view, and detached when they leave.
 */
interface LaneRender {
	lane: Lane;
	el: HTMLElement;
	trackEl: HTMLElement;
	/** Holds the lane's bars; shifted with a transform when panning. */
	canvasEl: HTMLElement;
	/** Items sorted by start, for binary search on the visible range. */
	sorted: LaneItem[];
	/** Longest item in the lane: bounds how far back a visible item can start. */
	maxDuration: number;
	/** This copy's item elements: a row shown in several groups has one set per copy. */
	items: Map<LaneItem, RenderedItem>;
	/** Cached layout (relative to the lanes container); refreshed when dirty. */
	top: number;
	height: number;
	/** Row metric cell, and the inputs it was last computed for. */
	metricEl: HTMLElement;
	metricKey: string;
}

/** Delay after the last pan, zoom or scroll before row metrics are recomputed. */
const METRIC_SETTLE_MS = 200;

const NO_GROUP_KEY = "\u0000nogroup";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface Section {
	/** Section name; null for rows without one. */
	name: string | null;
	lanes: Lane[];
}

/**
 * Split lanes into sections, sorted by name; rows without a group go
 * last. A row with several groups appears in each of their sections.
 */
function toSections(lanes: Lane[], descending: boolean): Section[] {
	if (!lanes.some((l) => l.groups.length > 0)) return [{ name: null, lanes }];
	const byName = new Map<string | null, Lane[]>();
	for (const lane of lanes) {
		for (const name of lane.groups.length > 0 ? lane.groups : [null]) {
			const list = byName.get(name) ?? [];
			list.push(lane);
			byName.set(name, list);
		}
	}
	const dir = descending ? -1 : 1;
	return [...byName.entries()]
		.map(([name, list]) => ({ name, lanes: list }))
		.sort((a, b) => (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || dir * collator.compare(a.name ?? "", b.name ?? ""));
}

interface Span {
	start: number;
	end: number;
}

/** A write to one note, run through the pending/retry/failure machinery. */
interface SaveJob {
	file: TFile;
	/** How the note's bars are drawn until the save settles (null: unchanged). */
	span: Span | null;
	/** One attempt. Must be safe to repeat after a failure that may have landed. */
	attempt: () => Promise<void>;
	onSaved?: () => void;
}

type UndoEntry =
	| { kind: "edit"; file: TFile; label: string; fields: string[]; before: Record<string, unknown>; afterKey: string }
	| { kind: "create"; file: TFile; label: string };

const UNDO_LIMIT = 50;

/** Margin around the viewport where items are kept attached, so fast scrolls don't flash. */
const OVERSCAN_PX = 300;

interface DragPreview {
	el: HTMLElement;
	/** Where the dragged bar is drawn: follows the pointer, unsnapped. */
	live: DragResult;
	/** Where it will land: snapped, shown as a dashed outline. */
	snapped: DragResult;
	origin: DragResult;
	ghostEl: HTMLElement | null;
	dropEl: HTMLElement | null;
}

/** Frontmatter names this view can write back to (only `note.*` properties). */
interface Writable {
	start: string | null;
	end: string | null;
	group: string | null;
}

function noteName(prop: BasesPropertyId | null | undefined): string | null {
	const s = prop ? String(prop) : "";
	return s.startsWith("note.") ? s.slice("note.".length) : null;
}

export class LanesView extends BasesView implements HoverParent {
	type = VIEW_TYPE;
	hoverPopover: HoverPopover | null = null;

	private rootEl: HTMLElement;
	private axisEl: HTMLElement;
	private axisMajorEl: HTMLElement;
	private axisMinorEl: HTMLElement;
	private bodyEl: HTMLElement;
	private lanesEl: HTMLElement;
	private gridEl: HTMLElement;
	private todayEl: HTMLElement;
	private emptyEl: HTMLElement;
	private resizeEl: HTMLElement;
	private labelWidth = DEFAULT_LABEL_WIDTH;

	private laneRenders: LaneRender[] = [];
	private laneLayoutDirty = true;
	/**
	 * Bars are laid out relative to this origin at this scale. Panning only moves
	 * each lane's canvas (a transform, no relayout); zooming re-bases the origin.
	 */
	private originMs = 0;
	private originScale = 0;
	private layoutGen = 0;
	/**
	 * Time window bars are clipped to (one screen-width either side of the view).
	 * A weeks-long bar at minute zoom would otherwise be hundreds of thousands of px
	 * wide, and painting that stalls every frame while dragging or panning.
	 */
	private clipFrom = 0;
	private clipTo = 0;
	private clipGen = -1;
	/** True during a ctrl+wheel gesture: canvases are scaled instead of re-laid out. */
	private zooming = false;
	private zoomSettleTimer = 0;
	/** Item elements currently in the DOM. */
	private attached = new Set<RenderedItem>();
	private renderCtx: { colors: Map<string, string>; props: BasesPropertyId[]; itemHeight: number } | null = null;
	private lastLanes: Lane[] = [];
	private groupDescending = false;
	/** Collapsed sections, persisted in the view config. */
	private collapsed = new Set<string>();
	private writable: Writable = { start: null, end: null, group: null };
	private titleProp: BasesPropertyId | null = null;
	private tipEl: HTMLElement;
	/** Live position of the bar being dragged, so re-positioning doesn't undo it. */
	private dragPreview: DragPreview | null = null;
	private suppressClick = false;
	/**
	 * A bar is pressed or being dragged. Re-rendering now would destroy it mid-drag
	 * (and lose the drop), so data updates wait until the pointer is released.
	 */
	private pointerBusy = false;
	/**
	 * Saves in flight, by note path. Until a save settles every copy of the note is
	 * drawn at its new time (striped as "saving"), so a slow or dead network drive
	 * never shows an unsaved edit as if it were saved, nor silently drops one.
	 */
	private pending = new Map<string, { span: Span | null; since: number; token: number; failed?: boolean }>();
	/** Most recent last. Edits are undone by restoring the fields they changed. */
	private undoStack: UndoEntry[] = [];
	/** Saves to the same note run strictly in order. */
	private saveChain = new Map<string, Promise<void>>();
	private saveToken = 0;
	private deferredUpdate = false;
	/** Left edge of the visible range, in ms since epoch. */
	private viewStart = 0;
	private msPerPx = DAY_MS / 40;
	private hasViewport = false;
	private frame = 0;

	/** Bumped when lanes are rebuilt or the script changes: invalidates metric cells. */
	private metricGen = 0;
	private metricTimer = 0;
	private headerMetrics: { section: Section; el: HTMLElement; key: string }[] = [];
	private metricNotes = new WeakMap<Timed, MetricNote>();
	private metricSlowWarned = false;

	constructor(controller: QueryController, containerEl: HTMLElement, private plugin: BasesLanesPlugin) {
		super(controller);
		this.rootEl = containerEl.createDiv({ cls: "bl-root" });

		const header = this.rootEl.createDiv({ cls: "bl-header" });
		header.createDiv({ cls: "bl-corner" });
		this.axisEl = header.createDiv({ cls: "bl-axis" });
		this.axisMajorEl = this.axisEl.createDiv({ cls: "bl-axis-major" });
		this.axisMinorEl = this.axisEl.createDiv({ cls: "bl-axis-minor" });

		this.bodyEl = this.rootEl.createDiv({ cls: "bl-body" });
		this.lanesEl = this.bodyEl.createDiv({ cls: "bl-lanes" });
		this.gridEl = this.lanesEl.createDiv({ cls: "bl-grid" });
		this.todayEl = this.gridEl.createDiv({ cls: "bl-today" });
		this.emptyEl = this.rootEl.createDiv({ cls: "bl-empty" });
		this.resizeEl = this.rootEl.createDiv({ cls: "bl-label-resize" });
		this.resizeEl.setAttr("aria-label", "Drag to resize, double-click to fit");
		this.tipEl = this.rootEl.createDiv({ cls: "bl-drag-tip" });
		this.tipEl.hide();
	}

	onload(): void {
		this.registerDomEvent(this.rootEl, "wheel", (e) => this.onWheel(e), { passive: false });
		this.registerDomEvent(this.bodyEl, "pointerdown", (e) => this.onPointerDown(e));
		this.registerDomEvent(this.resizeEl, "pointerdown", (e) => this.onResizeStart(e));
		this.registerDomEvent(this.resizeEl, "dblclick", () => this.fitLabelWidth());
		this.registerDomEvent(window, "keydown", (e) => this.onUndoKey(e), { capture: true });
		this.installNewItemDefaults();
		this.registerDomEvent(this.bodyEl, "scroll", () => this.schedulePosition());
		const ro = new ResizeObserver(() => this.schedulePosition());
		ro.observe(this.axisEl);
		ro.observe(this.bodyEl);
		this.register(() => ro.disconnect());
		this.register(() => cancelAnimationFrame(this.frame));
		this.register(() => window.clearTimeout(this.zoomSettleTimer));
		this.plugin.views.add(this);
		this.register(() => {
			this.plugin.views.delete(this);
			window.clearTimeout(this.metricTimer);
		});
	}

	onDataUpdated(): void {
		if (this.pointerBusy) {
			this.deferredUpdate = true;
			return;
		}
		const saved = Number(this.config.get("labelWidth"));
		this.setLabelWidth(saved > 0 ? saved : DEFAULT_LABEL_WIDTH);

		const startProp = this.config.getAsPropertyId("start");
		const endProp = this.config.getAsPropertyId("end");

		if (!startProp) {
			this.showEmpty("Choose a start property in the view options.");
			return;
		}

		const groupBy: GroupBy | null = getNativeGroupBy(this.config);
		this.writable = { start: noteName(startProp), end: noteName(endProp), group: noteName(groupBy?.property) };

		this.titleProp = this.config.getAsPropertyId("title");
		const timeOf = (entry: BasesEntry): Timed | null => this.timeOf(entry, startProp, endProp);
		// Avoid groupedData when the group-by is known: see EntrySource.
		const source = groupBy
			? [{ key: null, entries: this.data.data }]
			: this.data.groupedData.map((g) => ({ key: g.hasKey() ? (g.key ?? null) : null, entries: g.entries }));
		const lanes = buildLanes(source, groupBy, timeOf, this.config.getAsPropertyId("sections"));

		if (lanes.length === 0) {
			this.showEmpty("No notes with a start date.");
			return;
		}
		this.emptyEl.hide();
		this.fillGroupsFromLinkedNotes(lanes);
		const savedCollapsed = this.config.get("collapsedGroups");
		this.collapsed = new Set(Array.isArray(savedCollapsed) ? savedCollapsed.map(String) : []);
		this.groupDescending = !!groupBy?.descending;
		this.lastLanes = lanes;
		this.renderLanes(lanes);

		if (!this.hasViewport) this.showToday();
		// Position now rather than next frame: freshly built bars would otherwise sit
		// unplaced if that frame is skipped (seen when switching views).
		this.position();
	}

	private timeOf(entry: BasesEntry, startProp: BasesPropertyId, endProp: BasesPropertyId | null): Timed | null {
		const s = readTime(this.app, entry, startProp);
		if (!s) return null;
		const e = endProp ? readTime(this.app, entry, endProp) : null;
		let start = s.ms;
		// Date-only ends are inclusive: a task ending 2026-10-08 covers that whole day.
		let end = e ? e.ms + (e.dateOnly ? DAY_MS : 0) : s.ms + (s.dateOnly ? DAY_MS : 0);
		if (end < start) [start, end] = [end, start];
		return { entry, start, end, startTime: s, endTime: e };
	}

	private clearLanes(): void {
		this.lanesEl.querySelectorAll(".bl-lane, .bl-group-header").forEach((el) => el.remove());
		this.laneRenders = [];
		this.headerMetrics = [];
		this.attached.clear();
		this.dragPreview = null;
		this.laneLayoutDirty = true;
		this.originScale = 0;
	}

	private showEmpty(message: string): void {
		this.clearLanes();
		this.emptyEl.setText(message);
		this.emptyEl.show();
	}

	/** Build lane skeletons only; items are created on demand in position(). */
	/**
	 * When the sections option is a note property, rows that got no section from
	 * their notes fall back to the note the row links to: with `department`, a
	 * person row reads `department` from that person's note.
	 */
	private fillGroupsFromLinkedNotes(lanes: Lane[]): void {
		const name = noteName(this.config.getAsPropertyId("sections"));
		if (!name) return;
		const { metadataCache } = this.app;
		for (const lane of lanes) {
			if (lane.groups.length > 0 || lane.key === ALL_KEY || lane.key === NO_VALUE_KEY) continue;
			const file = metadataCache.getFirstLinkpathDest(lane.label, "");
			const raw: unknown = file ? metadataCache.getFileCache(file)?.frontmatter?.[name] : undefined;
			for (const value of Array.isArray(raw) ? raw : [raw]) {
				if (value !== undefined && value !== null && String(value).trim() !== "") addGroup(lane, cleanLabel(String(value)));
			}
		}
	}

	private toggleGroup(key: string): void {
		if (this.collapsed.has(key)) this.collapsed.delete(key);
		else this.collapsed.add(key);
		this.config.set("collapsedGroups", [...this.collapsed]);
		this.renderLanes(this.lastLanes);
		this.position();
	}

	private renderGroupHeader(section: Section, collapsed: boolean, key: string): void {
		const header = this.lanesEl.createDiv({ cls: "bl-group-header" });
		header.toggleClass("is-collapsed", collapsed);
		const label = header.createDiv({ cls: "bl-group-label" });
		setIcon(label.createSpan({ cls: "bl-group-chevron" }), "chevron-down");
		label.createSpan({ cls: "bl-group-name", text: section.name ?? "(no group)" });
		label.createSpan({ cls: "bl-group-count", text: String(section.lanes.length) });
		this.headerMetrics.push({ section, el: label.createSpan({ cls: "bl-lane-metric" }), key: "" });
		header.createDiv({ cls: "bl-group-track" });
		header.setAttr("aria-expanded", String(!collapsed));
		header.addEventListener("click", () => this.toggleGroup(key));
	}

	private renderLanes(lanes: Lane[]): void {
		this.clearLanes();
		this.lanesEl.querySelectorAll(".bl-group-header").forEach((el) => el.remove());

		// Properties checked in the Properties menu, one line each under the title.
		// The file name is already the title, so it isn't repeated.
		const props = this.config.getOrder().filter((p) => p !== "file.name" && p !== "file.basename");
		const itemHeight = ITEM_HEIGHT + props.length * PROP_LINE_HEIGHT;
		// Keyed by path, so a note rendered in several lanes gets the same color in each.
		const colors = assignColors(this.data.data, this.config.getAsPropertyId("color"), this.config.getAsPropertyId("colorBucket"));
		this.renderCtx = { colors, props, itemHeight };

		this.metricGen++;
		const sections = toSections(lanes, this.groupDescending);
		const grouped = sections.length > 1 || sections[0]?.name !== null;
		for (const section of sections) {
			const key = section.name ?? NO_GROUP_KEY;
			const collapsed = grouped && this.collapsed.has(key);
			if (grouped) this.renderGroupHeader(section, collapsed, key);
			if (!collapsed) for (const lane of section.lanes) this.renderLane(lane, itemHeight);
		}
	}

	private renderLane(lane: Lane, itemHeight: number): void {
		const laneEl = this.lanesEl.createDiv({ cls: "bl-lane" });
		const labelEl = laneEl.createDiv({ cls: "bl-lane-label" });
		const textEl = labelEl.createSpan({ cls: "bl-lane-label-text", text: lane.label });
		if (lane.link) this.linkLabel(labelEl, textEl, lane.link);
		labelEl.setAttr("title", lane.label);
		const metricEl = labelEl.createSpan({ cls: "bl-lane-metric" });
		const trackEl = laneEl.createDiv({ cls: "bl-lane-track" });
		const canvasEl = trackEl.createDiv({ cls: "bl-lane-canvas" });
		trackEl.style.height = `${lane.trackCount * (itemHeight + ITEM_GAP) - ITEM_GAP + LANE_PAD * 2}px`;

		const sorted = [...lane.items].sort((a, b) => a.start - b.start);
		let maxDuration = 0;
		for (const item of sorted) maxDuration = Math.max(maxDuration, item.end - item.start);
		this.laneRenders.push({ lane, el: laneEl, trackEl, canvasEl, sorted, maxDuration, items: new Map(), top: 0, height: 0, metricEl, metricKey: "" });
	}

	private materialize(lr: LaneRender, item: LaneItem): RenderedItem {
		let r = lr.items.get(item);
		if (r) return r;
		const { colors, props, itemHeight } = this.renderCtx!;
		const el = createDiv({ cls: "bl-item" });
		el.style.top = `${LANE_PAD + item.track * (itemHeight + ITEM_GAP)}px`;
		el.style.height = `${itemHeight}px`;
		el.dataset.id = item.id;
		const color = colors.get(item.entry.file.path);
		if (color) el.style.setProperty("--bl-item-color", color);
		const labelEl = el.createDiv({ cls: "bl-item-label" });
		labelEl.createDiv({ cls: "bl-item-title", text: this.titleOf(item.entry) });
		for (const prop of props) this.renderProp(labelEl, item.entry, prop);
		if (this.writable.start) el.createDiv({ cls: "bl-handle bl-handle-start" });
		if (this.writable.end) el.createDiv({ cls: "bl-handle bl-handle-end" });
		this.bindItem(el, item);
		r = { item, el, labelEl };
		lr.items.set(item, r);
		return r;
	}

	/** One property line. Empty values keep their line so items stay the same height. */
	private renderProp(parent: HTMLElement, entry: BasesEntry, prop: BasesPropertyId): void {
		const lineEl = parent.createDiv({ cls: "bl-item-prop" });
		lineEl.setAttr("title", this.config.getDisplayName(prop));
		let value: Value | null = null;
		try {
			value = entry.getValue(prop);
		} catch {
			value = null;
		}
		if (!value || !value.isTruthy()) return;
		try {
			// Renders the way Bases does: links, dates, tags, lists.
			value.renderTo(lineEl, this.app.renderContext);
			// Dates render as (disabled) inputs meant for the table; plain text fits a bar better.
			if (lineEl.querySelector("input, select, textarea")) {
				lineEl.empty();
				const time = parseRaw(value.toString());
				lineEl.setText(time ? fmtTime(time) : value.toString());
			}
		} catch {
			lineEl.setText(value.toString());
		}
	}

	/**
	 * The standard note context menu. Most items come from core and community
	 * plugins via the "file-menu" event (the same one the tab header's "more
	 * options" menu fires); the rest are items the file explorer adds itself.
	 */
	private showFileMenu(evt: MouseEvent, file: TFile, item: LaneItem): void {
		const { workspace, vault, fileManager } = this.app;
		const menu = new Menu();

		menu.addItem((i) =>
			i.setSection("view").setTitle("Zoom to event").setIcon("lucide-zoom-in")
				.onClick(() => this.zoomTo(item.start, item.end)));

		menu.addItem((i) =>
			i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus")
				.onClick(() => void workspace.getLeaf("tab").openFile(file)));
		menu.addItem((i) =>
			i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical")
				.onClick(() => void workspace.getLeaf("split").openFile(file)));

		const internal = { vault, fileManager } as unknown as {
			vault: { getAvailablePath?: (base: string, ext: string) => string };
			fileManager: { promptForFileRename?: (f: TFile) => void };
		};
		const getAvailablePath = internal.vault.getAvailablePath?.bind(vault);
		if (getAvailablePath) {
			menu.addItem((i) =>
				i.setSection("action").setTitle("Make a copy").setIcon("lucide-files")
					.onClick(() => {
						const base = file.parent && file.parent.path !== "/" ? `${file.parent.path}/${file.basename}` : file.basename;
						void vault.copy(file, getAvailablePath(base, file.extension));
					}));
		}

		workspace.trigger("file-menu", menu, file, "more-options");

		const promptForFileRename = internal.fileManager.promptForFileRename?.bind(fileManager);
		if (promptForFileRename) {
			menu.addItem((i) =>
				i.setSection("danger").setTitle("Rename...").setIcon("lucide-pencil")
					.onClick(() => promptForFileRename(file)));
		}
		menu.addItem((i) =>
			i.setSection("danger").setTitle("Delete").setIcon("lucide-trash-2").setWarning(true)
				.onClick(() => void fileManager.promptForDeletion(file)));

		menu.showAtMouseEvent(evt);
	}

	private bindItem(el: HTMLElement, item: LaneItem): void {
		const path = item.entry.file.path;
		el.addEventListener("pointerdown", (evt) => this.onItemPointerDown(evt, el, item));
		el.addEventListener("click", (evt) => {
			evt.preventDefault();
			if (this.suppressClick) return;
			// A link inside a property value opens that note instead of this one.
			const link = (evt.target as HTMLElement).closest<HTMLElement>(".internal-link");
			const href = link?.dataset.href;
			if (href) {
				void this.app.workspace.openLinkText(href, path, Keymap.isModEvent(evt));
				return;
			}
			void this.app.workspace.openLinkText(path, "", Keymap.isModEvent(evt));
		});
		el.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.tipEl.hide();
			this.showFileMenu(evt, item.entry.file, item);
		});
		el.addEventListener("mouseover", (evt) => {
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: "bases",
				hoverParent: this,
				targetEl: el,
				linktext: path,
			});
		});
		// Highlight every copy of the same note across rows.
		el.addEventListener("mouseenter", (evt) => {
			this.setHighlight(path, true);
			if (!this.dragPreview) this.showHoverCard(evt, item);
		});
		el.addEventListener("mousemove", (evt) => {
			if (!this.dragPreview) this.moveTip(evt);
		});
		el.addEventListener("mouseleave", () => {
			this.setHighlight(path, false);
			if (!this.dragPreview) this.tipEl.hide();
		});
	}

	private setHighlight(path: string, on: boolean): void {
		for (const r of this.attached) {
			if (r.item.entry.file.path === path) r.el.toggleClass("is-linked-hover", on);
		}
	}

	// ---- Drag to move / resize -------------------------------------------

	private onItemPointerDown(evt: PointerEvent, el: HTMLElement, item: LaneItem): void {
		if (evt.button !== 0) return;
		const target = evt.target as HTMLElement;
		const mode: DragMode = target.closest(".bl-handle-start") ? "start" : target.closest(".bl-handle-end") ? "end" : "move";
		const w = this.writable;
		// Moving in time needs every existing date side to be writable.
		const canShift = mode === "start" ? !!w.start
			: mode === "end" ? !!w.end
			: !!w.start && (!item.timed.endTime || !!w.end);
		const canChangeRow = mode === "move" && !!w.group && item.laneKey !== ALL_KEY;
		if (!canShift && !canChangeRow) return;

		// If an earlier save of this note is still pending, drag from where the bar is shown.
		const pendingSpan = this.pending.get(item.entry.file.path)?.span;
		const base: LaneItem = pendingSpan
			? { ...item, start: pendingSpan.start, end: pendingSpan.end, timed: { ...item.timed, start: pendingSpan.start, end: pendingSpan.end } }
			: item;

		this.pointerBusy = true;
		const startX = evt.clientX;
		const startY = evt.clientY;
		let dragging = false;
		let result: DragResult = { start: base.start, end: base.end };
		let targetKey = item.laneKey;
		// The copy of the row this bar was grabbed in (a row can be shown in several groups).
		const sourceLr = this.laneRenders.find((lr) => lr.canvasEl.contains(el)) ?? null;
		tryCapture(el, evt.pointerId, true);

		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			if (!dragging) {
				if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
				dragging = true;
				el.addClass("is-dragging");
				this.rootEl.addClass(mode === "move" ? "is-dragging-item" : "is-resizing-item");
				// Ghost marks where the bar started; the drop outline shows where it will land.
				const ghostEl = el.parentElement!.createDiv({ cls: "bl-ghost" });
				const dropEl = el.parentElement!.createDiv({ cls: "bl-drop-preview" });
				for (const g of [ghostEl, dropEl]) {
					g.style.top = el.style.top;
					g.style.height = el.style.height;
				}
				this.dragPreview = { el, live: result, snapped: result, origin: { start: base.start, end: base.end }, ghostEl, dropEl };
			}
			const preview = this.dragPreview!;
			if (canShift) {
				result = snapDrag(base.timed, mode, dx * this.msPerPx);
				preview.snapped = result;
				preview.live = liveDrag(base, mode, dx * this.msPerPx);
			}

			if (canChangeRow) {
				const targetLr = this.laneAt(ev.clientY) ?? sourceLr;
				targetKey = targetLr?.lane.key ?? item.laneKey;
				el.style.transform = `translateY(${dy}px)`;
				for (const lr of this.laneRenders) {
					lr.el.toggleClass("is-drop-target", lr === targetLr && targetKey !== item.laneKey);
				}
				// Land in the target row's first sub-row; in the same row, keep the bar's own.
				const track = targetLr?.canvasEl;
				if (preview.dropEl && track && preview.dropEl.parentElement !== track) {
					track.appendChild(preview.dropEl);
					preview.dropEl.style.top = targetKey === item.laneKey ? el.style.top : `${LANE_PAD}px`;
				}
			}
			this.showTip(ev, result, base, targetKey);
			this.schedulePosition();
		};
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape") return;
			ev.preventDefault();
			ev.stopPropagation();
			finish(null, true);
		};
		const up = (ev: PointerEvent) => {
			// Dropping outside the view (or the OS cancelling the pointer) abandons the drag.
			const r = this.rootEl.getBoundingClientRect();
			const outside = ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
			finish(ev, ev.type === "pointercancel" || outside);
		};
		const finish = (ev: PointerEvent | null, cancel: boolean) => {
			if (ev) tryCapture(el, ev.pointerId, false);
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
			window.removeEventListener("keydown", onKey, true);
			this.pointerBusy = false;
			// Catch up on data that arrived during the drag (after this drag's own commit is sent).
			if (this.deferredUpdate) window.setTimeout(() => this.flushDeferredUpdate(), 0);
			if (!dragging) return;
			dragging = false;

			// The click that follows a drag must not open the note. After an Escape the
			// button is still down, so hold the suppression until it's released.
			this.suppressClick = true;
			const release = () => window.setTimeout(() => (this.suppressClick = false), 0);
			if (ev) release();
			else window.addEventListener("pointerup", release, { once: true, capture: true });
			el.removeClass("is-dragging");
			el.style.transform = "";
			this.dragPreview?.ghostEl?.remove();
			this.dragPreview?.dropEl?.remove();
			this.dragPreview = null;
			this.rootEl.removeClass("is-dragging-item", "is-resizing-item");
			this.laneRenders.forEach((lr) => lr.el.removeClass("is-drop-target"));
			this.tipEl.hide();

			const unchanged = result.start === base.start && result.end === base.end && targetKey === item.laneKey;
			if (cancel || unchanged) {
				this.schedulePosition();
				return;
			}
			this.queueSave(item, result, targetKey);
			this.schedulePosition();
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
		window.addEventListener("keydown", onKey, true);
	}

	private flushDeferredUpdate(): void {
		if (this.pointerBusy || !this.deferredUpdate) return;
		this.deferredUpdate = false;
		this.onDataUpdated();
	}

	// ---- Toolbar "+ New" defaults --------------------------------------

	/**
	 * Bases' "+ New" can't pick a start date (a "start is not empty" filter just
	 * makes an empty start, and the note is filtered out). While this view is the
	 * active one, give new notes the date at the centre of the view. Wraps Bases'
	 * internal new-item component; if that changes, "+ New" is simply left as is.
	 */
	private installNewItemDefaults(): void {
		type Process = (fm: Record<string, unknown>) => void;
		const qc = (this as unknown as { queryController?: { view?: unknown; newItemMenu?: { open?: (name?: unknown, process?: Process) => Promise<void> } } }).queryController;
		const menu = qc?.newItemMenu;
		if (!qc || !menu || typeof menu.open !== "function") return;
		const original = menu.open;
		const wrapped = (name?: unknown, process?: Process) => {
			if (qc.view !== this) return original.call(menu, name, process);
			return original.call(menu, name, (fm: Record<string, unknown>) => {
				this.fillNewItemDefaults(fm);
				process?.(fm);
			});
		};
		menu.open = wrapped;
		this.register(() => {
			if (menu.open === wrapped) menu.open = original;
		});
	}

	private fillNewItemDefaults(fm: Record<string, unknown>): void {
		const name = this.writable.start;
		if (!name) return;
		const current = fm[name];
		if (current !== undefined && current !== null && String(current).trim() !== "") return;
		const sample = this.lastLanes.find((l) => l.items.length)?.items[0]?.timed.startTime ?? null;
		const format = newValueFormat(declaredType(this.app, this.config.getAsPropertyId("start")), sample);
		const centre = this.viewStart + (this.trackWidth * this.msPerPx) / 2;
		const ms = moment(centre).startOf(format.dateOnly ? "day" : "hour").valueOf();
		fm[name] = formatParsed(ms, format);
	}

	// ---- Title, row links ----------------------------------------------

	/** Bar title: the view's title property or formula, else the file name. */
	private titleOf(entry: BasesEntry): string {
		const value = readProp(entry, this.titleProp);
		const text = value ? valueToText(value) : "";
		return text.length > 0 ? text : entry.file.basename;
	}

	/** Make a row name behave like a link to the note it names (click, ctrl+click, hover preview). */
	private linkLabel(labelEl: HTMLElement, textEl: HTMLElement, link: string): void {
		textEl.addClass("bl-lane-link");
		labelEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			void this.app.workspace.openLinkText(link, "", Keymap.isModEvent(evt));
		});
		labelEl.addEventListener("mouseover", (evt) => {
			this.app.workspace.trigger("hover-link", { event: evt, source: "bases", hoverParent: this, targetEl: textEl, linktext: link });
		});
	}

	// ---- Undo ----------------------------------------------------------

	private pushUndo(entry: UndoEntry): void {
		this.undoStack.push(entry);
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
	}

	/** Ctrl/Cmd+Z in this view (not while typing somewhere). */
	private onUndoKey(e: KeyboardEvent): void {
		if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
		if (!this.app.workspace.activeLeaf?.view.containerEl.contains(this.rootEl)) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")) return;
		e.preventDefault();
		e.stopPropagation();
		void this.undo();
	}

	private async undo(): Promise<void> {
		const entry = this.undoStack.pop();
		if (!entry) {
			new Notice("Nothing to undo.", 2000);
			return;
		}
		if (entry.kind === "create") {
			try {
				await this.app.fileManager.trashFile(entry.file);
				new Notice(`Undid creating “${entry.label}”.`, 3000);
			} catch (e) {
				new Notice(`Couldn't undo creating “${entry.label}”: ${e instanceof Error ? e.message : String(e)}`, 0);
			}
			return;
		}
		// Restore the fields the edit changed, unless the note changed again since.
		let conflict = false;
		const w = this.writable;
		const span = this.spanOf(entry.before[w.start ?? ""], w.end ? entry.before[w.end] : undefined);
		this.queueJob({
			file: entry.file,
			span,
			attempt: async () => {
				conflict = false;
				await this.app.fileManager.processFrontMatter(entry.file, (fm: Record<string, unknown>) => {
					const now = JSON.stringify(entry.fields.map((k) => fm[k] ?? null));
					const before = JSON.stringify(entry.fields.map((k) => entry.before[k] ?? null));
					if (now === before) return; // already undone (e.g. a retry that landed)
					if (now !== entry.afterKey) {
						conflict = true;
						return;
					}
					for (const k of entry.fields) {
						if (entry.before[k] === undefined) delete fm[k];
						else fm[k] = structuredClone(entry.before[k]);
					}
				});
			},
			onSaved: () => {
				if (conflict) new Notice(`Couldn't undo “${entry.label}”: it was changed again since.`, 5000);
				else new Notice(`Undid change to “${entry.label}”.`, 3000);
			},
		});
	}

	/** Draw-span for raw start/end values (date-only ends are inclusive), or null. */
	private spanOf(rawStart: unknown, rawEnd: unknown): Span | null {
		const s = parseRaw(rawStart);
		if (!s) return null;
		const e = parseRaw(rawEnd);
		const start = s.ms;
		const end = e ? e.ms + (e.dateOnly ? DAY_MS : 0) : s.ms + (s.dateOnly ? DAY_MS : 0);
		return end >= start ? { start, end } : { start: end, end: start };
	}

	// ---- Create by dragging on an empty row ------------------------------

	private onCreatePointerDown(evt: PointerEvent, lr: LaneRender): void {
		const w = this.writable;
		const startProp = this.config.getAsPropertyId("start");
		const endProp = this.config.getAsPropertyId("end");
		// Date vs date-and-time: the declared type, else what the row's notes use.
		const sample = lr.lane.items[0]?.timed.startTime ?? this.lastLanes.find((l) => l.items.length)?.items[0]?.timed.startTime ?? null;
		const startFmt = newValueFormat(declaredType(this.app, startProp), sample);
		const endFmt = newValueFormat(declaredType(this.app, endProp), startFmt);
		const unit = startFmt.dateOnly ? "day" : "hour";

		const ax = this.axisEl.getBoundingClientRect();
		const toMs = (clientX: number) => this.viewStart + (clientX - ax.left) * this.msPerPx;
		const from = toMs(evt.clientX);
		let span: Span = { start: 0, end: 0 };
		let dragging = false;
		const previewEl = lr.canvasEl.createDiv({ cls: "bl-create-preview" });
		previewEl.hide();
		const itemHeight = this.renderCtx?.itemHeight ?? ITEM_HEIGHT;
		previewEl.style.top = `${LANE_PAD}px`;
		previewEl.style.height = `${itemHeight}px`;
		this.pointerBusy = true;
		tryCapture(this.bodyEl, evt.pointerId, true);

		const move = (ev: PointerEvent) => {
			if (!dragging && Math.abs(ev.clientX - evt.clientX) < DRAG_THRESHOLD_PX) return;
			dragging = true;
			const a = Math.min(from, toMs(ev.clientX));
			const b = Math.max(from, toMs(ev.clientX));
			const start = moment(a).startOf(unit).valueOf();
			let end = moment(b).startOf(unit).add(1, unit).valueOf();
			if (end <= start) end = moment(start).add(1, unit).valueOf();
			span = { start, end };
			const { left, w: width } = this.clipGeometry(span);
			previewEl.style.left = `${left}px`;
			previewEl.style.width = `${width}px`;
			previewEl.show();
			const endShown = endFmt.dateOnly ? end - DAY_MS : end;
			const range = `${fmtTime({ ...startFmt, ms: start })} → ${fmtTime({ ...endFmt, ms: endShown })}`;
			const row = lr.lane.key === ALL_KEY ? "" : `\nin ${lr.lane.label}`;
			this.tipEl.setText(`New event\n${range}${row}`);
			this.tipEl.show();
			this.moveTip(ev);
		};
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape") return;
			ev.preventDefault();
			ev.stopPropagation();
			finish(null, true);
		};
		const up = (ev: PointerEvent) => {
			const r = this.rootEl.getBoundingClientRect();
			const outside = ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
			finish(ev, ev.type === "pointercancel" || outside);
		};
		const finish = (ev: PointerEvent | null, cancel: boolean) => {
			if (ev) tryCapture(this.bodyEl, ev.pointerId, false);
			this.bodyEl.removeEventListener("pointermove", move);
			this.bodyEl.removeEventListener("pointerup", up);
			this.bodyEl.removeEventListener("pointercancel", up);
			window.removeEventListener("keydown", onKey, true);
			previewEl.remove();
			this.tipEl.hide();
			this.pointerBusy = false;
			if (this.deferredUpdate) window.setTimeout(() => this.flushDeferredUpdate(), 0);
			if (!dragging || cancel || !w.start) return;
			void this.createEvent(lr.lane, span, startFmt, endFmt);
		};
		this.bodyEl.addEventListener("pointermove", move);
		this.bodyEl.addEventListener("pointerup", up);
		this.bodyEl.addEventListener("pointercancel", up);
		window.addEventListener("keydown", onKey, true);
	}

	/** New note via Bases' own "new note" flow (folder, filters, templates), pre-filled. */
	private async createEvent(lane: Lane, span: Span, startFmt: ParsedTime, endFmt: ParsedTime): Promise<void> {
		const w = this.writable;
		const group = w.group && lane.key !== ALL_KEY && lane.key !== NO_VALUE_KEY ? w.group : null;
		const target = group ? this.rawForLane(lane.key, group) : null;
		// Bases doesn't pass the new file to the callback (despite the type), so catch
		// it from the vault's create event while the note is being made.
		let created: TFile | null = null;
		const ref = this.app.vault.on("create", (file) => {
			if (!created && file instanceof TFile) created = file;
		});
		try {
			await this.createFileForView(undefined, (fm: Record<string, unknown>) => {
				if (w.start) fm[w.start] = formatParsed(span.start, startFmt);
				if (w.end) fm[w.end] = formatEnd(span.end, endFmt, startFmt);
				if (group && target && target.raw !== null) fm[group] = target.isList ? [target.raw] : target.raw;
			});
		} catch (e) {
			new Notice(`Couldn't create the event: ${e instanceof Error ? e.message : String(e)}`, 0);
			return;
		} finally {
			this.app.vault.offref(ref);
		}
		if (created) this.pushUndo({ kind: "create", file: created, label: (created as TFile).basename });
	}

	/** The rendered row copy under a screen y, if any. */
	private laneAt(clientY: number): LaneRender | null {
		for (const lr of this.laneRenders) {
			const r = lr.el.getBoundingClientRect();
			if (clientY >= r.top && clientY < r.bottom) return lr;
		}
		return null;
	}

	private laneByKey(key: string): Lane | undefined {
		return this.lastLanes.find((l) => l.key === key);
	}

	/** Instant hover card: what a bar is, even when it's too narrow to show its title. */
	private showHoverCard(evt: MouseEvent, item: LaneItem): void {
		const t = item.timed;
		const endTime = t.endTime ?? t.startTime;
		const endMs = endTime.dateOnly ? item.end - DAY_MS : item.end;
		const start = fmtTime({ ...t.startTime, ms: item.start });
		const range = endMs > item.start ? `${start} → ${fmtTime({ ...endTime, ms: endMs })}` : start;
		const lane = this.laneByKey(item.laneKey)?.label;
		const pending = this.pending.get(item.entry.file.path);
		const saving = !pending ? ""
			: pending.failed ? "\nNot saved: saving failed (see notice)"
			: `\nSaving… ${Math.round((Date.now() - pending.since) / 1000)}s (not saved yet)`;
		this.tipEl.setText(`${this.titleOf(item.entry)}\n${range}${lane ? `\n${lane}` : ""}${saving}`);
		this.tipEl.show();
		this.moveTip(evt);
	}

	private moveTip(evt: MouseEvent): void {
		const root = this.rootEl.getBoundingClientRect();
		this.tipEl.style.left = `${evt.clientX - root.left + 12}px`;
		this.tipEl.style.top = `${evt.clientY - root.top + 16}px`;
	}

	/** Fit a time span to the view with some margin. */
	private zoomTo(start: number, end: number): void {
		const span = Math.max(end - start, 60 * 60 * 1000);
		this.msPerPx = clamp((span * 1.5) / this.trackWidth, MIN_MS_PER_PX, MAX_MS_PER_PX);
		this.viewStart = start - span * 0.25;
		this.hasViewport = true;
		this.schedulePosition();
	}

	private showTip(ev: PointerEvent, result: DragResult, item: LaneItem, targetKey: string): void {
		const t = item.timed;
		const start = fmtTime({ ...t.startTime, ms: result.start });
		const endTime = t.endTime ?? t.startTime;
		// Show the end the way it's stored: date-only ends are inclusive.
		const endMs = endTime.dateOnly ? result.end - DAY_MS : result.end;
		let text = endMs > result.start ? `${start} → ${fmtTime({ ...endTime, ms: endMs })}` : start;
		if (targetKey !== item.laneKey) text += `\n→ ${this.laneByKey(targetKey)?.label ?? ""}`;
		this.tipEl.setText(text);
		this.tipEl.show();
		const root = this.rootEl.getBoundingClientRect();
		this.tipEl.style.left = `${ev.clientX - root.left + 12}px`;
		this.tipEl.style.top = `${ev.clientY - root.top + 16}px`;
	}

	/** Write a finished drag back to the note's frontmatter. */
	private async commitDrag(item: LaneItem, result: DragResult, targetKey: string, memo: SaveMemo): Promise<void> {
		const w = this.writable;
		const t = item.timed;
		const unit = result.unit ?? "days";
		const startSteps = result.startSteps ?? 0;
		const endSteps = result.endSteps ?? 0;
		const group = targetKey !== item.laneKey ? w.group : null;
		// The exact value to write for the target row, copied from a note already in it.
		const target = group ? this.rawForLane(targetKey, group) : null;

		// The fields this save touches, as a comparable snapshot.
		const fields = [w.start, w.end, group].filter((x): x is string => !!x);
		const snapshot = (fm: Record<string, unknown>) => JSON.stringify(fields.map((k) => fm[k] ?? null));

		// Errors propagate to queueSave, which reports them.
		await this.app.fileManager.processFrontMatter(item.entry.file, (fm: Record<string, unknown>) => {
			const now = snapshot(fm);
			if (memo.afterKey !== undefined) {
				// A retry. Already there: an earlier "failed" attempt landed, nothing to do.
				if (now === memo.afterKey) return;
				// Untouched since we first read it: write exactly what we meant to.
				if (now === memo.before) {
					for (const k of fields) {
						if (memo.after![k] === undefined) delete fm[k];
						else fm[k] = memo.after![k];
					}
					return;
				}
				// Someone else changed it meanwhile: re-apply the drag to what's there now.
			}
			memo.before = now;
			memo.fields = fields;
			memo.beforeValues = Object.fromEntries(fields.map((k) => [k, structuredClone(fm[k])]));
			// Apply the drag as steps to what the note says *now*: if an earlier drag's write
			// hasn't re-rendered yet, this builds on it instead of overwriting it.
			if ((startSteps || endSteps) && w.start) {
				let s = parseRaw(fm[w.start]) ?? t.startTime;
				let e = w.end ? parseRaw(fm[w.end]) : null;
				// A note whose end is before its start renders swapped; edit it that way and fix it.
				const swapped = !!e && e.ms < s.ms;
				if (swapped) [s, e] = [e!, s];
				if (startSteps || swapped) fm[w.start] = formatParsed(shiftParsed(s, startSteps, unit).ms, s);
				if (w.end && e && (endSteps || swapped)) {
					fm[w.end] = formatParsed(shiftParsed(e, endSteps, unit).ms, e);
				} else if (w.end && !e && endSteps && !startSteps) {
					// No end value yet: an end-resize creates one from the derived end.
					const derivedEnd = s.ms + (s.dateOnly ? DAY_MS : 0);
					const endType = declaredType(this.app, this.config.getAsPropertyId("end"));
					fm[w.end] = formatEnd(shiftParsed({ ...s, ms: derivedEnd }, endSteps, unit).ms, newValueFormat(endType, s), s);
				}
			}
			if (group && target) moveGroupValue(fm, group, item.laneKey, targetKey, target.raw, target.isList);
			memo.after = Object.fromEntries(fields.map((k) => [k, fm[k]]));
			memo.afterKey = snapshot(fm);
		});
	}

	/**
	 * Run a drag's save after any earlier save of the same note, showing it as
	 * pending meanwhile. A slow save gets a persistent notice; a failed one is
	 * retried a few times, then kept on screen (marked failed) with Retry / Discard,
	 * so a dead connection never silently loses or doubles an edit.
	 */
	private queueSave(item: LaneItem, result: DragResult, targetKey: string): void {
		const memo: SaveMemo = {};
		const file = item.entry.file;
		this.queueJob({
			file,
			span: result,
			attempt: () => this.commitDrag(item, result, targetKey, memo),
			onSaved: () => {
				if (memo.fields && memo.beforeValues && memo.afterKey !== undefined) {
					this.pushUndo({ kind: "edit", file, label: this.titleOf(item.entry), fields: memo.fields, before: memo.beforeValues, afterKey: memo.afterKey });
				}
			},
		});
	}

	private queueJob(job: SaveJob): void {
		const path = job.file.path;
		const name = job.file.basename;
		const token = ++this.saveToken;
		this.pending.set(path, { span: job.span, since: Date.now(), token });
		this.schedulePosition();

		const prev = this.saveChain.get(path) ?? Promise.resolve();
		const run = prev.then(async () => {
			let slowNotice: Notice | null = null;
			const slowTimer = window.setTimeout(() => {
				slowNotice = new Notice(
					`Saving “${name}” is taking a long time. The network drive may be unreachable. ` +
						"The change isn't saved yet and will be lost if Obsidian closes.",
					0,
				);
			}, SLOW_SAVE_MS);
			let error: unknown = null;
			for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
				if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
				// A newer save of this note supersedes this one's remaining retries.
				if (this.pending.get(path)?.token !== token) break;
				try {
					await job.attempt();
					error = null;
					break;
				} catch (e) {
					error = e;
					console.warn(`Bases Lanes: save attempt ${attempt + 1} failed for ${path}`, e);
				}
			}
			window.clearTimeout(slowTimer);
			(slowNotice as Notice | null)?.hide();

			const current = this.pending.get(path);
			if (error && current?.token === token) {
				current.failed = true;
				this.showSaveFailed(job, error);
			} else {
				if (!error) {
					if (slowNotice) new Notice(`Saved “${name}”.`, 4000);
					job.onSaved?.();
				}
				if (current?.token === token) this.pending.delete(path);
			}
			if (this.saveChain.get(path) === run) this.saveChain.delete(path);
			this.schedulePosition();
		});
		this.saveChain.set(path, run);
	}

	/** Persistent notice for a save that kept failing: retry once reconnected, or drop the edit. */
	private showSaveFailed(job: SaveJob, error: unknown): void {
		const path = job.file.path;
		const frag = createFragment((el) => {
			el.createDiv({
				text: `Couldn't save “${job.file.basename}”: ${error instanceof Error ? error.message : String(error)}. ` +
					"The change is not saved. Check your connection, then retry.",
			});
			const buttons = el.createDiv({ cls: "bl-notice-buttons" });
			buttons.createEl("button", { text: "Retry", cls: "mod-cta" }).addEventListener("click", (e) => {
				e.stopPropagation();
				notice.hide();
				this.queueJob(job);
			});
			buttons.createEl("button", { text: "Discard change" }).addEventListener("click", (e) => {
				e.stopPropagation();
				notice.hide();
				if (this.pending.get(path)?.failed) this.pending.delete(path);
				this.schedulePosition();
			});
		});
		const notice = new Notice(frag, 0);
	}

	/** How the target row's value is written in other notes (e.g. "[[bob joe]]"), and whether as a list. */
	private rawForLane(key: string, name: string): { raw: unknown; isList: boolean } {
		const lane = this.laneByKey(key);
		if (key === NO_VALUE_KEY || !lane) return { raw: null, isList: false };
		// Prefer a form without an alias ("[[alpha]]" over "[[alpha|Alpha Team]]").
		let fallback: { raw: unknown; isList: boolean } | null = null;
		for (const item of lane.items) {
			const value: unknown = this.app.metadataCache.getFileCache(item.entry.file)?.frontmatter?.[name];
			const isList = Array.isArray(value);
			const match: unknown = isList
				? (value as unknown[]).find((v) => rawKey(v) === key)
				: value !== undefined && value !== null && rawKey(value) === key ? value : undefined;
			if (match === undefined) continue;
			if (!String(match).includes("|")) return { raw: match, isList };
			fallback ??= { raw: match, isList };
		}
		return fallback ?? { raw: lane.label, isList: false };
	}

	// ---- Label column -------------------------------------------------

	private setLabelWidth(width: number): void {
		this.labelWidth = Math.round(clamp(width, MIN_LABEL_WIDTH, MAX_LABEL_WIDTH));
		this.rootEl.style.setProperty("--bl-label-width", `${this.labelWidth}px`);
	}

	private onResizeStart(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = this.labelWidth;
		this.resizeEl.setPointerCapture(e.pointerId);
		this.rootEl.addClass("is-resizing");

		const move = (ev: PointerEvent) => {
			this.setLabelWidth(startWidth + ev.clientX - startX);
			this.schedulePosition();
		};
		const up = (ev: PointerEvent) => {
			this.resizeEl.releasePointerCapture(ev.pointerId);
			this.rootEl.removeClass("is-resizing");
			this.resizeEl.removeEventListener("pointermove", move);
			this.resizeEl.removeEventListener("pointerup", up);
			this.resizeEl.removeEventListener("pointercancel", up);
			if (this.labelWidth !== startWidth) this.config.set("labelWidth", this.labelWidth);
		};
		this.resizeEl.addEventListener("pointermove", move);
		this.resizeEl.addEventListener("pointerup", up);
		this.resizeEl.addEventListener("pointercancel", up);
	}

	/** Size the column to the longest row name. */
	private fitLabelWidth(): void {
		let widest = 0;
		this.lanesEl.querySelectorAll<HTMLElement>(".bl-lane-label").forEach((el) => {
			const text = el.querySelector<HTMLElement>(".bl-lane-label-text");
			if (!text) return;
			// scrollWidth is the text's full width even when it's cut off.
			const style = getComputedStyle(el);
			const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
			const metric = el.querySelector<HTMLElement>(".bl-lane-metric");
			const metricWidth = metric && metric.textContent ? metric.getBoundingClientRect().width + parseFloat(style.columnGap || "0") : 0;
			widest = Math.max(widest, Math.ceil(text.scrollWidth + metricWidth + chrome) + 2);
		});
		if (widest === 0) return;
		this.setLabelWidth(widest);
		this.config.set("labelWidth", this.labelWidth);
		this.schedulePosition();
	}

	// ---- Viewport -------------------------------------------------------

	private get trackWidth(): number {
		return Math.max(1, this.axisEl.clientWidth);
	}

	/** Initial viewport: about six weeks, starting a week before today. */
	private showToday(): void {
		const today = moment().startOf("day").valueOf();
		this.msPerPx = clamp((42 * DAY_MS) / this.trackWidth, MIN_MS_PER_PX, MAX_MS_PER_PX);
		this.viewStart = today - 7 * DAY_MS;
		// Only lock the viewport once the view has a real width.
		this.hasViewport = this.axisEl.clientWidth > 0;
	}

	private onWheel(e: WheelEvent): void {
		const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.trackWidth : 1;
		const dx = e.deltaX * scale;
		const dy = e.deltaY * scale;

		// Embedded in a note, a plain vertical wheel must scroll as usual (rows, then the
		// note), or the reader gets stuck on the embed. Pan with shift or a sideways swipe.
		if (this.rootEl.closest(".bases-embed") && !e.ctrlKey && !e.metaKey) {
			if (!e.shiftKey && Math.abs(dy) >= Math.abs(dx)) return;
			e.preventDefault();
			this.viewStart += (e.shiftKey ? dy || dx : dx) * this.msPerPx;
			this.hasViewport = true;
			this.schedulePosition();
			return;
		}

		// Over the left rail (row names, group headers), the wheel scrolls rows.
		if (!e.ctrlKey && !e.metaKey && e.clientX < this.axisEl.getBoundingClientRect().left) {
			e.preventDefault();
			this.bodyEl.scrollTop += dy || dx;
			return;
		}

		if (e.ctrlKey || e.metaKey) {
			// Zoom around the cursor. Trackpad pinch also arrives as ctrl+wheel.
			e.preventDefault();
			const x = clamp(e.clientX - this.axisEl.getBoundingClientRect().left, 0, this.trackWidth);
			const anchor = this.viewStart + x * this.msPerPx;
			this.msPerPx = clamp(this.msPerPx * Math.exp(dy * 0.002), MIN_MS_PER_PX, MAX_MS_PER_PX);
			this.viewStart = anchor - x * this.msPerPx;
			this.zooming = true;
			window.clearTimeout(this.zoomSettleTimer);
			this.zoomSettleTimer = window.setTimeout(() => {
				this.zooming = false;
				this.schedulePosition();
			}, 150);
		} else if (e.shiftKey) {
			// Shift+wheel scrolls rows vertically (some platforms report it as deltaX).
			e.preventDefault();
			this.bodyEl.scrollTop += dy || dx;
			return;
		} else {
			e.preventDefault();
			this.viewStart += (dx + dy) * this.msPerPx;
		}
		this.hasViewport = true;
		this.schedulePosition();
	}

	private onPointerDown(e: PointerEvent): void {
		// Middle-drag pans anywhere; left-drag on an empty row creates an event there
		// (when the start is writable), and pans on any other empty space.
		if (e.button !== 0 && e.button !== 1) return;
		// Bars, row names and group headers handle their own presses (pointer capture would eat their clicks).
		if ((e.target as HTMLElement).closest(".bl-item, .bl-lane-label, .bl-group-header")) return;
		if (e.button === 0 && this.writable.start) {
			const trackEl = (e.target as HTMLElement).closest(".bl-lane-track");
			const lr = trackEl ? this.laneRenders.find((x) => x.trackEl === trackEl) : undefined;
			if (lr) {
				e.preventDefault();
				this.onCreatePointerDown(e, lr);
				return;
			}
		}
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		const startView = this.viewStart;
		const startScroll = this.bodyEl.scrollTop;
		this.bodyEl.setPointerCapture(e.pointerId);
		this.bodyEl.addClass("is-panning");

		const move = (ev: PointerEvent) => {
			this.viewStart = startView - (ev.clientX - startX) * this.msPerPx;
			this.bodyEl.scrollTop = startScroll - (ev.clientY - startY);
			this.hasViewport = true;
			this.schedulePosition();
		};
		const up = (ev: PointerEvent) => {
			this.bodyEl.releasePointerCapture(ev.pointerId);
			this.bodyEl.removeClass("is-panning");
			this.bodyEl.removeEventListener("pointermove", move);
			this.bodyEl.removeEventListener("pointerup", up);
			this.bodyEl.removeEventListener("pointercancel", up);
		};
		this.bodyEl.addEventListener("pointermove", move);
		this.bodyEl.addEventListener("pointerup", up);
		this.bodyEl.addEventListener("pointercancel", up);
	}

	private schedulePosition(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.position();
		});
	}

	/**
	 * Attach, place and detach item elements. Only lanes scrolled into view are
	 * considered, and within a lane only items overlapping the visible time range
	 * (found by binary search), so cost tracks what's on screen, not the dataset.
	 */
	/** x within a lane canvas (see originMs). */
	private toCanvasX(ms: number): number {
		return (ms - this.originMs) / this.originScale;
	}

	private positionItems(width: number): void {
		if (this.laneLayoutDirty) {
			// One layout read per render: lane heights don't change while panning.
			for (const lr of this.laneRenders) {
				lr.top = lr.el.offsetTop;
				lr.height = lr.el.offsetHeight;
			}
			this.laneLayoutDirty = false;
		}
		const scrollTop = this.bodyEl.scrollTop - OVERSCAN_PX;
		const scrollBottom = this.bodyEl.scrollTop + this.bodyEl.clientHeight + OVERSCAN_PX;
		const overscanMs = OVERSCAN_PX * this.msPerPx;
		const from = this.viewStart - overscanMs;
		const to = this.viewStart + width * this.msPerPx + overscanMs;

		// Canvas x is laid out at originScale; k stretches it to the current zoom.
		// Mid-gesture we only scale (GPU, no layout); re-base once the gesture settles,
		// or early if the stretch would visibly distort text.
		const k = this.originScale ? this.originScale / this.msPerPx : 1;
		const distorted = k < 0.67 || k > 1.5;
		const farPanned = Math.abs(this.viewStart - this.originMs) / this.msPerPx > 1e6;
		if (!this.originScale || farPanned || (k !== 1 && (!this.zooming || distorted))) {
			this.originMs = this.viewStart;
			this.originScale = this.msPerPx;
			this.layoutGen++;
		}
		// Re-clip after a re-base, or once the view gets within half a screen of the clip edge.
		const viewMs = width * this.msPerPx;
		const viewEnd = this.viewStart + viewMs;
		if (this.layoutGen !== this.clipGen || this.viewStart < this.clipFrom + viewMs / 2 || viewEnd > this.clipTo - viewMs / 2) {
			this.clipFrom = this.viewStart - viewMs;
			this.clipTo = viewEnd + viewMs;
			this.clipGen = this.layoutGen;
		}

		const scale = this.originScale / this.msPerPx;
		const shift = (this.originMs - this.viewStart) / this.msPerPx;
		const transform = scale === 1 ? `translateX(${shift}px)` : `translateX(${shift}px) scaleX(${scale})`;
		for (const lr of this.laneRenders) lr.canvasEl.style.transform = transform;

		const keep = new Set<RenderedItem>();
		const place = (r: RenderedItem, span: { start: number; end: number }) => {
			const { left, w, start, end } = this.clipGeometry(span);
			// Only bars that are actually clipped change key when the clip window moves.
			const key = `${this.layoutGen}:${start}:${end}`;
			if (r.placed !== key) {
				r.el.style.left = `${left}px`;
				r.el.style.width = `${w}px`;
				r.el.toggleClass("is-narrow", w < NARROW_PX);
				r.placed = key;
			}
			// Keep the title readable when the bar starts left of the viewport.
			if (scale !== 1) return; // mid-zoom: leave padding until the gesture settles
			const screenLeft = left + shift;
			const pad = screenLeft < 0 ? `${Math.min(-screenLeft, w - 24)}px` : "";
			if (r.pad !== pad) {
				r.labelEl.style.paddingLeft = pad;
				r.pad = pad;
			}
		};

		for (const lr of this.laneRenders) {
			if (lr.top + lr.height < scrollTop || lr.top > scrollBottom) continue;
			const items = lr.sorted;
			// First item that could still reach `from`, and first that starts after `to`.
			const lo = lowerBound(items, from - lr.maxDuration);
			const hi = lowerBound(items, to + 1);
			for (let i = lo; i < hi; i++) {
				const item = items[i];
				if (item.end < from) continue;
				const r = this.materialize(lr, item);
				if (!r.el.parentElement) lr.canvasEl.appendChild(r.el);
				const pending = this.pending.get(item.entry.file.path);
				r.el.toggleClass("is-saving", !!pending && !pending.failed);
				r.el.toggleClass("is-save-failed", !!pending?.failed);
				place(r, pending?.span ?? item);
				keep.add(r);
			}
		}

		// The dragged bar follows the pointer, wherever that is.
		const p = this.dragPreview;
		if (p) {
			for (const r of this.attached) {
				if (r.el === p.el) {
					place(r, p.live);
					keep.add(r);
				}
			}
		}

		for (const r of this.attached) {
			if (!keep.has(r)) r.el.remove();
		}
		this.attached = keep;
	}

	/** Canvas geometry for a span, clipped to the clip window (see clipFrom). */
	private clipGeometry(span: { start: number; end: number }): { left: number; w: number; start: number; end: number } {
		const start = Math.max(span.start, this.clipFrom);
		const end = Math.max(start, Math.min(span.end, this.clipTo));
		const left = this.toCanvasX(start);
		return { left, w: Math.max(MIN_ITEM_PX, this.toCanvasX(end) - left), start, end };
	}

	/** Re-place everything for the current viewport. Cheap: no DOM rebuild except ticks. */
	private position(): void {
		const width = this.trackWidth;
		const toX = (ms: number) => (ms - this.viewStart) / this.msPerPx;
		const viewEnd = this.viewStart + width * this.msPerPx;

		this.positionItems(width);

		// Ghost and drop outline live in lane canvases, so they use canvas coordinates.
		const p = this.dragPreview;
		if (p) {
			for (const [g, span] of [[p.ghostEl, p.origin], [p.dropEl, p.snapped]] as const) {
				if (!g) continue;
				const { left, w } = this.clipGeometry(span);
				g.style.left = `${left}px`;
				g.style.width = `${w}px`;
			}
		}

		this.renderWeekends(viewEnd, toX);

		const ticks = computeTicks(this.viewStart, viewEnd, this.msPerPx);

		this.axisMinorEl.empty();
		this.gridEl.querySelectorAll(".bl-gridline").forEach((el) => el.remove());
		for (const t of ticks.minor) {
			const x = toX(t.ms);
			const tick = this.axisMinorEl.createDiv({ cls: "bl-tick", text: t.label });
			tick.style.left = `${x}px`;
			const line = this.gridEl.createDiv({ cls: "bl-gridline" });
			line.style.left = `${x}px`;
		}

		this.axisMajorEl.empty();
		ticks.major.forEach((t, i) => {
			const x = toX(t.ms);
			const next = ticks.major[i + 1];
			const nextX = next ? toX(next.ms) : width;
			const tick = this.axisMajorEl.createDiv({ cls: "bl-tick bl-tick-major" });
			tick.style.left = `${x}px`;
			tick.style.width = `${nextX - x}px`;
			// Sticky label: pin to the left edge while its segment is in view.
			const label = tick.createSpan({ text: t.label });
			if (x < 0) label.style.marginLeft = `${Math.min(-x, Math.max(0, nextX - x - 120))}px`;
			const line = this.gridEl.createDiv({ cls: "bl-gridline bl-gridline-major" });
			line.style.left = `${x}px`;
		});

		const now = toX(Date.now());
		this.todayEl.toggle(now >= 0 && now <= width);
		this.todayEl.style.left = `${now}px`;
		this.scheduleMetrics();
	}

	// ---- Row metrics ------------------------------------------------------

	/** The metrics script was (re)loaded: recompute every cell. */
	refreshMetrics(): void {
		this.metricGen++;
		this.scheduleMetrics();
	}

	private scheduleMetrics(): void {
		window.clearTimeout(this.metricTimer);
		this.metricTimer = window.setTimeout(() => this.computeMetrics(), METRIC_SETTLE_MS);
	}

	/**
	 * Run the view's metric function for the rows on screen (and every section
	 * header), for the visible time range. A cell is only recomputed when its
	 * inputs change: new data, a new script, or a different time range.
	 */
	private computeMetrics(): void {
		if (this.pointerBusy || this.laneLayoutDirty) return this.scheduleMetrics();
		const { settings, script } = this.plugin;
		const name = String(this.config.get("rowMetric") ?? "");
		const active = settings.enableScripts && name.length > 0;
		const fn = active ? script.fns[name] : undefined;
		const missing = active && !fn ? (script.error ?? `No function "${name}" in the metrics script.`) : null;
		const windowStart = this.viewStart;
		const windowEnd = this.viewStart + this.trackWidth * this.msPerPx;
		const key = active ? `${this.metricGen}:${windowStart}:${windowEnd}` : "off";
		this.rootEl.toggleClass("has-metrics", active);

		const began = performance.now();
		const run = (el: HTMLElement, timed: Timed[], ctx: Pick<MetricContext, "scope" | "row" | "link" | "group">) => {
			el.removeClass("is-error");
			el.style.color = "";
			el.removeAttribute("title");
			el.setText("");
			if (!active) return;
			let shown = { text: "!", tooltip: missing as string | null, color: null as string | null };
			let failed = !fn;
			if (fn) {
				try {
					const notes = timed.map((t) => this.metricNote(t));
					const result: MetricResult = fn(notes, { ...ctx, windowStart, windowEnd, app: this.app, moment });
					shown = describeResult(result);
				} catch (e) {
					shown = { text: "!", tooltip: errorText(e), color: null };
					failed = true;
				}
			}
			el.toggleClass("is-error", failed);
			el.setText(shown.text);
			if (shown.tooltip) el.setAttr("title", shown.tooltip);
			if (shown.color) el.style.color = shown.color;
		};

		const top = this.bodyEl.scrollTop - OVERSCAN_PX;
		const bottom = this.bodyEl.scrollTop + this.bodyEl.clientHeight + OVERSCAN_PX;
		for (const lr of this.laneRenders) {
			if (lr.metricKey === key) continue;
			if (active && (lr.top + lr.height < top || lr.top > bottom)) continue;
			lr.metricKey = key;
			const { lane } = lr;
			run(lr.metricEl, lane.items.map((i) => i.timed), { scope: "row", row: lane.label, link: lane.link, group: null });
		}
		for (const h of this.headerMetrics) {
			if (h.key === key) continue;
			h.key = key;
			const byPath = new Map<string, Timed>();
			for (const lane of h.section.lanes) for (const i of lane.items) byPath.set(i.entry.file.path, i.timed);
			run(h.el, [...byPath.values()], { scope: "group", row: null, link: null, group: h.section.name });
		}

		const took = performance.now() - began;
		if (took > 200 && !this.metricSlowWarned) {
			this.metricSlowWarned = true;
			console.warn(`Bases Lanes: row metric "${name}" took ${Math.round(took)}ms for the visible rows.`);
		}
	}

	private metricNote(timed: Timed): MetricNote {
		let note = this.metricNotes.get(timed);
		if (!note) {
			note = makeNote(timed);
			this.metricNotes.set(timed, note);
		}
		return note;
	}

	/** Faint Sat–Sun bands behind the bars, so weeks stand out. */
	private renderWeekends(viewEnd: number, toX: (ms: number) => number): void {
		this.gridEl.querySelectorAll(".bl-weekend").forEach((el) => el.remove());
		if (this.config.get("shadeWeekends") === false) return;
		// Too far out to see individual days: bands would just be noise.
		if (DAY_MS / this.msPerPx < 2) return;

		const day = moment(this.viewStart).startOf("isoWeek").add(5, "days"); // Saturday
		while (day.valueOf() < viewEnd) {
			const start = day.valueOf();
			const end = day.clone().add(2, "days").valueOf(); // Monday 00:00, DST-safe
			const band = this.gridEl.createDiv({ cls: "bl-weekend" });
			band.style.left = `${toX(start)}px`;
			band.style.width = `${toX(end) - toX(start)}px`;
			day.add(1, "week");
		}
	}
}

/** Unsnapped drag, so the bar tracks the pointer exactly; never shorter than a minute. */
function liveDrag(item: LaneItem, mode: DragMode, deltaMs: number): DragResult {
	const min = 60_000;
	if (mode === "move") return { start: item.start + deltaMs, end: item.end + deltaMs };
	if (mode === "start") return { start: Math.min(item.start + deltaMs, item.end - min), end: item.end };
	return { start: item.start, end: Math.max(item.end + deltaMs, item.start + min) };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** Index of the first item whose start is >= ms (items sorted by start). */
function lowerBound(items: LaneItem[], ms: number): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (items[mid].start < ms) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Pointer capture throws for pointers that are no longer active; the drag works without it. */
function tryCapture(el: HTMLElement, pointerId: number, on: boolean): void {
	try {
		if (on) el.setPointerCapture(pointerId);
		else el.releasePointerCapture(pointerId);
	} catch {
		// ignore
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

function fmtTime(t: ParsedTime): string {
	return moment(t.ms).format(t.dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm");
}
