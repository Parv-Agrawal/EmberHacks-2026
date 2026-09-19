import { CameraSession, cameraErrorMessage, sizeOverlay } from "./camera.js";

const KNOWN_CODES = new Set(["2176123456789100", "leeterry"]);

export function classifyBarcode(value) {
  const code = String(value ?? "")
    .trim()
    .toLowerCase();
  return { code, known: KNOWN_CODES.has(code) };
}

/** Real Code 128 / Code 39 decoding, confined to memory on this device. */
export class BarcodeScanner {
  constructor(
    video,
    canvas,
    { onDetected = () => {}, onStatus = () => {} } = {},
  ) {
    this.video = video;
    this.canvas = canvas;
    this.onDetected = onDetected;
    this.onStatus = onStatus;
    this.generation = 0;
    this.frameRequest = null;
    this.confirmationTimer = null;
    this.capture = null;
    this.lastScan = -Infinity;
    this.lastVideoTime = -1;
    this.lastUnknownAt = -Infinity;
    this.camera = new CameraSession(video, {
      onInterrupted: (message) => {
        this.stop();
        this.onStatus({ status: "stopped", message });
      },
    });
  }

  async start() {
    this.stop();
    const generation = this.generation;
    this.onStatus({
      status: "loading",
      message: "Allow camera access to scan your demo TCard.",
    });
    try {
      if (!(await this.camera.start()) || generation !== this.generation)
        return;
      this.onStatus({
        status: "loading",
        message: "Loading the barcode scanner…",
      });
      this.detector = null;
      if (globalThis.BarcodeDetector) {
        try {
          const supported =
            await globalThis.BarcodeDetector.getSupportedFormats();
          if (generation !== this.generation) return;
          if (supported.includes("code_128") && supported.includes("code_39")) {
            this.detector = new globalThis.BarcodeDetector({
              formats: ["code_128", "code_39"],
            });
          }
        } catch {
          /* Native support can vary; the local ZXing fallback handles both formats. */
        }
      }
      if (!this.detector) await this.loadFallback(generation);
      if (generation !== this.generation) return;
      this.onStatus({
        status: "scanning",
        message:
          "Hold the barcode horizontally inside the frame. Keep it steady and avoid glare.",
      });
      this.frameRequest = requestAnimationFrame((now) =>
        this.scan(now, generation),
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      this.onStatus({ status: "error", message: cameraErrorMessage(error) });
    }
  }

  async loadFallback(generation) {
    let module;
    try {
      module = await import("../vendor/barcode.js");
    } catch {
      throw new Error(
        "The barcode scanner could not load. Run the camera asset setup and reload, or use email sign-in.",
      );
    }
    if (generation !== this.generation) return;
    const hints = new Map([
      [
        module.DecodeHintType.POSSIBLE_FORMATS,
        [module.BarcodeFormat.CODE_128, module.BarcodeFormat.CODE_39],
      ],
      [module.DecodeHintType.TRY_HARDER, true],
    ]);
    this.reader = new module.BrowserMultiFormatReader(hints);
    this.capture = document.createElement("canvas");
    this.captureContext = this.capture.getContext("2d", {
      willReadFrequently: true,
    });
    if (!this.captureContext)
      throw new Error(
        "This browser cannot prepare barcode images. Try another browser or use email sign-in.",
      );
  }

  async scan(now, generation) {
    if (generation !== this.generation) return;
    if (
      now - this.lastScan < 140 ||
      this.video.readyState < 2 ||
      this.video.currentTime === this.lastVideoTime
    ) {
      this.frameRequest = requestAnimationFrame((time) =>
        this.scan(time, generation),
      );
      return;
    }
    this.lastScan = now;
    this.lastVideoTime = this.video.currentTime;
    try {
      let result;
      if (this.detector) {
        let detections;
        try {
          detections = await this.detector.detect(this.video);
        } catch {
          if (generation !== this.generation) return;
          this.detector = null;
          await this.loadFallback(generation);
          detections = [];
        }
        // Prefer a known demo code if several cards are in view.
        const found =
          detections.find((item) => classifyBarcode(item.rawValue).known) ||
          detections[0];
        if (found) result = { code: found.rawValue, box: found.boundingBox };
      } else {
        this.capture.width = this.video.videoWidth;
        this.capture.height = this.video.videoHeight;
        this.captureContext.drawImage(this.video, 0, 0);
        try {
          const found = this.reader.decodeFromCanvas(this.capture);
          const points = found.getResultPoints().filter(Boolean);
          const xs = points.map((point) => point.getX());
          const ys = points.map((point) => point.getY());
          const left = Math.min(...xs);
          const top = Math.min(...ys);
          const width = Math.max(...xs) - left;
          // 1D readers report endpoints on a scanline, so expand that line into a framing box.
          const padding = Math.max(22, width * 0.09);
          result = {
            code: found.getText(),
            box: {
              x: left - 12,
              y: top - padding,
              width: width + 24,
              height: Math.max(...ys) - top + padding * 2,
            },
          };
        } catch (error) {
          // These are normal misses while the camera is searching for a barcode.
          if (
            ![
              "NotFoundException",
              "ChecksumException",
              "FormatException",
            ].includes(error?.getKind?.() || error?.name)
          )
            throw error;
        } finally {
          // Erase card pixels after each attempt; no data URL, upload, or persistent frame buffer.
          this.captureContext.clearRect(
            0,
            0,
            this.capture.width,
            this.capture.height,
          );
        }
      }
      if (generation !== this.generation) return;
      if (result) {
        const match = classifyBarcode(result.code);
        this.drawBox(result.box, match.known);
        if (match.known) {
          this.clearCapture();
          this.onStatus({
            status: "detected",
            message: "Demo TCard recognized. Signing in as Terry Lee…",
          });
          // Keep only the live feed briefly so the green outline remains on the card.
          // No snapshot is retained; leaving the screen or hiding the tab cancels this hold.
          this.confirmationTimer = setTimeout(() => {
            this.confirmationTimer = null;
            if (generation !== this.generation) return;
            this.camera.stop();
            this.generation += 1;
            this.onDetected({ code: match.code });
          }, 600);
          return;
        }
        if (now - this.lastUnknownAt > 1800) {
          this.lastUnknownAt = now;
          this.onStatus({
            status: "unknown",
            message:
              "Barcode read, but it is not linked to the demo account. Try the demo TCard or use email sign-in.",
          });
        }
      } else {
        this.canvas
          .getContext("2d")
          ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      this.onStatus({ status: "error", message: cameraErrorMessage(error) });
      return;
    }
    if (generation === this.generation)
      this.frameRequest = requestAnimationFrame((time) =>
        this.scan(time, generation),
      );
  }

  drawBox(box, known) {
    sizeOverlay(this.video, this.canvas);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.width)) return;
    context.strokeStyle = known ? "#72efac" : "#ffc466";
    context.lineWidth = Math.max(3, this.canvas.width / 280);
    context.strokeRect(box.x, box.y, box.width, box.height);
  }

  clearCapture() {
    if (this.capture) {
      this.capture.width = 0;
      this.capture.height = 0;
    }
    this.capture = null;
    this.captureContext = null;
    this.reader = null;
  }

  stop() {
    this.generation += 1;
    if (this.confirmationTimer !== null) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.camera.stop();
    this.clearCapture();
    this.detector = null;
    this.lastScan = -Infinity;
    this.lastVideoTime = -1;
    this.canvas
      .getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
