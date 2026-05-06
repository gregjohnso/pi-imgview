/**
 * Unit tests for utils.ts. Run with:
 *   npx tsx --test extensions/imgview/utils.test.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	expandHome,
	extensionForMime,
	isSupportedImageMime,
	resolveImage,
	sniffMime,
	tempHtmlForImage,
} from "./utils.js";

const PNG_MAGIC = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_MAGIC = Buffer.from([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("sniffMime", () => {
	it("detects PNG by magic bytes", () => {
		assert.equal(sniffMime(PNG_MAGIC), "image/png");
	});
	it("detects JPEG by magic bytes", () => {
		assert.equal(sniffMime(JPEG_MAGIC), "image/jpeg");
	});
	it("detects GIF by magic bytes", () => {
		assert.equal(sniffMime(GIF_MAGIC), "image/gif");
	});
	it("detects WebP by magic bytes", () => {
		assert.equal(sniffMime(WEBP_MAGIC), "image/webp");
	});
	it("detects SVG by content sniff", () => {
		assert.equal(sniffMime(Buffer.from("<svg xmlns=\"x\"></svg>")), "image/svg+xml");
		assert.equal(
			sniffMime(Buffer.from("<?xml version=\"1.0\"?><svg></svg>")),
			"image/svg+xml",
		);
	});
	it("falls back to extension hint when bytes are unknown", () => {
		assert.equal(sniffMime(Buffer.from([1, 2, 3, 4]), "/x/y.png"), "image/png");
		assert.equal(sniffMime(Buffer.from([1, 2, 3, 4]), "/x/y.jpeg"), "image/jpeg");
	});
	it("returns octet-stream when nothing matches", () => {
		assert.equal(sniffMime(Buffer.from([1, 2, 3, 4])), "application/octet-stream");
	});
});

describe("extensionForMime", () => {
	it("maps common MIMEs to extensions", () => {
		assert.equal(extensionForMime("image/png"), "png");
		assert.equal(extensionForMime("image/jpeg"), "jpg");
		assert.equal(extensionForMime("image/jpg"), "jpg");
		assert.equal(extensionForMime("image/gif"), "gif");
		assert.equal(extensionForMime("image/webp"), "webp");
		assert.equal(extensionForMime("image/svg+xml"), "svg");
		assert.equal(extensionForMime("application/zip"), "bin");
	});
});

describe("isSupportedImageMime", () => {
	it("accepts supported image MIMEs", () => {
		assert.equal(isSupportedImageMime("image/png"), true);
		assert.equal(isSupportedImageMime("image/jpeg"), true);
		assert.equal(isSupportedImageMime("IMAGE/PNG"), true);
		assert.equal(isSupportedImageMime("image/svg+xml"), true);
	});
	it("rejects non-image and unknown MIMEs", () => {
		assert.equal(isSupportedImageMime("application/pdf"), false);
		assert.equal(isSupportedImageMime("text/plain"), false);
		assert.equal(isSupportedImageMime(""), false);
	});
});

describe("expandHome", () => {
	it("expands a leading ~", () => {
		assert.equal(expandHome("~"), os.homedir());
		assert.equal(expandHome("~/foo"), path.join(os.homedir(), "foo"));
	});
	it("leaves other paths alone", () => {
		assert.equal(expandHome("/abs"), "/abs");
		assert.equal(expandHome("rel/path"), "rel/path");
		assert.equal(expandHome("~weird"), "~weird"); // not "~/"
	});
});

describe("resolveImage (data URI)", () => {
	it("decodes a base64 data: URI", async () => {
		const dataUri = `data:image/png;base64,${PNG_MAGIC.toString("base64")}`;
		const resolved = await resolveImage(dataUri, "/tmp");
		assert.equal(resolved.mimeType, "image/png");
		assert.equal(resolved.sourceLabel, "<data uri>");
		assert.equal(resolved.extension, "png");
		assert.deepEqual(resolved.bytes.subarray(0, 4), PNG_MAGIC.subarray(0, 4));
	});
	it("rejects malformed data: URIs", async () => {
		await assert.rejects(
			() => resolveImage("data:not-a-uri", "/tmp"),
			/malformed data:/,
		);
	});
});

describe("resolveImage (file)", () => {
	it("loads a real PNG file from disk", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "imgview-"));
		const file = path.join(tmp, "x.png");
		await fs.promises.writeFile(file, PNG_MAGIC);
		const resolved = await resolveImage(file, tmp);
		assert.equal(resolved.mimeType, "image/png");
		assert.equal(resolved.sourceLabel, file);
		assert.equal(resolved.extension, "png");
	});
	it("errors clearly on a missing file", async () => {
		await assert.rejects(
			() => resolveImage("/no/such/file/exists.png", "/tmp"),
			/cannot read/,
		);
	});
});

describe("tempHtmlForImage", () => {
	it("writes an HTML file containing the data URI and source label", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "imgview-html-"));
		const htmlPath = await tempHtmlForImage(
			{
				bytes: PNG_MAGIC,
				mimeType: "image/png",
				sourceLabel: "test/<source>.png",
				extension: "png",
			},
			tmp,
		);
		assert.match(htmlPath, /\.html$/);
		const html = await fs.promises.readFile(htmlPath, "utf8");
		assert.match(html, /data:image\/png;base64,/);
		assert.match(html, /test\/&lt;source&gt;\.png/);
	});
});
