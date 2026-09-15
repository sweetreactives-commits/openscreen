/**
 * How long a video file runs, read without playing it.
 *
 * The editor only learns a recording's length by loading it into the preview, and
 * a sequence needs every recording's length up front to lay the clips out. A
 * detached video element reads it from the metadata.
 *
 * Most files carry their length in the header — recordings made here get it
 * written when they stop, imported files have it already. A WebM straight out of
 * MediaRecorder does not, and reports `Infinity` until the element has seen its
 * end, so for those the element is sent to the end and asked again — the same
 * trick the preview player uses. Current Chromium usually works the length out by
 * itself even then, which is why no test reaches that branch.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

function finiteMs(seconds: number): number | null {
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** Resolves to the length in milliseconds, or `null` if it cannot be read in time. */
export function probeMediaDurationMs(
	url: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number | null> {
	return new Promise((resolve) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;

		let settled = false;
		let seekedToEnd = false;

		const finish = (value: number | null) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			video.removeEventListener("loadedmetadata", check);
			video.removeEventListener("durationchange", check);
			video.removeEventListener("seeked", check);
			video.removeEventListener("error", fail);
			video.removeAttribute("src");
			video.load();
			resolve(value);
		};

		function check() {
			const known = finiteMs(video.duration);
			if (known !== null) {
				finish(known);
				return;
			}
			if (video.readyState >= HTMLMediaElement.HAVE_METADATA && !seekedToEnd) {
				seekedToEnd = true;
				// Seeking far past the end makes the element find the real end.
				video.currentTime = Number.MAX_SAFE_INTEGER;
			}
		}

		function fail() {
			finish(null);
		}

		const timer = window.setTimeout(() => finish(null), timeoutMs);
		video.addEventListener("loadedmetadata", check);
		video.addEventListener("durationchange", check);
		video.addEventListener("seeked", check);
		video.addEventListener("error", fail);
		video.src = url;
	});
}
