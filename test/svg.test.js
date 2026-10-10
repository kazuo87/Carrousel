import { test } from "node:test";
import assert from "node:assert/strict";
import { renderScientificSvg, THEME_NAMES, createRng } from "../src/generate/svg-art.js";

test("createRng : déterministe et borné", () => {
  const a = createRng("seed");
  const b = createRng("seed");
  const va = Array.from({ length: 5 }, () => a());
  const vb = Array.from({ length: 5 }, () => b());
  assert.deepEqual(va, vb);
  assert.ok(va.every((v) => v >= 0 && v < 1));
  assert.notDeepEqual(va, Array.from({ length: 5 }, createRng("other")));
});

test("renderScientificSvg : tous les thèmes produisent un SVG valide et déterministe", () => {
  assert.deepEqual(THEME_NAMES.sort(), ["antibody", "capsule", "cells", "helix", "molecule", "peptide", "trial"]);
  for (const theme of THEME_NAMES) {
    const svg = renderScientificSvg({ seed: "40000001", theme, hue: 120, label: "Test <&>" });
    assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""), theme);
    assert.ok(svg.trim().endsWith("</svg>"), theme);
    assert.ok(!svg.includes("NaN"), `${theme} contient NaN`);
    assert.ok(!svg.includes("undefined"), `${theme} contient undefined`);
    assert.ok(svg.includes("Test &lt;&amp;&gt;"), "libellé échappé");
    assert.ok(!/<script/i.test(svg));
    assert.equal(svg, renderScientificSvg({ seed: "40000001", theme, hue: 120, label: "Test <&>" }));
    assert.notEqual(svg, renderScientificSvg({ seed: "40000002", theme, hue: 120, label: "Test <&>" }));
  }
});

test("renderScientificSvg : thème inconnu → molécule par défaut", () => {
  const svg = renderScientificSvg({ seed: "x", theme: "nope", hue: 10 });
  assert.ok(svg.includes("<svg"));
});
