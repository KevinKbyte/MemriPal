/* Spaced-review scheduler (SM-2 style) with a talk-date cap. Pure functions; days are integer day numbers.
   UMD: window.MPSched in the browser, module.exports in node. */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPSched = factory();
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

var AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

function newCard(place){ return {ivl:0, ease:2.5, reps:0, lapses:0, due:null, last:null, place:place}; }
function copy(c){ return {ivl:c.ivl, ease:c.ease, reps:c.reps, lapses:c.lapses, due:c.due, last:c.last, place:c.place}; }

/* The single source of interval maths, so preview() can never disagree with grade(). */
function next(c, g, today, talk){
  var ease = c.ease, ivl;
  // Floor at 1 day so a corrupt or zero interval can never schedule a card for today again.
  var good = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.max(1, Math.round(c.ivl * c.ease));
  if (g === AGAIN) { ivl = 1; ease = Math.max(1.3, ease - 0.2); }
  else if (g === HARD) { ivl = Math.max(1, Math.round(c.ivl * 1.2)); ease = Math.max(1.3, ease - 0.15); }
  else if (g === GOOD) ivl = good;
  else { ivl = c.reps === 0 ? 4 : Math.max(good + 1, Math.round(good * 1.3)); ease += 0.15; }
  var capped = false;
  // Before the talk no interval may reach past half the days left, so the last review lands on the eve.
  if (talk != null && today < talk) {
    var cap = Math.max(1, Math.floor((talk - today) / 2));
    if (ivl > cap) { ivl = cap; capped = true; }
  }
  return {ivl:ivl, ease:ease, capped:capped};
}

function grade(card, g, today, talk, relearn){
  var c = copy(card);
  // A card re-queued this session was already scheduled by its Again; the repeat only decides whether it comes back once more.
  if (relearn === true) return {card:c, requeue:g === AGAIN};
  var n = next(card, g, today, talk);
  c.ivl = n.ivl; c.ease = n.ease; c.last = today; c.due = today + n.ivl;
  if (g === AGAIN) { c.lapses++; c.reps = 0; } else c.reps++;
  return {card:c, requeue:g === AGAIN};
}

function preview(card, today, talk){
  var out = {};
  [AGAIN, HARD, GOOD, EASY].forEach(function(g){ var n = next(card, g, today, talk); out[g] = {ivl:n.ivl, capped:n.capped}; });
  return out;
}

function fmtIvl(n){
  if (n <= 0) return '<1m';
  if (n < 30) return n + 'd';
  if (n < 365) return Math.round(n / 30) + 'mo';
  return (n / 365).toFixed(1) + 'y';
}

function isInt(v){ return typeof v === 'number' && Number.isInteger(v); }
function dayOrNull(v){ return v === null || isInt(v); }
function validCard(c){
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  return isInt(c.ivl) && c.ivl >= 0 && typeof c.ease === 'number' && isFinite(c.ease) && isInt(c.reps) && c.reps >= 0 &&
    isInt(c.lapses) && c.lapses >= 0 && dayOrNull(c.due) && dayOrNull(c.last) && typeof c.place === 'string';
}

return {newCard:newCard, grade:grade, preview:preview, fmtIvl:fmtIvl, validCard:validCard};
});
