import test from "node:test";
import assert from "node:assert/strict";
import library from "@zxing/library";
import {
  BrowserMultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
} from "../../app/static/vendor/barcode.js";

const { RGBLuminanceSource, HybridBinarizer, BinaryBitmap } = library;

function barcodeBitmap(widths) {
  const scale = 4;
  const width = widths.reduce((total, value) => total + value * scale, 160);
  const height = 240;
  const pixels = new Uint8ClampedArray(width * height).fill(255);
  let offset = 80;
  for (let index = 0; index < widths.length; index += 1) {
    if (index % 2 === 0) {
      for (let y = 20; y < height - 20; y += 1)
        pixels.fill(
          0,
          y * width + offset,
          y * width + offset + widths[index] * scale,
        );
    }
    offset += widths[index] * scale;
  }
  return new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)),
  );
}

test("the bundled fallback really decodes the demo Code 128 and Code 39 barcodes", () => {
  const reader = new BrowserMultiFormatReader(
    new Map([
      [
        DecodeHintType.POSSIBLE_FORMATS,
        [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39],
      ],
      [DecodeHintType.TRY_HARDER, true],
    ]),
  );
  // Fixed Code 128 C fixture: start C, 21 76 12 34 56 78 91 00, checksum 84, stop.
  const code128Widths = [
    ..."2112322132122211141122321311233311212411124121212122221241122331112",
  ].map(Number);
  assert.equal(
    reader.decodeBitmap(barcodeBitmap(code128Widths)).getText(),
    "2176123456789100",
  );
  // Standard Code 39 wide/narrow encodings for *LEETERRY*, with narrow inter-character gaps.
  const code39Encodings = [148, 67, 280, 280, 22, 280, 262, 262, 400, 148];
  const code39Widths = code39Encodings.flatMap((value, index) => [
    ...Array.from({ length: 9 }, (_, bit) =>
      value & (1 << (8 - bit)) ? 3 : 1,
    ),
    ...(index < code39Encodings.length - 1 ? [1] : []),
  ]);
  assert.equal(
    reader.decodeBitmap(barcodeBitmap(code39Widths)).getText(),
    "LEETERRY",
  );
});

test("a blank frame produces a normal decoder miss, including after minification", () => {
  const reader = new BrowserMultiFormatReader();
  const pixels = new Uint8ClampedArray(960 * 240).fill(255);
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, 960, 240)),
  );
  assert.throws(
    () => reader.decodeBitmap(bitmap),
    (error) => error.getKind() === "NotFoundException",
  );
});
