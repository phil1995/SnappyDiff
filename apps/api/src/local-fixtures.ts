const WIDTH = 960;
const HEIGHT = 640;
const fixtureNames = new Set([
  "local-fixture/detail-baseline.png",
  "local-fixture/detail-current.png",
  "local-fixture/home-baseline.png",
  "local-fixture/home-current.png",
  "local-fixture/new-current.png",
]);

export async function localFixturePng(storageKey: string): Promise<Uint8Array | null> {
  if (!fixtureNames.has(storageKey)) return null;
  const pixels = new Uint8Array(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y++) pixels[y * (1 + WIDTH * 4)] = 0;
  const fill = (x: number, y: number, width: number, height: number, color: readonly number[]) => {
    for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + height); row++) {
      for (let column = Math.max(0, x); column < Math.min(WIDTH, x + width); column++) {
        const offset = row * (1 + WIDTH * 4) + 1 + column * 4;
        pixels.set(color, offset);
      }
    }
  };
  const baseline = storageKey.includes("baseline");
  const detail = storageKey.includes("detail");
  const added = storageKey.includes("new-current");
  fill(0, 0, WIDTH, HEIGHT, [13, 16, 20, 255]);
  fill(0, 0, WIDTH, 68, [23, 27, 33, 255]);
  fill(28, 20, 30, 30, [217, 255, 87, 255]);
  fill(78, 27, 122, 14, [222, 226, 231, 255]);
  fill(760, 25, 64, 18, [102, 110, 122, 255]);
  fill(842, 19, 88, 31, [43, 49, 58, 255]);
  fill(0, 68, 196, HEIGHT - 68, [16, 20, 25, 255]);
  for (let y = 112; y < 340; y += 48) fill(28, y, 126 - (y % 3) * 8, 12, [83, 91, 103, 255]);
  fill(228, 104, 264, 22, [231, 233, 228, 255]);
  fill(228, 140, detail ? 382 : 302, 12, [105, 113, 125, 255]);
  if (detail) {
    fill(228, 190, 704, 224, [24, 29, 35, 255]);
    fill(254, 216, 250, 172, baseline ? [50, 70, 84, 255] : [55, 76, 91, 255]);
    fill(baseline ? 538 : 556, 216, baseline ? 368 : 350, 74, baseline ? [40, 46, 54, 255] : [56, 49, 31, 255]);
    fill(558, 238, baseline ? 188 : 226, 14, baseline ? [127, 137, 149, 255] : [255, 189, 74, 255]);
    fill(558, 270, 286, 10, [78, 86, 97, 255]);
    fill(538, 312, 370, 76, [40, 46, 54, 255]);
  } else {
    const card = (x: number, y: number, accent: readonly number[]) => {
      fill(x, y, 214, 150, [25, 30, 36, 255]); fill(x + 18, y + 20, 42, 42, accent);
      fill(x + 18, y + 82, 136, 13, [178, 184, 191, 255]); fill(x + 18, y + 108, 174, 9, [76, 84, 95, 255]);
    };
    card(228, 188, [75, 107, 122, 255]);
    card(458, 188, baseline ? [77, 91, 68, 255] : [217, 255, 87, 255]);
    card(688, 188, [105, 77, 92, 255]);
    fill(228, 368, 674, 104, [24, 29, 35, 255]);
    fill(252, 394, added ? 312 : 220, 14, added ? [217, 255, 87, 255] : [176, 182, 190, 255]);
    fill(252, 426, 582, 10, [76, 84, 95, 255]);
  }
  fill(228, 530, baseline ? 116 : 138, 38, baseline ? [47, 54, 63, 255] : [217, 255, 87, 255]);
  return encodePng(pixels, WIDTH, HEIGHT);
}

async function encodePng(raw: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rawBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const compressed = new Uint8Array(await new Response(new Blob([rawBuffer]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  return concatenate(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array()));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  new DataView(result.buffer).setUint32(0, data.length);
  result.set(name, 4); result.set(data, 8);
  new DataView(result.buffer).setUint32(8 + data.length, crc32(concatenate(name, data)));
  return result;
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
