/** At most two JPEGs in page memory: current inflection and worst completed rep. */
export class WorstRepBuffer {
  constructor({ createCanvas = () => document.createElement("canvas") } = {}) {
    this.canvas = createCanvas();
    this.candidate = null;
    this.worst = null;
  }

  observe(snapshot, video) {
    if (snapshot.discardCandidate) this.candidate = null;
    if (snapshot.captureCandidate) {
      // A failed capture must not associate an older pose with a newer inflection.
      this.candidate = null;
      try {
        const isCanvas = typeof video.getContext === "function";
        const width = isCanvas ? video.width : video.videoWidth;
        const height = isCanvas ? video.height : video.videoHeight;
        if ((isCanvas || video.readyState >= 2) && width > 0 && height > 0) {
          const scale = Math.min(1, 640 / Math.max(width, height));
          this.canvas.width = Math.round(width * scale);
          this.canvas.height = Math.round(height * scale);
          const context = this.canvas.getContext("2d");
          if (context) {
            context.drawImage(
              video,
              0,
              0,
              this.canvas.width,
              this.canvas.height,
            );
            const jpeg = this.canvas.toDataURL("image/jpeg", 0.75);
            if (jpeg.startsWith("data:image/jpeg;base64,"))
              this.candidate = jpeg;
          }
        }
      } catch {
        // Tracking can continue when browser image encoding is unavailable.
      } finally {
        this.canvas
          .getContext("2d")
          ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
    const rep = snapshot.completedRep;
    if (rep) {
      if (!this.worst || rep.score > this.worst.rep.score) {
        this.worst = { rep: structuredClone(rep), image: this.candidate };
      }
      this.candidate = null;
    }
  }

  discardPartial() {
    this.candidate = null;
  }

  clear() {
    this.candidate = null;
    this.worst = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
