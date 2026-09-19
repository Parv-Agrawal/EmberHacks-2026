import { build } from "esbuild";
import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "app/static/vendor");
const modelURL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const modelPath = path.join(destination, "pose_landmarker_lite.task");
const expectedModelSha256 =
  "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";

await mkdir(destination, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts/barcode-entry.js")],
  outfile: path.join(destination, "barcode.js"),
  bundle: true,
  format: "esm",
  target: ["es2020"],
  minify: true,
  legalComments: "linked",
});
const visionPackage = path.join(root, "node_modules/@mediapipe/tasks-vision");
await cp(
  path.join(visionPackage, "vision_bundle.mjs"),
  path.join(destination, "vision_bundle.mjs"),
);
await cp(path.join(visionPackage, "wasm"), path.join(destination, "wasm"), {
  recursive: true,
});
await cp(
  path.join(visionPackage, "README.md"),
  path.join(destination, "MEDIAPIPE_README.md"),
);
await cp(
  path.join(root, "node_modules/@zxing/browser/LICENSE"),
  path.join(destination, "ZXING_BROWSER_LICENSE"),
);
await cp(
  path.join(root, "node_modules/@zxing/library/LICENSE"),
  path.join(destination, "ZXING_LIBRARY_LICENSE"),
);

let model;
try {
  model = await readFile(modelPath);
} catch {
  /* First setup downloads the fixed version below. */
}
if (!model) {
  const response = await fetch(modelURL, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok)
    throw new Error(
      `Pose model download failed (${response.status}). Run setup:vision again.`,
    );
  model = Buffer.from(await response.arrayBuffer());
  if (model.length < 1_000_000)
    throw new Error("Downloaded pose model is incomplete.");
}
const modelSha256 = createHash("sha256").update(model).digest("hex");
if (modelSha256 !== expectedModelSha256) {
  throw new Error(
    "Pose model checksum did not match the pinned version. Remove app/static/vendor/pose_landmarker_lite.task and run setup:vision again.",
  );
}
await writeFile(modelPath, model);
await writeFile(
  path.join(destination, "ASSETS.json"),
  JSON.stringify(
    {
      mediapipe: "0.10.21",
      zxingBrowser: "0.1.5",
      zxingLibrary: "0.21.3",
      modelURL,
      modelSha256,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Camera assets ready. Pose model SHA-256: ${modelSha256}`);
