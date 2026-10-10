/**
 * Illustrations scientifiques générées procéduralement en SVG.
 * Chaque image est déterministe (graine = PMID) et thématisée :
 *  peptide (chaîne d'acides aminés), antibody (IgG), molecule (graphe moléculaire),
 *  capsule (gélules + courbe dose-réponse), helix (double hélice), cells (cellules/bactéries),
 *  trial (courbes de survie type Kaplan-Meier).
 */

export const WIDTH = 1200;
export const HEIGHT = 675;

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function createRng(seed) {
  let a = hashSeed(seed) >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.between = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(rng.between(min, max + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

function hashSeed(seed) {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const f = (n) => Number(n.toFixed(1));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function background(hue, rng) {
  const blobs = [];
  for (let i = 0; i < 5; i++) {
    blobs.push(
      `<circle cx="${f(rng.between(0, WIDTH))}" cy="${f(rng.between(0, HEIGHT))}" r="${f(rng.between(120, 320))}" fill="hsl(${(hue + rng.int(-40, 40) + 360) % 360} 80% 60%)" opacity="0.14" filter="url(#blur)"/>`,
    );
  }
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 45% 12%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 40) % 360} 50% 20%)"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="hsl(${hue} 60% 80%)" stroke-opacity="0.07" stroke-width="1"/>
    </pattern>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  ${blobs.join("\n  ")}
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>`;
}

const AMINO = "ACDEFGHIKLMNPQRSTVWY";

function peptide(hue, rng) {
  const n = rng.int(11, 16);
  const amplitude = rng.between(60, 110);
  const startX = 110;
  const step = (WIDTH - 220) / (n - 1);
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ x: startX + i * step, y: HEIGHT / 2 + Math.sin(i * 0.9 + rng.between(0, 1)) * amplitude });
  }
  const bonds = points
    .slice(1)
    .map((p, i) => `<line x1="${f(points[i].x)}" y1="${f(points[i].y)}" x2="${f(p.x)}" y2="${f(p.y)}" stroke="hsl(${hue} 70% 75%)" stroke-width="7" stroke-linecap="round" opacity="0.9"/>`)
    .join("\n");
  const beads = points
    .map((p, i) => {
      const r = rng.between(26, 34);
      const side = rng() > 0.5 ? -1 : 1;
      const chain = `<line x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(p.x + rng.between(-12, 12))}" y2="${f(p.y + side * (r + rng.between(28, 60)))}" stroke="hsl(${(hue + 60) % 360} 70% 70%)" stroke-width="4" stroke-linecap="round" opacity="0.8"/>
      <circle cx="${f(p.x + rng.between(-12, 12))}" cy="${f(p.y + side * (r + rng.between(40, 70)))}" r="${f(rng.between(8, 14))}" fill="hsl(${(hue + 60) % 360} 80% 70%)" opacity="0.9"/>`;
      return `${chain}
      <circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(r)}" fill="hsl(${(hue + i * 9) % 360} 75% 62%)" stroke="white" stroke-opacity="0.6" stroke-width="3" filter="url(#glow)"/>
      <text x="${f(p.x)}" y="${f(p.y + 9)}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="700" fill="white">${AMINO[rng.int(0, AMINO.length - 1)]}</text>`;
    })
    .join("\n");
  return `${bonds}\n${beads}
  <text x="${f(points[0].x - 70)}" y="${f(points[0].y + 8)}" font-family="Inter, Arial, sans-serif" font-size="22" fill="white" opacity="0.7">H₂N</text>
  <text x="${f(points[n - 1].x + 40)}" y="${f(points[n - 1].y + 8)}" font-family="Inter, Arial, sans-serif" font-size="22" fill="white" opacity="0.7">COOH</text>`;
}

function antibodyShape(cx, cy, scale, hue, rng, mirrored = false) {
  const arm = (angle, color) => {
    const rad = (angle * Math.PI) / 180;
    const x2 = cx + Math.cos(rad) * 150 * scale;
    const y2 = cy - Math.sin(rad) * 150 * scale;
    const x3 = cx + Math.cos(rad) * 260 * scale;
    const y3 = cy - Math.sin(rad) * 260 * scale;
    return `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${f(28 * scale)}" stroke-linecap="round" opacity="0.95"/>
    <line x1="${f(x2)}" y1="${f(y2)}" x2="${f(x3)}" y2="${f(y3)}" stroke="hsl(${(hue + 50) % 360} 85% 72%)" stroke-width="${f(28 * scale)}" stroke-linecap="round" opacity="0.95"/>
    <ellipse cx="${f(x3)}" cy="${f(y3)}" rx="${f(26 * scale)}" ry="${f(18 * scale)}" transform="rotate(${-angle} ${f(x3)} ${f(y3)})" fill="hsl(${(hue + 90) % 360} 85% 70%)"/>`;
  };
  const color = `hsl(${hue} 70% 65%)`;
  const spread = rng.between(40, 55);
  const base = mirrored ? 270 : 90;
  return `<g filter="url(#glow)">
    ${arm(base + spread, color)}
    ${arm(base - spread, color)}
    <line x1="${f(cx)}" y1="${f(cy)}" x2="${f(cx)}" y2="${f(cy + (mirrored ? -1 : 1) * 230 * scale)}" stroke="${color}" stroke-width="${f(30 * scale)}" stroke-linecap="round"/>
    <rect x="${f(cx - 24 * scale)}" y="${f(mirrored ? cy - 250 * scale : cy + 120 * scale)}" width="${f(48 * scale)}" height="${f(120 * scale)}" rx="${f(18 * scale)}" fill="hsl(${(hue + 20) % 360} 80% 60%)" opacity="0.9"/>
  </g>`;
}

function antibody(hue, rng) {
  const main = antibodyShape(WIDTH * 0.38, HEIGHT * 0.42, 1, hue, rng);
  const twin = antibodyShape(WIDTH * 0.74, HEIGHT * 0.6, 0.62, (hue + 150) % 360, rng, true);
  const dots = Array.from({ length: 14 }, () =>
    `<circle cx="${f(rng.between(40, WIDTH - 40))}" cy="${f(rng.between(40, HEIGHT - 40))}" r="${f(rng.between(4, 11))}" fill="white" opacity="${f(rng.between(0.15, 0.5))}"/>`,
  ).join("\n");
  return `${dots}\n${main}\n${twin}`;
}

function molecule(hue, rng) {
  const atoms = [];
  const bonds = [];
  const elements = ["C", "C", "C", "N", "O", "C", "S", "N", "O", "F"];
  const rings = rng.int(2, 3);
  let cx = 300;
  for (let r = 0; r < rings; r++) {
    const cy = HEIGHT / 2 + rng.between(-70, 70);
    const radius = rng.between(70, 95);
    const start = atoms.length;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + rng.between(-0.05, 0.05);
      atoms.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, el: rng.pick(elements) });
    }
    for (let i = 0; i < 6; i++) bonds.push([start + i, start + ((i + 1) % 6), i % 2 === 0]);
    if (r > 0) bonds.push([start - 1, start + 3, false]);
    cx += radius * 2.6 + rng.between(20, 60);
  }
  // Substituants
  const count = rng.int(4, 7);
  for (let i = 0; i < count; i++) {
    const from = rng.int(0, atoms.length - 1);
    const angle = rng.between(0, Math.PI * 2);
    const len = rng.between(70, 120);
    atoms.push({ x: atoms[from].x + Math.cos(angle) * len, y: atoms[from].y + Math.sin(angle) * len, el: rng.pick(elements) });
    bonds.push([from, atoms.length - 1, rng() > 0.7]);
  }
  const bondSvg = bonds
    .map(([a, b, dbl]) => {
      const A = atoms[a];
      const B = atoms[b];
      const line = (off) => {
        const dx = B.y - A.y;
        const dy = A.x - B.x;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (dx / len) * off;
        const oy = (dy / len) * off;
        return `<line x1="${f(A.x + ox)}" y1="${f(A.y + oy)}" x2="${f(B.x + ox)}" y2="${f(B.y + oy)}" stroke="hsl(${hue} 60% 80%)" stroke-width="5" stroke-linecap="round" opacity="0.9"/>`;
      };
      return dbl ? `${line(-5)}\n${line(5)}` : line(0);
    })
    .join("\n");
  const atomSvg = atoms
    .map((a) => {
      const colors = { C: `hsl(${hue} 50% 70%)`, N: "hsl(220 85% 70%)", O: "hsl(0 85% 68%)", S: "hsl(48 90% 62%)", F: "hsl(140 70% 60%)" };
      return `<circle cx="${f(a.x)}" cy="${f(a.y)}" r="22" fill="${colors[a.el]}" stroke="white" stroke-opacity="0.7" stroke-width="3" filter="url(#glow)"/>
      <text x="${f(a.x)}" y="${f(a.y + 8)}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="#0b1020">${a.el}</text>`;
    })
    .join("\n");
  return `${bondSvg}\n${atomSvg}`;
}

function capsule(hue, rng) {
  const pills = [];
  for (let i = 0; i < 4; i++) {
    const x = 120 + i * 120 + rng.between(-20, 20);
    const y = 150 + rng.between(0, 240);
    const angle = rng.between(-50, 50);
    const c1 = `hsl(${(hue + i * 40) % 360} 80% 62%)`;
    const c2 = `hsl(${(hue + i * 40 + 180) % 360} 70% 85%)`;
    pills.push(`<g transform="rotate(${f(angle)} ${f(x)} ${f(y)})" filter="url(#glow)">
      <rect x="${f(x - 90)}" y="${f(y - 32)}" width="90" height="64" rx="32" fill="${c1}"/>
      <rect x="${f(x)}" y="${f(y - 32)}" width="90" height="64" rx="32" fill="${c2}"/>
      <rect x="${f(x - 70)}" y="${f(y - 22)}" width="30" height="10" rx="5" fill="white" opacity="0.5"/>
    </g>`);
  }
  // Courbe dose-réponse (sigmoïde)
  const x0 = 640;
  const y0 = 560;
  const w = 460;
  const h = 380;
  const ec50 = rng.between(0.35, 0.6);
  const slope = rng.between(6, 12);
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const yv = 1 / (1 + Math.exp(-slope * (t - ec50)));
    pts.push(`${f(x0 + t * w)},${f(y0 - yv * h)}`);
  }
  const markers = Array.from({ length: 7 }, (_, i) => {
    const t = (i + 0.5) / 7;
    const yv = 1 / (1 + Math.exp(-slope * (t - ec50))) + rng.between(-0.05, 0.05);
    return `<circle cx="${f(x0 + t * w)}" cy="${f(y0 - yv * h)}" r="8" fill="white" opacity="0.85"/>`;
  }).join("\n");
  return `${pills.join("\n")}
  <g opacity="0.9">
    <line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="white" stroke-opacity="0.5" stroke-width="2"/>
    <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="white" stroke-opacity="0.5" stroke-width="2"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="hsl(${(hue + 120) % 360} 90% 70%)" stroke-width="6" stroke-linecap="round" filter="url(#glow)"/>
    ${markers}
    <text x="${x0 + w / 2}" y="${y0 + 36}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" fill="white" opacity="0.7">log [dose]</text>
    <text x="${x0 - 14}" y="${y0 - h / 2}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" fill="white" opacity="0.7" transform="rotate(-90 ${x0 - 14} ${y0 - h / 2})">réponse</text>
  </g>`;
}

function helix(hue, rng) {
  const turns = rng.between(2.2, 3.2);
  const amp = 130;
  const cy = HEIGHT / 2;
  const left = 120;
  const right = WIDTH - 120;
  const n = 90;
  const strandA = [];
  const strandB = [];
  const rungs = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = left + t * (right - left);
    const phase = t * turns * Math.PI * 2 + rng.between(0, 0.2);
    const ya = cy + Math.sin(phase) * amp;
    const yb = cy + Math.sin(phase + Math.PI) * amp;
    strandA.push(`${f(x)},${f(ya)}`);
    strandB.push(`${f(x)},${f(yb)}`);
    if (i % 5 === 0) {
      const col = rng.pick(["hsl(0 80% 70%)", "hsl(210 80% 70%)", "hsl(120 70% 65%)", "hsl(48 90% 65%)"]);
      rungs.push(`<line x1="${f(x)}" y1="${f(ya)}" x2="${f(x)}" y2="${f(yb)}" stroke="${col}" stroke-width="8" stroke-linecap="round" opacity="0.85"/>`);
    }
  }
  return `${rungs.join("\n")}
  <polyline points="${strandA.join(" ")}" fill="none" stroke="hsl(${hue} 80% 72%)" stroke-width="12" stroke-linecap="round" filter="url(#glow)"/>
  <polyline points="${strandB.join(" ")}" fill="none" stroke="hsl(${(hue + 180) % 360} 80% 72%)" stroke-width="12" stroke-linecap="round" filter="url(#glow)" opacity="0.9"/>`;
}

function cells(hue, rng) {
  const items = [];
  for (let i = 0; i < 7; i++) {
    const x = rng.between(100, WIDTH - 100);
    const y = rng.between(90, HEIGHT - 90);
    const r = rng.between(45, 95);
    items.push(`<g filter="url(#glow)">
      <circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="hsl(${(hue + i * 15) % 360} 70% 60%)" opacity="0.55" stroke="white" stroke-opacity="0.5" stroke-width="3"/>
      <circle cx="${f(x + rng.between(-r / 4, r / 4))}" cy="${f(y + rng.between(-r / 4, r / 4))}" r="${f(r / 3)}" fill="hsl(${(hue + 200) % 360} 70% 40%)" opacity="0.9"/>
    </g>`);
  }
  for (let i = 0; i < 9; i++) {
    const x = rng.between(60, WIDTH - 60);
    const y = rng.between(60, HEIGHT - 60);
    const a = rng.between(0, 180);
    items.push(`<rect x="${f(x - 40)}" y="${f(y - 11)}" width="80" height="22" rx="11" transform="rotate(${f(a)} ${f(x)} ${f(y)})" fill="hsl(${(hue + 300) % 360} 85% 72%)" opacity="0.9" filter="url(#glow)"/>`);
  }
  return items.join("\n");
}

function trial(hue, rng) {
  const x0 = 140;
  const y0 = 560;
  const w = WIDTH - 280;
  const h = 400;
  const curve = (dropRate, color) => {
    const pts = [`${x0},${y0 - h}`];
    let y = 1;
    let x = 0;
    while (x < 1) {
      x += rng.between(0.02, 0.08);
      pts.push(`${f(x0 + Math.min(x, 1) * w)},${f(y0 - y * h)}`);
      y = Math.max(0.05, y - rng.between(0, dropRate));
      pts.push(`${f(x0 + Math.min(x, 1) * w)},${f(y0 - y * h)}`);
    }
    return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="7" stroke-linejoin="round" filter="url(#glow)"/>`;
  };
  const ticks = Array.from({ length: 6 }, (_, i) =>
    `<line x1="${f(x0 + (i / 5) * w)}" y1="${y0}" x2="${f(x0 + (i / 5) * w)}" y2="${y0 + 10}" stroke="white" stroke-opacity="0.6" stroke-width="2"/>`,
  ).join("\n");
  return `<line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="white" stroke-opacity="0.5" stroke-width="2"/>
  <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="white" stroke-opacity="0.5" stroke-width="2"/>
  ${ticks}
  ${curve(0.05, `hsl(${hue} 85% 68%)`)}
  ${curve(0.1, `hsl(${(hue + 160) % 360} 85% 68%)`)}
  <text x="${x0 + w / 2}" y="${y0 + 40}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" fill="white" opacity="0.7">temps</text>
  <text x="${x0 - 16}" y="${y0 - h / 2}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="20" fill="white" opacity="0.7" transform="rotate(-90 ${x0 - 16} ${y0 - h / 2})">probabilité</text>`;
}

const THEMES = { peptide, antibody, molecule, capsule, helix, cells, trial };

/**
 * @param {object} options
 * @param {string} options.seed   Graine (PMID)
 * @param {string} options.theme  Thème (voir THEMES)
 * @param {number} options.hue    Teinte de base (0-360)
 * @param {string} [options.label] Petit libellé en bas à gauche
 * @returns {string} SVG complet
 */
export function renderScientificSvg({ seed, theme = "molecule", hue = 200, label = "" }) {
  const rng = createRng(`${theme}:${seed}`);
  const draw = THEMES[theme] ?? THEMES.molecule;
  const title = label ? `<title>${esc(label)}</title>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img">
  ${title}
  ${background(hue, rng)}
  ${draw(hue, rng)}
  ${label ? `<text x="32" y="${HEIGHT - 28}" font-family="Inter, Arial, sans-serif" font-size="20" fill="white" opacity="0.6">${esc(label)}</text>` : ""}
</svg>`;
}

export const THEME_NAMES = Object.keys(THEMES);
