/** Shared, cancellable camera ownership. No frames leave the browser. */
export function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "Camera permission was denied. Allow camera access in your browser, then try again, or use email sign-in.";
  }
  if (
    error?.name === "NotFoundError" ||
    error?.name === "OverconstrainedError"
  ) {
    return "No compatible camera was found. Connect a webcam or use email sign-in.";
  }
  if (error?.name === "NotReadableError" || error?.name === "AbortError") {
    return "The camera is unavailable. Close other apps using it, then try again.";
  }
  return (
    error?.message ||
    "The camera could not start. Check camera access and try again."
  );
}

export class CameraSession {
  constructor(video, { onInterrupted = () => {} } = {}) {
    this.video = video;
    this.onInterrupted = onInterrupted;
    this.stream = null;
    this.generation = 0;
    this.cleanup = [];
  }

  async start({ facingMode = "user" } = {}) {
    this.stop();
    const generation = this.generation;
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera access needs HTTPS or localhost and a browser with webcam support.",
      );
    }
    if (document.hidden)
      throw new Error("Return to this tab, then start the camera again.");
    const onHidden = () => {
      if (document.hidden)
        this.interrupt(
          "Camera stopped while this tab was hidden. Start it again when you return.",
        );
    };
    const onPageHide = () =>
      this.interrupt("Camera stopped because you left this page.");
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    this.cleanup.push(() =>
      document.removeEventListener("visibilitychange", onHidden),
    );
    this.cleanup.push(() => window.removeEventListener("pagehide", onPageHide));

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (generation !== this.generation || document.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.setAttribute("playsinline", "");
      this.video.srcObject = stream;
      for (const track of stream.getVideoTracks()) {
        const onEnded = () =>
          this.interrupt(
            "Camera disconnected. Reconnect it, then start the camera again.",
          );
        const onMute = () =>
          this.interrupt(
            "Camera feed was interrupted. Start the camera again.",
          );
        track.addEventListener("ended", onEnded);
        track.addEventListener("mute", onMute);
        this.cleanup.push(() => track.removeEventListener("ended", onEnded));
        this.cleanup.push(() => track.removeEventListener("mute", onMute));
      }
      await this.video.play();
      if (generation !== this.generation) return false;
      if (this.video.readyState < 2 || !this.video.videoWidth) {
        await new Promise((resolve, reject) => {
          let timer;
          const dispose = () => {
            clearTimeout(timer);
            this.video.removeEventListener("loadeddata", onLoaded);
          };
          const onLoaded = () => {
            dispose();
            resolve();
          };
          this.video.addEventListener("loadeddata", onLoaded, { once: true });
          timer = setTimeout(() => {
            dispose();
            reject(
              new Error(
                "The camera did not provide a video frame. Try starting it again.",
              ),
            );
          }, 12_000);
          this.cleanup.push(() => {
            dispose();
            resolve();
          });
        });
      }
      return generation === this.generation;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      throw error;
    }
  }

  interrupt(message) {
    this.stop();
    this.onInterrupted(message);
  }

  stop() {
    this.generation += 1;
    this.cleanup.splice(0).forEach((cleanup) => cleanup());
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}

/** Canvas and video share intrinsic dimensions and object-fit: contain. */
export function sizeOverlay(video, canvas) {
  if (
    canvas.width !== video.videoWidth ||
    canvas.height !== video.videoHeight
  ) {
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
  }
}
