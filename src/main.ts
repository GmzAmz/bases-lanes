import { Plugin } from "obsidian";
import type { BasesPropertyId } from "obsidian";
import { declaredType } from "./dates";
import { LanesView, VIEW_TYPE } from "./view";

export default class BasesLanesPlugin extends Plugin {
	async onload() {
		// Start/end pickers hide properties declared as something other than a date
		// (text, number, list...). Undeclared, formula and file properties stay available.
		const dateLike = (prop: BasesPropertyId) => declaredType(this.app, prop) !== "other";

		this.registerBasesView(VIEW_TYPE, {
			name: "Lanes",
			icon: "lucide-gantt-chart",
			factory: (controller, containerEl) => new LanesView(controller, containerEl),
			options: () => [
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
			],
		});
	}
}
