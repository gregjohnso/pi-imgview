/**
 * Helpers for pi-imgview.
 *
 * - resolveImage(): take a path / URL / data-URI and produce
 *   { bytes, mimeType, sourceLabel } for downstream rendering.
 * - sniffMime(): magic-byte detection so we don't trust extensions blindly.
 * - openInBrowser(): cross-platform "open this file/URL in the user's default
 *   handler" (HTML files inherit the system browser association).
 * - tempHtmlForImage(): write a self-contained HTML page that displays a
 *   single image, return its on-disk path.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedImage {
	/** Raw bytes of the image. */
	bytes: Buffer;
	/** Best-guess MIME type. */
	mimeType: string;
	/** Human label used in confirmations (path, URL, or "<data uri>"). */
	sourceLabel: string;
	/** Suggested file extension (without dot). */
	extension: string;
}

const SUPPORTED_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/avif",
	"image/svg+xml",
]);

/** Map a MIME to a sensible extension. */
export function extensionForMime(mimeType: string): string {
	const m = mimeType.toLowerCase();
	if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
	if (m.includes("png")) return "png";
	if (m.includes("gif")) return "gif";
	if (m.includes("webp")) return "webp";
	if (m.includes("bmp")) return "bmp";
	if (m.includes("avif")) return "avif";
	if (m.includes("svg")) return "svg";
	return "bin";
}

/** Magic-byte sniff. Falls back to extension-based guess, then octet-stream. */
export function sniffMime(buf: Buffer, hintPath?: string): string {
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		buf.length >= 4 &&
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47
	)
		return "image/png";
	// JPEG: FF D8 FF
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
		return "image/jpeg";
	// GIF: "GIF87a" or "GIF89a"
	if (
		buf.length >= 4 &&
		buf[0] === 0x47 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x38
	)
		return "image/gif";
	// WebP: "RIFF....WEBP"
	if (
		buf.length >= 12 &&
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	)
		return "image/webp";
	// BMP: "BM"
	if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
	// AVIF/HEIC: ftyp box at offset 4 ("ftyp"), brand "avif"|"avis"
	if (
		buf.length >= 12 &&
		buf[4] === 0x66 &&
		buf[5] === 0x74 &&
		buf[6] === 0x79 &&
		buf[7] === 0x70
	) {
		const brand = buf.subarray(8, 12).toString("ascii");
		if (brand === "avif" || brand === "avis") return "image/avif";
	}
	// SVG: starts with "<?xml" or "<svg"
	if (buf.length > 0) {
		const head = buf.subarray(0, Math.min(buf.length, 256)).toString("utf8");
		if (/^\s*<\?xml/i.test(head) || /^\s*<svg[\s>]/i.test(head)) {
			return "image/svg+xml";
		}
	}
	// Fallback to extension hint.
	if (hintPath) {
		const ext = path.extname(hintPath).toLowerCase().replace(/^\./, "");
		switch (ext) {
			case "png":
				return "image/png";
			case "jpg":
			case "jpeg":
				return "image/jpeg";
			case "gif":
				return "image/gif";
			case "webp":
				return "image/webp";
			case "bmp":
				return "image/bmp";
			case "avif":
				return "image/avif";
			case "svg":
				return "image/svg+xml";
		}
	}
	return "application/octet-stream";
}

/** True if the MIME is a known image type we should accept. */
export function isSupportedImageMime(mimeType: string): boolean {
	return SUPPORTED_MIMES.has(mimeType.toLowerCase());
}

/** Expand a leading "~" to the user's home directory. */
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve a user-supplied source string to bytes + MIME + label.
 * Accepts:
 *   - "data:image/...;base64,...." (data URI)
 *   - "http://" / "https://" URLs
 *   - file paths (absolute, relative-to-cwd, or "~/..." )
 */
export async function resolveImage(
	source: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<ResolvedImage> {
	const trimmed = source.trim();
	if (!trimmed) throw new Error("image source is empty");

	// data: URI
	if (trimmed.startsWith("data:")) {
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(trimmed);
		if (!match) throw new Error("malformed data: URI");
		const declaredMime = match[1] || "application/octet-stream";
		const isBase64 = !!match[2];
		const payload = match[3];
		const bytes = isBase64
			? Buffer.from(payload, "base64")
			: Buffer.from(decodeURIComponent(payload), "utf8");
		const mimeType = sniffMime(bytes) !== "application/octet-stream"
			? sniffMime(bytes)
			: declaredMime;
		return {
			bytes,
			mimeType,
			sourceLabel: "<data uri>",
			extension: extensionForMime(mimeType),
		};
	}

	// http(s) URL
	if (/^https?:\/\//i.test(trimmed)) {
		const res = await fetch(trimmed, { signal });
		if (!res.ok) {
			throw new Error(
				`failed to fetch ${trimmed}: HTTP ${res.status} ${res.statusText}`,
			);
		}
		const arr = new Uint8Array(await res.arrayBuffer());
		const bytes = Buffer.from(arr);
		const declared = res.headers.get("content-type") || "";
		const sniffed = sniffMime(bytes, trimmed);
		const mimeType = sniffed !== "application/octet-stream"
			? sniffed
			: declared.split(";")[0]?.trim() || "application/octet-stream";
		return {
			bytes,
			mimeType,
			sourceLabel: trimmed,
			extension: extensionForMime(mimeType),
		};
	}

	// File path
	const abs = path.isAbsolute(trimmed)
		? trimmed
		: path.resolve(cwd, expandHome(trimmed));
	const stat = await fs.promises.stat(abs).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`cannot read ${abs}: ${msg}`);
	});
	if (!stat.isFile()) {
		throw new Error(`${abs} is not a regular file`);
	}
	const bytes = await fs.promises.readFile(abs);
	const mimeType = sniffMime(bytes, abs);
	return {
		bytes,
		mimeType,
		sourceLabel: abs,
		extension: extensionForMime(mimeType),
	};
}

/**
 * Write a self-contained HTML viewer for the given image bytes and return its
 * path on disk. The image is embedded as a data URI so the HTML file is fully
 * portable (no sibling-file dependency, no server lifetime concerns).
 */
export async function tempHtmlForImage(
	img: ResolvedImage,
	tmpRoot: string,
): Promise<string> {
	await fs.promises.mkdir(tmpRoot, { recursive: true });
	const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const htmlPath = path.join(tmpRoot, `imgview-${id}.html`);
	const dataUri = `data:${img.mimeType};base64,${img.bytes.toString("base64")}`;
	const safeLabel = escapeHtml(img.sourceLabel);
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>imgview: ${safeLabel}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #111; color: #ddd; font: 13px -apple-system, system-ui, sans-serif; }
  .wrap { display: flex; flex-direction: column; height: 100%; }
  header { padding: 8px 12px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; user-select: text; }
  header code { color: #9cf; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 12px; }
  img { max-width: 100%; max-height: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.5); image-rendering: -webkit-optimize-contrast; }
</style>
</head>
<body>
  <div class="wrap">
    <header>imgview · <code>${safeLabel}</code> · ${img.bytes.length.toLocaleString()} bytes · ${escapeHtml(img.mimeType)}</header>
    <main><img src="${dataUri}" alt="${safeLabel}"></main>
  </div>
</body>
</html>
`;
	await fs.promises.writeFile(htmlPath, html, "utf8");
	return htmlPath;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Open a file path or URL with the OS's default handler.
 * Opening an .html file routes through the user's default browser on every
 * supported platform.
 */
export function openInBrowser(target: string): { command: string; args: string[] } {
	const platform = process.platform;
	let command: string;
	let args: string[];
	if (platform === "darwin") {
		command = "open";
		args = [target];
	} else if (platform === "win32") {
		// "start" needs an empty title arg when target may contain spaces.
		command = "cmd";
		args = ["/c", "start", "", target];
	} else {
		command = "xdg-open";
		args = [target];
	}
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return { command, args };
}
