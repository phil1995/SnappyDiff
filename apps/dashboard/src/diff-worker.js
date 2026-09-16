self.onmessage = async (event) => {
  const { requestId, baseline, current } = event.data;
  try {
    const [beforeResponse, afterResponse] = await Promise.all([
      fetch(baseline, { credentials: "same-origin", cache: "no-store" }),
      fetch(current, { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (!beforeResponse.ok || !afterResponse.ok) throw new Error("A private screenshot could not be loaded.");
    const [before, after] = await Promise.all([createImageBitmap(await beforeResponse.blob()), createImageBitmap(await afterResponse.blob())]);
    if (before.width !== after.width || before.height !== after.height) {
      throw new Error(`Dimension mismatch: baseline is ${before.width}×${before.height}, current is ${after.width}×${after.height}.`);
    }
    const canvas = new OffscreenCanvas(after.width, after.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(after, 0, 0);
    const output = context.getImageData(0, 0, after.width, after.height);
    const beforeCanvas = new OffscreenCanvas(before.width, before.height);
    const beforeContext = beforeCanvas.getContext("2d", { willReadFrequently: true });
    beforeContext.drawImage(before, 0, 0);
    const baselinePixels = beforeContext.getImageData(0, 0, before.width, before.height).data;
    const pixels = output.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const delta = Math.abs(pixels[index] - baselinePixels[index]) + Math.abs(pixels[index + 1] - baselinePixels[index + 1]) + Math.abs(pixels[index + 2] - baselinePixels[index + 2]) + Math.abs(pixels[index + 3] - baselinePixels[index + 3]);
      if (delta > 24) { pixels[index] = 255; pixels[index + 1] = 45; pixels[index + 2] = 173; pixels[index + 3] = 255; }
      else { pixels[index] = Math.round(pixels[index] * .22); pixels[index + 1] = Math.round(pixels[index + 1] * .22); pixels[index + 2] = Math.round(pixels[index + 2] * .22); pixels[index + 3] = 255; }
    }
    context.putImageData(output, 0, 0);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ requestId, bitmap }, [bitmap]);
    before.close(); after.close();
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : "Visual diff failed." });
  }
};
