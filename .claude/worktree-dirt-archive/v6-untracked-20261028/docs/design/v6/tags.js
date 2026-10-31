/* Palace tags, list sorting and filtering for the Review screen. Pure functions that never mutate their inputs.
   A row is {id, name, date: dayNum|null, tags: [string], work: int, retired: bool}.
   UMD: window.MPTags in the browser, module.exports in node. */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPTags = factory();
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

var KINDS = ['Talk', 'Exam'], SORTS = ['date', 'due', 'name', 'tag'], MAX_TAGS = 8, MAX_LEN = 24;
var CTRL = /[\u0000-\u001f\u007f]/;

function plainObj(o){ return !!o && typeof o === 'object' && !Array.isArray(o); }
function lc(s){ return String(s).toLowerCase(); }
function byText(a, b){ return lc(a).localeCompare(lc(b)); }
function findCi(list, s){ for (var i = 0; i < list.length; i++) if (lc(list[i]) === lc(s)) return list[i]; return null; }
function wellFormed(s){ return typeof s === 'string' && s.length >= 1 && s.length <= MAX_LEN && !CTRL.test(s); }

/* Reusing an existing spelling keeps 'talk' and 'Talk' from ever becoming two different tags. */
function normTag(raw, existingTags){
  if (typeof raw !== 'string') return null;
  var s = raw.trim();
  if (!wellFormed(s)) return null;
  return findCi(KINDS, s) || findCi(existingTags || [], s) || s;
}
function addTag(list, raw, known){
  var copy = list.slice(), tag = normTag(raw, known);
  if (tag === null) {
    var bad = typeof raw === 'string' && CTRL.test(raw.trim());
    return {list:copy, error:bad ? 'Tags cannot contain control characters.' : 'Tags need 1 to ' + MAX_LEN + ' characters.'};
  }
  if (findCi(list, tag) !== null) return {list:copy, error:'"' + tag + '" is already on this palace.'};
  if (list.length >= MAX_TAGS) return {list:copy, error:'A palace can have at most ' + MAX_TAGS + ' tags.'};
  return {list:copy.concat([tag]), error:null};
}
function validTags(obj, ids){
  return plainObj(obj) && Object.keys(obj).every(function(pid){
    var v = obj[pid];
    return ids.indexOf(pid) >= 0 && Array.isArray(v) && v.length <= MAX_TAGS && v.every(function(t, i){
      return wellFormed(t) && t.trim() === t && findCi(v.slice(0, i), t) === null;
    });
  });
}
function normView(v, tagsInUse){
  if (!plainObj(v) || SORTS.indexOf(v.sort) < 0 || (v.tag !== null && typeof v.tag !== 'string')) return {sort:'date', tag:null};
  return {sort:v.sort, tag:v.tag !== null && tagsInUse.indexOf(v.tag) >= 0 ? v.tag : null};
}
function kindOf(tags){ for (var i = 0; i < tags.length; i++) if (KINDS.indexOf(tags[i]) >= 0) return tags[i]; return null; }
function noun(tags){ var k = kindOf(tags); return k ? k.toLowerCase() : 'event'; }

function tagCounts(rows){
  var counts = {}, order = [];
  rows.forEach(function(r){
    r.tags.forEach(function(t){
      if (!Object.prototype.hasOwnProperty.call(counts, t)) { counts[t] = 0; order.push(t); }
      counts[t]++;
    });
  });
  return order.sort(byText).map(function(t){ return {tag:t, count:counts[t]}; });
}
function filterRows(rows, tag){ return tag === null ? rows.slice() : rows.filter(function(r){ return r.tags.indexOf(tag) >= 0; }); }

/* Soonest date: upcoming (today included) ascending, undated by name, past most recent first, retired last. */
function bucket(r, t){ return r.retired ? 3 : r.date === null ? 1 : r.date >= t ? 0 : 2; }
function byDate(t){
  return function(a, b){
    var ba = bucket(a, t), bb = bucket(b, t);
    if (ba !== bb) return ba - bb;
    var d = a.date === null || b.date === null ? 0 : ba === 2 ? b.date - a.date : a.date - b.date;
    return d || byText(a.name, b.name);
  };
}
function groupPalaces(rows, t){
  var groups = {}, keys = [], none = [];
  rows.forEach(function(r){
    if (!r.tags.length) { none.push(r); return; }
    var k = r.tags[0];
    if (!Object.prototype.hasOwnProperty.call(groups, k)) { groups[k] = []; keys.push(k); }
    groups[k].push(r);
  });
  var out = keys.sort(byText).map(function(k){ return {tag:k, rows:groups[k].slice().sort(byDate(t))}; });
  if (none.length) out.push({tag:null, rows:none.slice().sort(byDate(t))});
  return out;
}
function sortPalaces(rows, mode, t){
  var date = byDate(t);
  if (mode === 'due') return rows.slice().sort(function(a, b){ return b.work - a.work || date(a, b); });
  if (mode === 'name') return rows.slice().sort(function(a, b){ return byText(a.name, b.name); });
  if (mode === 'tag') return groupPalaces(rows, t).reduce(function(acc, g){ return acc.concat(g.rows); }, []);
  return rows.slice().sort(date);
}

return {KINDS:KINDS, SORTS:SORTS, MAX_TAGS:MAX_TAGS, MAX_LEN:MAX_LEN, normTag:normTag, addTag:addTag, validTags:validTags,
  normView:normView, kindOf:kindOf, noun:noun, tagCounts:tagCounts, filterRows:filterRows, sortPalaces:sortPalaces,
  groupPalaces:groupPalaces};
});
