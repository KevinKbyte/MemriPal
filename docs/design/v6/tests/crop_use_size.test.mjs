// Covers: MEM-041
// Regression -- review/scene crops render the room, not an empty frame.
// photo() wraps <use href="#room"> in a cropped viewBox; without explicit width/height
// the symbol sizes to 100% of the crop and draws in the corner, so off-origin crops are blank.
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(process.env.APP_JS || new URL('../app.js', import.meta.url), 'utf8');

describe('MEM-041 prototype photo crops', () => {
  test('photo() gives the room symbol its full 800x560 size', () => {
    assert.match(src, /<use href="#room" width="800" height="560"><\/use>/);
  });
});
