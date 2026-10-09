/**
 * Bucket palette: the StarCraft player colors (SC2 slot order) as CSS named
 * colors, followed by the rest of the CSS named colors, each chosen to be the
 * most visually different (OKLab distance) from every color before it.
 */

const STARCRAFT = ["red", "blue", "teal", "purple", "yellow", "orange", "green", "pink"];

// CSS named colors (CSS Color 4), minus exact aliases (aqua/cyan, fuchsia/magenta, *grey).
const CSS_NAMED = [
	"aliceblue", "antiquewhite", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
	"blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
	"cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
	"darkgreen", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
	"darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkturquoise", "darkviolet",
	"deeppink", "deepskyblue", "dimgray", "dodgerblue", "firebrick", "floralwhite", "forestgreen",
	"gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "honeydew", "hotpink",
	"indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
	"lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightpink",
	"lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightsteelblue", "lightyellow",
	"lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid",
	"mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise",
	"mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite", "navy",
	"oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
	"paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue",
	"purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown",
	"seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "snow", "springgreen",
	"steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
	"yellow", "yellowgreen",
];

type Lab = [number, number, number];

/** Resolve a CSS color name to sRGB through the browser, so no hex table is needed. */
function toRgb(ctx: CanvasRenderingContext2D, name: string): [number, number, number] {
	ctx.fillStyle = "#000";
	ctx.fillStyle = name;
	const hex = String(ctx.fillStyle);
	return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function toOklab([r, g, b]: [number, number, number]): Lab {
	const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
	const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function distance(a: Lab, b: Lab): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function buildPalette(): string[] {
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return STARCRAFT;

	const lab = new Map<string, Lab>();
	for (const name of CSS_NAMED) lab.set(name, toOklab(toRgb(ctx, name)));

	const chosen = [...STARCRAFT];
	const chosenLab = chosen.map((n) => lab.get(n)!);
	// Near-white and near-black bars vanish against one theme or the other.
	const candidates = CSS_NAMED.filter((n) => {
		const L = lab.get(n)![0];
		return !chosen.includes(n) && L > 0.3 && L < 0.93;
	});

	// Farthest-point ordering: next is whichever candidate's nearest chosen color is farthest away.
	const nearest = candidates.map((n) => Math.min(...chosenLab.map((c) => distance(lab.get(n)!, c))));
	while (candidates.length > 0) {
		let best = 0;
		for (let i = 1; i < candidates.length; i++) if (nearest[i] > nearest[best]) best = i;
		const [name] = candidates.splice(best, 1);
		nearest.splice(best, 1);
		chosen.push(name);
		const picked = lab.get(name)!;
		for (let i = 0; i < candidates.length; i++) {
			nearest[i] = Math.min(nearest[i], distance(lab.get(candidates[i])!, picked));
		}
	}
	return chosen;
}

let palette: string[] | null = null;

export function getPalette(): string[] {
	if (!palette) palette = buildPalette();
	return palette;
}
