/**
 * pi-imgview — display images from inside pi.
 *
 * Tools exposed to the LLM:
 *   - show_image: render an image inline in the terminal and/or open it in the
 *     user's default browser.
 *
 * User commands:
 *   - /imgcat  <path|url>   inline render in the terminal (if supported)
 *   - /imgshow <path|url>   open in default browser
 *   - /imgboth <path|url>   both
 *
 * Inline rendering is delegated to pi-tui by returning a tool result with
 * { type: "image", data, mimeType } content. Pi-tui already speaks the iTerm2
 * inline image protocol and the Kitty graphics protocol where available; on
 * terminals without image support the result still appears as a labelled
 * attachment, and the browser path remains a reliable fallback.
 *
 * Browser opening writes a self-contained HTML viewer (image embedded as a
 * data URI) to a temp directory and shells out to `open` / `xdg-open` /
 * `start` so the OS routes through the user's default browser.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Image, Spacer, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import {
	isSupportedImageMime,
	openInBrowser,
	resolveImage,
	tempHtmlForImage,
} from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

/**
 * Soft cap on per-image bytes returned to the model. Larger images blow up
 * the context window with base64 noise that adds nothing to comprehension.
 * 8 MiB is generous for a screenshot-sized PNG and tiny vs. a context budget
 * but worth flagging when exceeded.
 */
const SOFT_MAX_BYTES = 8 * 1024 * 1024;

const TMP_ROOT = path.join(os.tmpdir(), "pi-imgview");

const MODES = ["terminal", "browser", "both"] as const;
type Mode = (typeof MODES)[number];
const DEFAULT_MODE: Mode = "terminal";

// ─────────────────────────────────────────────────────────────────────────
// Tool schema
// ─────────────────────────────────────────────────────────────────────────

const SHOW_IMAGE_PARAMS = Type.Object({
	source: Type.String({
		description:
			"Path to a local image file (absolute, relative to cwd, or starting with ~), an http(s):// URL, or a data: URI.",
		minLength: 1,
	}),
	mode: Type.Optional(
		StringEnum(MODES, {
			description:
				"How to display the image. 'terminal' renders inline in supported terminals (iTerm2, Kitty, WezTerm, Ghostty). 'browser' opens it in the user's default browser. 'both' does both. Default: 'terminal'.",
		} as { description: string }),
	),
	caption: Type.Optional(
		Type.String({
			description:
				"Optional one-line note shown alongside the image (what it is, why you're showing it).",
			maxLength: 200,
		}),
	),
});

export type ShowImageInput = Static<typeof SHOW_IMAGE_PARAMS>;

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export default function imgviewExtension(pi: ExtensionAPI): void {
	// Custom message renderer used by the slash-command path so the image lands
	// in the transcript inline (same Image component pi-tui uses for tool
	// results). On terminals without image support, falls back to a label line.
	pi.registerMessageRenderer("imgview-image", (message, _options, theme) => {
		const details =
			(message as { details?: { image?: { data?: string; mimeType?: string }; bytes?: number; mimeType?: string; resolved?: string } })
				.details ?? {};
		const container = new Container();
		const label =
			typeof message.content === "string"
				? message.content
				: `imgview: ${details.resolved ?? "<image>"}`;
		container.addChild(new Text(theme.fg("accent", label), 0, 0));
		if (details.image?.data && details.image?.mimeType) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Image(
					details.image.data,
					details.image.mimeType,
					{ fallbackColor: (s: string) => theme.fg("muted", s) },
					{ maxWidthCells: 60 },
				),
			);
		}
		return container;
	});

	pi.registerTool({
		name: "show_image",
		label: "Show image",
		description:
			"Display an image to the user. Renders inline in supported terminals and/or opens it in the user's default browser. Use this whenever you want the user to actually see an image — a screenshot, a generated diagram, a file from disk, an image at a URL.",
		promptSnippet:
			"show_image — display an image to the user inline in the terminal and/or in the browser",
		promptGuidelines: [
			"Use show_image when the user asks to view, see, or display an image, screenshot, plot, or diagram. Prefer mode='terminal' for quick previews and mode='browser' (or 'both') for high-resolution images, large files, or anything the user will want to zoom into.",
			"Pass `source` as the literal path or URL the user gave you; do not paraphrase. For local files, ~ and relative paths are fine.",
			"Add a short `caption` when the image's relevance isn't obvious from context (e.g. 'PR diff screenshot' or 'matplotlib output').",
		],
		parameters: SHOW_IMAGE_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as ShowImageInput;
			const mode: Mode = input.mode ?? DEFAULT_MODE;
			onUpdate?.({
				content: [{ type: "text", text: `Loading ${input.source}...` }],
				details: { source: input.source, mode },
			});

			let resolved;
			try {
				resolved = await resolveImage(input.source, ctx.cwd, signal);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `show_image failed: ${msg}` }],
					details: { source: input.source, mode, error: msg },
					isError: true,
				};
			}

			if (!isSupportedImageMime(resolved.mimeType)) {
				return {
					content: [
						{
							type: "text",
							text: `Refusing to show ${resolved.sourceLabel}: detected MIME ${resolved.mimeType} is not a supported image type.`,
						},
					],
					details: {
						source: input.source,
						resolved: resolved.sourceLabel,
						mimeType: resolved.mimeType,
						mode,
					},
					isError: true,
				};
			}

			const bytes = resolved.bytes.length;
			const oversize = bytes > SOFT_MAX_BYTES;

			let browserPath: string | undefined;
			let browserError: string | undefined;
			let openCommand: string | undefined;
			if (mode === "browser" || mode === "both") {
				try {
					browserPath = await tempHtmlForImage(resolved, TMP_ROOT);
					const launched = openInBrowser(browserPath);
					openCommand = `${launched.command} ${launched.args.join(" ")}`;
				} catch (err: unknown) {
					browserError = err instanceof Error ? err.message : String(err);
				}
			}

			// Build the response. Inline rendering happens via the "image" content
			// part below — pi-tui hands it to the host terminal's image protocol
			// where supported, and falls back to a labelled attachment otherwise.
			//
			// Skip the "image" content when mode === "browser" so we don't waste
			// context on base64 the model has no reason to re-read.
			const summaryLines: string[] = [];
			summaryLines.push(
				`Showed ${resolved.sourceLabel} (${resolved.mimeType}, ${bytes.toLocaleString()} bytes) via mode=${mode}.`,
			);
			if (input.caption) summaryLines.push(`Caption: ${input.caption}`);
			if (browserPath) summaryLines.push(`Browser: opened ${browserPath}.`);
			if (browserError) summaryLines.push(`Browser open failed: ${browserError}.`);
			if (oversize) {
				summaryLines.push(
					`Note: image is ${bytes.toLocaleString()} bytes (> ${SOFT_MAX_BYTES.toLocaleString()} soft cap); inline rendering still works but the encoded form is large in context.`,
				);
			}
			if (
				(mode === "terminal" || mode === "both") &&
				!terminalLikelySupportsImages()
			) {
				summaryLines.push(
					"Note: this terminal doesn't appear to advertise inline image support (TERM_PROGRAM/KITTY_WINDOW_ID/WEZTERM not set). Pi-tui will still attempt to render; if you see only a placeholder, retry with mode='browser'.",
				);
			}

			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
			> = [{ type: "text", text: summaryLines.join("\n") }];

			if (mode === "terminal" || mode === "both") {
				content.push({
					type: "image",
					data: resolved.bytes.toString("base64"),
					mimeType: resolved.mimeType,
				});
			}

			return {
				content,
				details: {
					source: input.source,
					resolved: resolved.sourceLabel,
					mimeType: resolved.mimeType,
					bytes,
					mode,
					browserPath,
					browserError,
					openCommand,
					caption: input.caption,
				},
			};
		},
	});

	// ── user commands ────────────────────────────────────────────────────
	pi.registerCommand("imgcat", {
		description:
			"Render an image inline in the terminal: /imgcat <path|url|data:uri>",
		handler: (args, ctx) => runUserCommand(pi, ctx, args, "terminal"),
	});

	pi.registerCommand("imgshow", {
		description:
			"Open an image in the default browser: /imgshow <path|url|data:uri>",
		handler: (args, ctx) => runUserCommand(pi, ctx, args, "browser"),
	});

	pi.registerCommand("imgboth", {
		description:
			"Render an image inline AND open it in the browser: /imgboth <path|url|data:uri>",
		handler: (args, ctx) => runUserCommand(pi, ctx, args, "both"),
	});
}

// ─────────────────────────────────────────────────────────────────────────
// User-command path
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drive the same tool path as the LLM-facing tool, but invoked from a slash
 * command. Runs inline (no LLM round-trip) so the user gets immediate feedback
 * and the image lands in the transcript via pi.sendMessage.
 */
async function runUserCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
	mode: Mode,
): Promise<void> {
	const source = args.trim();
	if (!source) {
		ctx.ui.notify(
			`Usage: /img${mode === "terminal" ? "cat" : mode === "browser" ? "show" : "both"} <path|url|data:uri>`,
			"warning",
		);
		return;
	}

	let resolved;
	try {
		resolved = await resolveImage(source, ctx.cwd);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`imgview: ${msg}`, "error");
		return;
	}

	if (!isSupportedImageMime(resolved.mimeType)) {
		ctx.ui.notify(
			`imgview: ${resolved.sourceLabel} has unsupported MIME ${resolved.mimeType}.`,
			"error",
		);
		return;
	}

	let browserPath: string | undefined;
	if (mode === "browser" || mode === "both") {
		try {
			browserPath = await tempHtmlForImage(resolved, TMP_ROOT);
			openInBrowser(browserPath);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`imgview: failed to open browser: ${msg}`, "error");
		}
	}

	if (mode === "terminal" || mode === "both") {
		// Push a custom transcript message that carries the image as an
		// attachment. We deliver it as a non-turn-triggering followUp so it
		// renders in the transcript without forcing a fresh LLM call.
		pi.sendMessage(
			{
				customType: "imgview-image",
				content: `imgview: ${resolved.sourceLabel} (${resolved.mimeType}, ${resolved.bytes.length.toLocaleString()} bytes)`,
				display: true,
				details: {
					source,
					resolved: resolved.sourceLabel,
					mimeType: resolved.mimeType,
					bytes: resolved.bytes.length,
					// Attach the image bytes so pi-tui's renderer has them.
					// Even when our renderer isn't registered, pi falls back to
					// the default custom-message rendering and the image data
					// stays in the entry for inspection.
					image: {
						data: resolved.bytes.toString("base64"),
						mimeType: resolved.mimeType,
					},
				},
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	const summary = [
		`imgview: ${resolved.sourceLabel}`,
		`mime=${resolved.mimeType} bytes=${resolved.bytes.length.toLocaleString()} mode=${mode}`,
		browserPath ? `browser=${browserPath}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
	ctx.ui.notify(summary, "info");
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Best-effort sniff of whether the host terminal advertises inline-image
 * support. Used to add a hint to the model's response, not to gate behavior
 * (pi-tui makes the actual decision).
 */
function terminalLikelySupportsImages(): boolean {
	const env = process.env;
	if (env.KITTY_WINDOW_ID) return true;
	if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE) return true;
	const tp = (env.TERM_PROGRAM || "").toLowerCase();
	if (
		tp.includes("iterm") ||
		tp.includes("wezterm") ||
		tp.includes("ghostty") ||
		tp.includes("vscode") /* recent VS Code terminals */
	)
		return true;
	const term = (env.TERM || "").toLowerCase();
	if (term.includes("kitty") || term.includes("wezterm")) return true;
	return false;
}
