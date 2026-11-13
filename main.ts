// ai-happy-01 entry: "The Sunflower Gift"
// A small red robot gently offers a big sunflower to a smiling orange cat
// on a rooftop at golden hour. Fully procedural, deterministic, stdlib only.
// Renders a 1024x1024 PNG with a hand-rolled encoder (node:zlib + CRC32).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------- framebuffer
const fb = new Uint8Array(W * H * 4);

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function setPx(x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = c[3] / 255;
  if (a >= 1) {
    fb[i] = c[0];
    fb[i + 1] = c[1];
    fb[i + 2] = c[2];
    fb[i + 3] = 255;
  } else if (a > 0) {
    fb[i] = Math.round(c[0] * a + fb[i] * (1 - a));
    fb[i + 1] = Math.round(c[1] * a + fb[i + 1] * (1 - a));
    fb[i + 2] = Math.round(c[2] * a + fb[i + 2] * (1 - a));
    fb[i + 3] = 255;
  }
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPx(x, y, c);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGBA): void {
  const xa = Math.max(0, Math.floor(cx - r));
  const xb = Math.min(W - 1, Math.ceil(cx + r));
  const ya = Math.max(0, Math.floor(cy - r));
  const yb = Math.min(H - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPx(x, y, c);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGBA): void {
  const xa = Math.max(0, Math.floor(cx - rx));
  const xb = Math.min(W - 1, Math.ceil(cx + rx));
  const ya = Math.max(0, Math.floor(cy - ry));
  const yb = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(x, y, c);
    }
  }
}

// Scanline polygon fill (even-odd), points as [x, y] pairs.
function fillPoly(points: [number, number][], c: RGBA): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1p] = points[i];
      const [x2, y2p] = points[(i + 1) % points.length];
      if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
        const t = (y - y1p) / (y2p - y1p);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) setPx(x, y, c);
    }
  }
}

// Thick line drawn as a chain of circles (deterministic).
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGBA): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / (w * 0.4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(x0 + dx * t, y0 + dy * t, w / 2, c);
  }
}

// Arc (portion of a circle outline) as a thick polyline.
function arc(cx: number, cy: number, r: number, a0: number, a1: number, w: number, c: RGBA): void {
  const steps = Math.max(8, Math.ceil(((a1 - a0) * r) / 4));
  let px = cx + r * Math.cos(a0);
  let py = cy + r * Math.sin(a0);
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    thickLine(px, py, x, y, w, c);
    px = x;
    py = y;
  }
}

// Rounded rectangle.
function roundRect(x0: number, y0: number, x1: number, y1: number, r: number, c: RGBA): void {
  fillRect(x0 + r, y0, x1 - r, y1, c);
  fillRect(x0, y0 + r, x1, y1 - r, c);
  fillCircle(x0 + r, y0 + r, r, c);
  fillCircle(x1 - r, y0 + r, r, c);
  fillCircle(x0 + r, y1 - r, r, c);
  fillCircle(x1 - r, y1 - r, r, c);
}

// Heart shape from two circles + a triangle.
function heart(cx: number, cy: number, s: number, c: RGBA): void {
  fillCircle(cx - s * 0.32, cy - s * 0.18, s * 0.36, c);
  fillCircle(cx + s * 0.32, cy - s * 0.18, s * 0.36, c);
  fillPoly(
    [
      [cx - s * 0.62, cy - s * 0.02],
      [cx + s * 0.62, cy - s * 0.02],
      [cx, cy + s * 0.72],
    ],
    c,
  );
}

// ---------------------------------------------------------------- palette
const SKY_TOP: RGB = [232, 93, 117]; // rose
const SKY_MID: RGB = [255, 140, 105]; // coral
const SKY_LOW: RGB = [255, 190, 92]; // golden
const SUN_CORE: RGBA = [255, 243, 176, 255];
const SUN_GLOW: RGBA = [255, 209, 102, 90];
const CLOUD: RGBA = [255, 227, 211, 235];
const CITY_FAR: RGBA = [123, 75, 110, 255];
const CITY_NEAR: RGBA = [92, 58, 94, 255];
const WINDOW: RGBA = [255, 209, 102, 255];
const ROOF: RGBA = [168, 91, 63, 255];
const ROOF_EDGE: RGBA = [196, 116, 82, 255];
const ROOF_LINE: RGBA = [140, 70, 48, 255];
const ROBOT_RED: RGBA = [230, 57, 70, 255];
const ROBOT_DARK: RGBA = [43, 45, 66, 255];
const ROBOT_LIGHT: RGBA = [255, 255, 255, 255];
const ROBOT_CHEEK: RGBA = [255, 120, 140, 255];
const CAT_ORANGE: RGBA = [244, 162, 97, 255];
const CAT_DARK: RGBA = [224, 122, 63, 255];
const CAT_CREAM: RGBA = [255, 224, 178, 255];
const CAT_PINK: RGBA = [255, 150, 168, 255];
const PETAL: RGBA = [255, 195, 0, 255];
const PETAL_DARK: RGBA = [255, 170, 0, 255];
const SEED: RGBA = [122, 74, 33, 255];
const SEED_DOT: RGBA = [90, 53, 23, 255];
const STEM: RGBA = [96, 150, 72, 255];
const LEAF: RGBA = [110, 168, 84, 255];
const HEART: RGBA = [255, 93, 143, 255];
const BIRD: RGBA = [74, 44, 58, 255];
const INK: RGBA = [43, 45, 66, 255];

// ---------------------------------------------------------------- sky
function drawSky(): void {
  for (let y = 0; y < 700; y++) {
    const t = y / 700;
    const col = t < 0.5 ? mix(SKY_TOP, SKY_MID, t * 2) : mix(SKY_MID, SKY_LOW, (t - 0.5) * 2);
    fillRect(0, y, W, y, [col[0], col[1], col[2], 255]);
  }
  // Sun with soft glow, upper left.
  fillCircle(250, 250, 190, SUN_GLOW);
  fillCircle(250, 250, 140, [255, 214, 130, 110]);
  fillCircle(250, 250, 96, SUN_CORE);
  // Clouds.
  const clouds: [number, number, number][] = [
    [700, 150, 70],
    [790, 130, 55],
    [610, 170, 48],
    [880, 300, 60],
    [940, 280, 44],
    [120, 430, 55],
    [190, 415, 42],
  ];
  for (const [cx, cy, r] of clouds) {
    fillEllipse(cx, cy, r, r * 0.42, CLOUD);
  }
  // Birds.
  const birds: [number, number, number][] = [
    [560, 210, 26],
    [640, 260, 20],
    [470, 300, 17],
  ];
  for (const [bx, by, s] of birds) {
    arc(bx - s * 0.5, by, s * 0.55, Math.PI * 1.15, Math.PI * 1.85, 5, BIRD);
    arc(bx + s * 0.5, by, s * 0.55, Math.PI * 1.15, Math.PI * 1.85, 5, BIRD);
  }
}

// ---------------------------------------------------------------- city + roof
function drawCity(): void {
  // Far skyline.
  const far: [number, number, number][] = [
    [0, 560, 90],
    [70, 520, 130],
    [180, 570, 80],
    [250, 500, 110],
    [350, 560, 90],
    [430, 530, 120],
    [540, 570, 80],
    [610, 510, 130],
    [730, 560, 90],
    [810, 520, 120],
    [920, 560, 100],
  ];
  for (const [x, y, w] of far) {
    fillRect(x, y, x + w, 700, CITY_FAR);
  }
  // Near skyline with lit windows.
  const near: [number, number, number][] = [
    [20, 600, 110],
    [150, 580, 90],
    [260, 620, 100],
    [380, 590, 120],
    [520, 620, 90],
    [640, 585, 110],
    [780, 615, 100],
    [900, 590, 124],
  ];
  for (const [x, y, w] of near) {
    fillRect(x, y, x + w, 700, CITY_NEAR);
    for (let wy = y + 18; wy < 690; wy += 34) {
      for (let wx = x + 14; wx + 10 < x + w; wx += 30) {
        // Deterministic lit-window pattern (no randomness).
        if (((wx * 7 + wy * 13) % 5) < 2) {
          fillRect(wx, wy, wx + 10, wy + 12, WINDOW);
        }
      }
    }
  }
  // Rooftop floor.
  fillRect(0, 700, W, H, ROOF);
  fillRect(0, 700, W, 716, ROOF_EDGE);
  thickLine(0, 700, W, 700, 4, ROOF_LINE);
  // Floor boards.
  for (let x = 120; x < W; x += 200) {
    thickLine(x, 716, x - 40, H, 3, ROOF_LINE);
  }
  // Warm light pool under the sun.
  fillEllipse(512, 880, 420, 90, [255, 209, 102, 46]);
}

// ---------------------------------------------------------------- sunflower
function drawSunflower(cx: number, cy: number, r: number, tilt: number): void {
  // Petals: 12 ellipses rotated around the centre.
  for (let i = 0; i < 12; i++) {
    const a = tilt + (i * Math.PI * 2) / 12;
    const px = cx + Math.cos(a) * r * 0.78;
    const py = cy + Math.sin(a) * r * 0.78;
    // Petal as an ellipse stretched along the radial direction.
    const ex = Math.cos(a);
    const ey = Math.sin(a);
    const pr = r * 0.52;
    const pw = r * 0.30;
    // Draw petal by sampling a rotated ellipse.
    const xa = Math.max(0, Math.floor(px - pr));
    const xb = Math.min(W - 1, Math.ceil(px + pr));
    const ya = Math.max(0, Math.floor(py - pr));
    const yb = Math.min(H - 1, Math.ceil(py + pr));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = x - px;
        const dy = y - py;
        const u = dx * ex + dy * ey;
        const v = -dx * ey + dy * ex;
        if ((u * u) / (pr * pr) + (v * v) / (pw * pw) <= 1) {
          setPx(x, y, i % 2 === 0 ? PETAL : PETAL_DARK);
        }
      }
    }
  }
  // Centre disc + seeds.
  fillCircle(cx, cy, r * 0.52, SEED);
  const seeds: [number, number][] = [
    [0, 0],
    [-0.26, -0.14],
    [0.26, -0.14],
    [-0.14, 0.26],
    [0.14, 0.26],
    [0, -0.3],
    [-0.3, 0.1],
    [0.3, 0.1],
  ];
  for (const [sx, sy] of seeds) {
    fillCircle(cx + sx * r, cy + sy * r, r * 0.09, SEED_DOT);
  }
}

// ---------------------------------------------------------------- robot
function drawRobot(): void {
  // Shadow.
  fillEllipse(330, 905, 120, 18, [0, 0, 0, 60]);
  // Antenna with heart tip.
  thickLine(330, 560, 330, 500, 8, ROBOT_DARK);
  heart(330, 478, 34, HEART);
  // Head: dome + face screen.
  fillCircle(330, 620, 88, ROBOT_RED);
  fillRect(242, 620, 418, 668, ROBOT_RED);
  roundRect(258, 580, 402, 668, 26, ROBOT_LIGHT);
  // Happy closed eyes (upward arcs) and open smile.
  arc(292, 628, 16, Math.PI * 1.1, Math.PI * 1.9, 6, INK);
  arc(368, 628, 16, Math.PI * 1.1, Math.PI * 1.9, 6, INK);
  arc(330, 636, 22, Math.PI * 0.15, Math.PI * 0.85, 6, INK);
  // Cheeks.
  fillEllipse(272, 652, 14, 9, ROBOT_CHEEK);
  fillEllipse(388, 652, 14, 9, ROBOT_CHEEK);
  // Body.
  roundRect(258, 668, 402, 830, 34, ROBOT_RED);
  // Belly panel.
  roundRect(288, 700, 372, 800, 18, ROBOT_LIGHT);
  heart(330, 750, 40, HEART);
  // Legs.
  fillRect(278, 830, 306, 892, ROBOT_DARK);
  fillRect(354, 830, 382, 892, ROBOT_DARK);
  fillRect(264, 892, 316, 908, ROBOT_DARK);
  fillRect(344, 892, 396, 908, ROBOT_DARK);
  // Left arm resting down.
  thickLine(258, 720, 216, 800, 18, ROBOT_DARK);
  fillCircle(214, 802, 14, ROBOT_DARK);
  // Right arm reaching out to offer the flower.
  thickLine(402, 720, 470, 690, 18, ROBOT_DARK);
  fillCircle(472, 688, 14, ROBOT_DARK);
  // Stem from robot's hand to the flower.
  thickLine(472, 688, 496, 636, 10, STEM);
  // Leaf on the stem.
  fillEllipse(482, 668, 26, 12, LEAF);
}

// ---------------------------------------------------------------- cat
function drawCat(): void {
  // Shadow.
  fillEllipse(700, 905, 130, 18, [0, 0, 0, 60]);
  // Tail curled along the ground, tip flicked up.
  thickLine(786, 884, 826, 890, 20, CAT_ORANGE);
  thickLine(826, 890, 856, 872, 20, CAT_ORANGE);
  thickLine(856, 872, 866, 836, 20, CAT_ORANGE);
  fillCircle(866, 830, 11, CAT_ORANGE);
  // Body: sitting cat, big and simple.
  fillEllipse(700, 820, 105, 92, CAT_ORANGE);
  fillEllipse(700, 838, 78, 62, CAT_CREAM);
  // Head.
  fillCircle(700, 640, 92, CAT_ORANGE);
  // Ears (triangles) + inner ears.
  fillPoly(
    [
      [622, 596],
      [648, 520],
      [686, 580],
    ],
    CAT_ORANGE,
  );
  fillPoly(
    [
      [640, 584],
      [652, 544],
      [672, 576],
    ],
    CAT_PINK,
  );
  fillPoly(
    [
      [778, 596],
      [752, 520],
      [714, 580],
    ],
    CAT_ORANGE,
  );
  fillPoly(
    [
      [760, 584],
      [748, 544],
      [728, 576],
    ],
    CAT_PINK,
  );
  // Head stripes.
  thickLine(672, 552, 684, 580, 8, CAT_DARK);
  thickLine(700, 548, 700, 578, 8, CAT_DARK);
  thickLine(728, 552, 716, 580, 8, CAT_DARK);
  // Closed happy eyes (upward curves), pink nose, smile, blush.
  arc(662, 648, 18, Math.PI * 1.1, Math.PI * 1.9, 7, INK);
  arc(738, 648, 18, Math.PI * 1.1, Math.PI * 1.9, 7, INK);
  fillPoly(
    [
      [690, 668],
      [710, 668],
      [700, 682],
    ],
    CAT_PINK,
  );
  arc(700, 676, 20, Math.PI * 0.15, Math.PI * 0.85, 6, INK);
  fillEllipse(636, 678, 16, 10, CAT_PINK);
  fillEllipse(764, 678, 16, 10, CAT_PINK);
  // Whiskers.
  thickLine(640, 672, 586, 660, 3, INK);
  thickLine(640, 686, 588, 690, 3, INK);
  thickLine(760, 672, 814, 660, 3, INK);
  thickLine(760, 686, 812, 690, 3, INK);
  // Front paws together, delighted.
  fillEllipse(668, 900, 30, 20, CAT_ORANGE);
  fillEllipse(732, 900, 30, 20, CAT_ORANGE);
}

// ---------------------------------------------------------------- scene
function drawScene(): void {
  drawSky();
  drawCity();
  drawSunflower(495, 560, 88, 0.2);
  drawRobot();
  drawCat();
  // Floating hearts above the gift.
  heart(560, 430, 36, HEART);
  heart(620, 380, 26, HEART);
  heart(480, 360, 22, HEART);
  // A few sparkles near the flower.
  const sparks: [number, number, number][] = [
    [410, 480, 8],
    [580, 470, 7],
    [495, 440, 6],
  ];
  for (const [sx, sy, sr] of sparks) {
    fillCircle(sx, sy, sr, [255, 243, 176, 255]);
    fillCircle(sx, sy, sr * 0.45, [255, 255, 255, 255]);
  }
}

// ---------------------------------------------------------------- PNG encoder
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    raw.set(fb.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- main
function main(): void {
  drawScene();
  const png = encodePNG();
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
}

main();
