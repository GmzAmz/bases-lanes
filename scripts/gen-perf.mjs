// Generates a perf dataset: 100 people x 5 years (~5,000 events) into <vault>/perf, plus Perf.base.
// Usage: node scripts/gen-perf.mjs "<vault path>"
// Run it with Obsidian closed: writing thousands of files while the vault is open
// overwhelms the file watcher on Windows and Obsidian only indexes some of them.
import fs from "fs";
import path from "path";

const vault = process.argv[2];
if (!vault) throw new Error("vault path required");
const root = path.join(vault, "perf");
fs.mkdirSync(path.join(root, "people"), { recursive: true });
fs.mkdirSync(path.join(root, "events"), { recursive: true });

// Deterministic RNG (mulberry32) so runs are reproducible.
let seed = 0xb1a5e5;
const rand = () => {
	seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;

const FIRST = ["Ava", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivan", "Jade", "Kai", "Lena", "Milo", "Nia", "Omar", "Pia", "Quin", "Rosa", "Sam", "Tara", "Uma", "Vic", "Wren", "Xiu", "Yara", "Zeke"];
const LAST = ["Abbott", "Brooks", "Chen", "Diaz", "Evans", "Fischer", "Garcia", "Hughes", "Ito", "Jensen", "Khan", "Lopez", "Moreau", "Nakamura", "Okafor", "Patel", "Quinn", "Rossi", "Silva", "Tanaka", "Ueda", "Vargas", "Weber", "Xu", "Young", "Zhang"];
const CATEGORIES = ["Engineering", "Field", "Talent", "Sales", "Support", "Operations"];
const COLORS = ["#e5484d", "#30a46c", "#0090ff", "tomato", "gold", "orchid", "#ff8b3e", "slateblue"];
const STATUSES = ["planned", "active", "done", "blocked"];
const PROJECTS = ["Migration", "Rollout", "Audit", "Redesign", "Onboarding", "Launch", "Upgrade", "Research", "Pilot", "Cleanup"];
const AREAS = ["Billing", "Search", "Mobile", "Payments", "Warehouse", "CRM", "Portal", "Network", "Analytics", "Infra"];

// People
const people = new Set();
while (people.size < 100) people.add(`${pick(FIRST)} ${pick(LAST)}`);
const peopleList = [...people];
for (const name of peopleList) {
	fs.writeFileSync(path.join(root, "people", `${name}.md`), `---\ncategory: ${pick(CATEGORIES)}\n---\n`);
}

const START = new Date(2022, 0, 1).getTime();
const END = new Date(2026, 11, 31).getTime();
const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const date = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const datetime = (ms, seconds) => { const d = new Date(ms); return `${date(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? ":00" : ""}`; };
const dayStart = () => { const d = new Date(START + Math.floor(rand() * ((END - START) / DAY)) * DAY); d.setHours(0, 0, 0, 0); return d.getTime(); };

const KINDS = [
	// [weight, kind]
	[40, "project"], [35, "meeting"], [10, "oncall"], [8, "travel"], [7, "milestone"],
];
const totalWeight = KINDS.reduce((s, [w]) => s + w, 0);
const pickKind = () => { let r = rand() * totalWeight; for (const [w, k] of KINDS) { if ((r -= w) < 0) return k; } return "project"; };

const used = new Set();
const counts = {};
const N = 5000;
for (let i = 0; i < N; i++) {
	const kind = pickKind();
	counts[kind] = (counts[kind] ?? 0) + 1;
	const day = dayStart();
	const fm = [];
	let title;
	let start, end = null, tag;

	if (kind === "project") {
		title = `${pick(AREAS)} ${pick(PROJECTS)}`;
		start = date(day); end = date(day + int(3, 40) * DAY); tag = "project";
	} else if (kind === "meeting") {
		title = `${pick(AREAS)} ${pick(["sync", "review", "standup", "planning", "retro", "demo"])}`;
		const s = day + int(8, 17) * 3600000 + pick([0, 15, 30, 45]) * 60000;
		const secs = chance(0.5);
		start = datetime(s, secs); end = datetime(s + pick([30, 60, 90, 120, 180]) * 60000, secs); tag = "meeting";
	} else if (kind === "oncall") {
		title = "On-call";
		start = date(day); end = date(day + 6 * DAY); tag = "ops";
	} else if (kind === "travel") {
		title = `Trip to ${pick(["Berlin", "Austin", "Tokyo", "Lagos", "Lima", "Oslo", "Pune", "Perth"])}`;
		const s = day + int(6, 20) * 3600000;
		start = datetime(s, false); end = datetime(s + int(1, 5) * DAY + int(0, 10) * 3600000, false); tag = "travel";
	} else {
		title = `${pick(AREAS)} ${pick(["release", "deadline", "go-live", "freeze"])}`;
		start = date(day); tag = "milestone";
	}

	fm.push(`start: ${start}`);
	if (end) fm.push(`end: ${end}`);
	if (!chance(0.03)) {
		const n = kind === "meeting" ? int(2, 4) : kind === "oncall" ? 1 : int(1, 3);
		const who = new Set();
		while (who.size < n) who.add(pick(peopleList));
		fm.push("assigned:", ...[...who].map((p) => `  - "[[${p}]]"`));
	}
	fm.push("tags:", `  - ${tag}`);
	if (chance(0.05)) fm.push(`lanes_color: "${pick(COLORS)}"`);
	if (chance(0.3)) fm.push(`status: ${pick(STATUSES)}`);

	let name = `${title} ${start.slice(0, 10)}`;
	for (let k = 2; used.has(name); k++) name = `${title} ${start.slice(0, 10)} (${k})`;
	used.add(name);
	fs.writeFileSync(path.join(root, "events", `${name}.md`), `---\n${fm.join("\n")}\n---\n`);
}

fs.writeFileSync(path.join(vault, "Perf.base"), `filters:
  and:
    - file.inFolder("perf/events")
formulas:
  person: assigned.map(value.asFile().properties.category + " · " + value.asFile().basename)
  lanes_bucket_color: file.tags
views:
  - type: lanes-timeline
    name: By person
    groupBy:
      property: note.assigned
      direction: ASC
    start: note.start
    end: note.end
  - type: lanes-timeline
    name: By category
    groupBy:
      property: formula.person
      direction: ASC
    start: note.start
    end: note.end
  - type: lanes-timeline
    name: By status
    groupBy:
      property: note.status
      direction: ASC
    start: note.start
    end: note.end
`);

console.log(JSON.stringify({ people: peopleList.length, events: N, counts }));
