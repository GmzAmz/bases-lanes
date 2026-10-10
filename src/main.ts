import { Plugin, PluginSettingTab, Setting, TFile, normalizePath } from "obsidian";
import type { App, BasesAllOptions, BasesPropertyId, TAbstractFile } from "obsidian";
import { declaredType } from "./dates";
import { evaluateScript, errorText } from "./metrics";
import type { LoadedScript } from "./metrics";
import { LanesView, VIEW_TYPE } from "./view";

interface Settings {
	/** Run the metrics script. Off by default: it is code from the vault. */
	enableScripts: boolean;
	/** Vault path of the metrics script. */
	scriptPath: string;
}

const DEFAULT_SETTINGS: Settings = { enableScripts: false, scriptPath: "" };

export default class BasesLanesPlugin extends Plugin {
	settings: Settings = { ...DEFAULT_SETTINGS };
	script: LoadedScript = { fns: {}, error: null };
	readonly views = new Set<LanesView>();
	private reloadTimer = 0;
	private settingTab: LanesSettingTab | null = null;

	async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<Settings> | null) };
		this.settingTab = new LanesSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Start/end pickers hide properties declared as something other than a date
		// (text, number, list...). Undeclared, formula and file properties stay available.
		const dateLike = (prop: BasesPropertyId) => declaredType(this.app, prop) !== "other";

		this.registerBasesView(VIEW_TYPE, {
			name: "Lanes",
			icon: "lucide-gantt-chart",
			factory: (controller, containerEl) => new LanesView(controller, containerEl, this),
			options: () => {
				const options: BasesAllOptions[] = [
					{
						type: "property",
						key: "start",
						displayName: "Start",
						placeholder: "Property",
						filter: dateLike,
					},
					{
						type: "property",
						key: "end",
						displayName: "End",
						placeholder: "Property (optional)",
						filter: dateLike,
					},
					{
						type: "toggle",
						key: "shadeWeekends",
						displayName: "Shade weekends",
						default: true,
					},
					{
						type: "group",
						displayName: "Display",
						items: [
							{
								type: "property",
								key: "title",
								displayName: "Bar title",
								placeholder: "File name",
							},
							{
								type: "property",
								key: "color",
								displayName: "Bar color",
								placeholder: "Property (any CSS color)",
							},
							{
								type: "property",
								key: "colorBucket",
								displayName: "Color by",
								placeholder: "Property (same value, same color)",
							},
							{
								type: "property",
								key: "sections",
								displayName: "Row sections",
								placeholder: "Property (collapsible sections)",
							},
						],
					},
				];
				const names = Object.keys(this.script.fns);
				if (this.settings.enableScripts && names.length > 0) {
					const choices: Record<string, string> = { "": "None" };
					for (const name of names) choices[name] = name;
					options.push({ type: "dropdown", key: "rowMetric", displayName: "Row metric", options: choices, default: "" });
				}
				return options;
			},
		});

		this.app.workspace.onLayoutReady(() => void this.loadScript());
		const onChange = (file: TAbstractFile, oldPath?: string) => {
			const path = this.scriptFile();
			if (path && (file.path === path || oldPath === path)) this.scheduleReload();
		};
		this.registerEvent(this.app.vault.on("modify", onChange));
		this.registerEvent(this.app.vault.on("create", onChange));
		this.registerEvent(this.app.vault.on("delete", onChange));
		this.registerEvent(this.app.vault.on("rename", onChange));
		this.register(() => window.clearTimeout(this.reloadTimer));
	}

	/** Save settings; reload the script now, or shortly (while typing a path). */
	async saveSettings(soon = false): Promise<void> {
		await this.saveData(this.settings);
		if (soon) this.scheduleReload();
		else await this.loadScript();
	}

	private scriptFile(): string | null {
		const path = this.settings.scriptPath.trim();
		return path ? normalizePath(path) : null;
	}

	private scheduleReload(): void {
		window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => void this.loadScript(), 500);
	}

	/** (Re)load the metrics script and refresh every open view. */
	async loadScript(): Promise<void> {
		const path = this.scriptFile();
		if (!this.settings.enableScripts || !path) {
			this.script = { fns: {}, error: null };
		} else {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				this.script = { fns: {}, error: `Script not found: ${path}` };
			} else {
				try {
					this.script = evaluateScript(await this.app.vault.read(file), path);
				} catch (e) {
					this.script = { fns: {}, error: errorText(e) };
				}
			}
		}
		for (const view of this.views) view.refreshMetrics();
		this.settingTab?.showStatus();
	}
}

class LanesSettingTab extends PluginSettingTab {
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private plugin: BasesLanesPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName("Row metrics").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"A JavaScript file in the vault can export functions that summarise each row's notes, e.g. coverage or overlap. " +
				"Pick one per view under the view's options (Row metric). The script runs with full access to Obsidian " +
				"and your computer, like a plugin: only enable it if you trust everyone who can edit that file.",
		});
		new Setting(containerEl)
			.setName("Enable metrics script")
			.setDesc("Off by default. Saved in the vault's .obsidian folder, so it is shared wherever that folder is.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableScripts).onChange(async (v) => {
					this.plugin.settings.enableScripts = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Script file")
			.setDesc("Vault path of a .js file, e.g. _lanes/metrics.js. Reloaded automatically when it changes.")
			.addText((t) =>
				t
					.setPlaceholder("_lanes/metrics.js")
					.setValue(this.plugin.settings.scriptPath)
					.onChange(async (v) => {
						this.plugin.settings.scriptPath = v;
						await this.plugin.saveSettings(true);
					}),
			);
		this.statusEl = containerEl.createDiv({ cls: "bl-settings-status" });
		this.showStatus();
	}

	hide(): void {
		this.statusEl = null;
	}

	showStatus(): void {
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const { settings, script } = this.plugin;
		if (!settings.enableScripts || !settings.scriptPath.trim()) return;
		if (script.error) {
			el.createSpan({ cls: "mod-warning", text: script.error });
			return;
		}
		el.setText(`Loaded: ${Object.keys(script.fns).join(", ")}`);
	}
}
