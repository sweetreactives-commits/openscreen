/**
 * Grabs a single frame of the source recording as an image.
 *
 * Deliberately the *source* frame, not the composed preview: an agent asking
 * what is on screen at some moment wants the app being demoed, not the wallpaper
 * and rounded corners wrapped around it.
 *
 * It also runs on its own detached video element rather than the one the user is
 * watching. Seeking the visible player to answer a question would drag the
 * playhead out from under them.
 */

export interface FrameGrabOptions {
	/** Longest edge of the returned image. Bigger costs the agent context. */
	maxWidth?: number;
	/** JPEG quality, 0 to 1. */
	quality?: number;
}

export interface GrabbedFrame {
	/** Where the frame was actually taken, which may differ from the request. */
	timeMs: number;
	width: number;
	height: number;
	mimeType: "image/jpeg";
	/** Base64 without a data URL prefix, ready for MCP image content. */
	base64: string;
}

const DEFAULT_MAX_WIDTH = 768;
const MAX_ALLOWED_WIDTH = 1920;
const DEFAULT_QUALITY = 0.7;
const LOAD_TIMEOUT_MS = 20_000;
const SEEK_TIMEOUT_MS = 15_000;

function waitForEvent(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for video "${event}" after ${timeoutMs}ms`));
		}, timeoutMs);

		const onDone = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error(`Video failed to ${event === "loadeddata" ? "load" : "seek"}`));
		};
		function cleanup() {
			clearTimeout(timer);
			target.removeEventListener(event, onDone);
			target.removeEventListener("error", onError);
		}

		target.addEventListener(event, onDone, { once: true });
		target.addEventListener("error", onError, { once: true });
	});
}

export async function grabFrame(
	videoUrl: string,
	timeMs: number,
	options: FrameGrabOptions = {},
): Promise<GrabbedFrame> {
	const maxWidth = Math.min(
		MAX_ALLOWED_WIDTH,
		Math.max(16, Math.round(options.maxWidth ?? DEFAULT_MAX_WIDTH)),
	);
	const quality = Math.min(1, Math.max(0.1, options.quality ?? DEFAULT_QUALITY));

	const video = document.createElement("video");
	video.preload = "auto";
	video.muted = true;
	// No crossOrigin: recordings are file:// URLs, and asking for a CORS handshake
	// they cannot answer leaves the element never firing loadeddata. The editor
	// window runs with webSecurity off, so the canvas reads back untainted.
	video.src = videoUrl;

	try {
		await waitForEvent(video, "loadeddata", LOAD_TIMEOUT_MS);

		const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
		// Seeking past the end never fires "seeked" on some containers, so clamp
		// into range and report where the frame actually came from.
		const targetSec = Math.max(0, Math.min(timeMs / 1000, Math.max(0, durationSec - 0.001)));
		video.currentTime = targetSec;
		await waitForEvent(video, "seeked", SEEK_TIMEOUT_MS);

		const sourceWidth = video.videoWidth;
		const sourceHeight = video.videoHeight;
		if (!sourceWidth || !sourceHeight) {
			throw new Error("Video reported no dimensions");
		}

		const scale = Math.min(1, maxWidth / sourceWidth);
		const width = Math.max(1, Math.round(sourceWidth * scale));
		const height = Math.max(1, Math.round(sourceHeight * scale));

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not get a 2D canvas context");
		context.drawImage(video, 0, 0, width, height);

		const dataUrl = canvas.toDataURL("image/jpeg", quality);
		return {
			timeMs: Math.round(video.currentTime * 1000),
			width,
			height,
			mimeType: "image/jpeg",
			base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
		};
	} finally {
		// Drop the source so the element and its buffers can be collected.
		video.removeAttribute("src");
		video.load();
	}
}
