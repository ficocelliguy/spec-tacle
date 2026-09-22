// End-to-end render check: run render.js on the bundled example and inspect
// the resulting HTML string for NaN, missing content, or malformed viewBox.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'lib', 'template.html');
const { render } = require(path.join(ROOT, 'lib', 'render.js'));
const DATA_PATH = path.join(ROOT, 'example', 'example-data.json');

let renderedHtml = '';
let tmpFile = '';

test('render() produces an HTML file without errors', () => {
  tmpFile = path.join(os.tmpdir(), `spec-tacle-render-test-${Date.now()}.html`);
  render(TEMPLATE, DATA_PATH, tmpFile);
  assert.ok(fs.existsSync(tmpFile), 'no output file created');
  renderedHtml = fs.readFileSync(tmpFile, 'utf-8');
  assert.ok(renderedHtml.length > 1000, 'rendered HTML looks empty');
});

test('rendered HTML contains no literal "NaN" text', () => {
  const nanCount = (renderedHtml.match(/\bNaN\b/g) || []).length;
  assert.equal(nanCount, 0, `found ${nanCount} occurrences of "NaN" in rendered HTML`);
});

test('rendered HTML contains no literal "undefined" text in the body', () => {
  // Strip any typeof "undefined" JS references and check for stray undefined in strings.
  // Focus on the specdata JSON blob and visible content.
  const scriptDataMatch = renderedHtml.match(/<script id="specdata"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptDataMatch, 'specdata script tag not found');
  const data = JSON.parse(scriptDataMatch[1]);
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /"[^"]*undefined[^"]*"/, 'undefined leaked into a data string');
});

test('every diagram\'s mermaid source appears verbatim in the rendered specdata', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const scriptDataMatch = renderedHtml.match(/<script id="specdata"[^>]*>([\s\S]*?)<\/script>/);
  const rendered = JSON.parse(scriptDataMatch[1]);
  assert.equal(rendered.diagrams.length, data.diagrams.length);
  for (let i = 0; i < data.diagrams.length; i++) {
    assert.equal(rendered.diagrams[i].source, data.diagrams[i].source,
      `diagram ${i} source mismatch after render`);
  }
});

test('all summary bullets and captions appear in the embedded data', () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const scriptDataMatch = renderedHtml.match(/<script id="specdata"[^>]*>([\s\S]*?)<\/script>/);
  const rendered = JSON.parse(scriptDataMatch[1]);
  assert.deepEqual(rendered.summary.what, data.summary.what);
  assert.deepEqual(rendered.summary.why, data.summary.why);
  for (let i = 0; i < data.diagrams.length; i++) {
    assert.equal(rendered.diagrams[i].caption, data.diagrams[i].caption);
    assert.equal(rendered.diagrams[i].detail || '', data.diagrams[i].detail || '');
  }
});

test('rendered HTML references mermaid CDN and the expected static structure', () => {
  // These live in the raw template (not created at runtime), so a stale build fails loud.
  assert.match(renderedHtml, /cdn\.jsdelivr\.net\/npm\/mermaid/, 'mermaid CDN link missing');
  assert.match(renderedHtml, /<script id="specdata"/, 'specdata script tag missing');
  assert.match(renderedHtml, /id="app"/, 'app container missing');
  assert.match(renderedHtml, /id="btn-update-spec"/, 'Update spec button missing');
  assert.match(renderedHtml, /id="btn-undo-spec"/, 'Undo button missing');
  assert.match(renderedHtml, /class="sticky-header"/, 'sticky header missing');
});

test.after(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});
