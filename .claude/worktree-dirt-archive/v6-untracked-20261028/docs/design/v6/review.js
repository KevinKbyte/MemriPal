/* Screen 9: spaced review across palaces. app.js calls MPReview(api) once state is loaded and hands over the helpers it shares;
   scheduling maths lives in sched.js (window.MPSched), tag/sort/filter rules in tags.js (window.MPTags). */
window.MPReview = function(A){
'use strict';
var S = A.S, esc = A.esc, icon = A.icon, Sched = window.MPSched, T = window.MPTags;
var TOK = 'review', DAY = 86400000, GRADES = ['Again', 'Hard', 'Good', 'Easy'];
var SORT_LABELS = {date:'Soonest date', due:'Most due', name:'Name', tag:'Tag'};
var PALACE_NAME = $('.palace-name').innerHTML;
/* Read-only demo palaces listed beside Elm. Card seeds are [ivl, ease, reps, lapses, due, last] with due/last as day offsets
   from the day the demo data is seeded (null = a new card); date is the event-day offset (null = no date). */
var DEMO = [
  {id:'demo-wedding', name:'Wedding toast', hue:300, date:3, tags:['Talk', 'Personal'], places:['door', 'window', 'clock', 'armchair', 'rug'],
   seed:[[3,2.5,2,0,0,-3], [3,2.35,2,1,0,-3], [1,2.3,1,1,-1,-2], [1,2.5,3,0,1,0], [1,2.5,2,0,1,0]],
   pts:[
    {label:'Welcome and thanks', quote:'thank you all for travelling so far to be here', scene:'The door is jammed open by a mountain of suitcases, each tagged with a guest\'s home town.', cue:'Climb over the suitcases to the window.'},
    {label:'How they met', quote:'they met at a bus stop in the rain, sharing one umbrella', scene:'Rain streams down the window. Two strangers squeeze under one red umbrella at a bus stop.', cue:'Follow the raindrops up to the clock.'},
    {label:'Never on time', quote:'Sam has never once been on time, except today', scene:'The clock hands spin wildly, then freeze at twelve as a tiny groom bursts out, right on time.', cue:'Drop from the clock into the armchair.'},
    {label:'Room for two', quote:'the armchair they fought over is now big enough for both of them', scene:'The armchair stretches wide as two people squeeze in under one shared blanket.', cue:'Look down at the rug in the middle of the room.'},
    {label:'Raise a glass', quote:'please stand and raise your glasses to the happy couple', scene:'The rug lifts every guest up like a magic carpet, glasses held high.', cue:'Back to the door. Toast complete.'}
   ]},
  {id:'demo-quarterly', name:'Quarterly update', hue:200, date:-2, tags:['Talk', 'Work'], places:['left books', 'plant', 'painting', 'lamp', 'mug'],
   seed:[[1,2.5,4,0,-2,-3], [1,2.5,4,0,-2,-3], [1,2.35,3,1,-2,-3], [2,2.5,4,0,-1,-3], [1,2.5,4,0,-2,-3]],
   pts:[
    {label:'Revenue up 12%', quote:'revenue grew twelve percent on the quarter', scene:'Twelve gold books shove the rest of the shelf aside, each one taller than the last.', cue:'Turn to the plant on the floor.'},
    {label:'Forty new customers', quote:'we signed forty new customers, mostly in the north region', scene:'Forty tiny customers climb the plant like a beanstalk, all heading north.', cue:'Rise up to the painting on the wall.'},
    {label:'App slips to August', quote:'the mobile app moved from June to August', scene:'The painting is a calendar with June torn off and August nailed on in its place.', cue:'Follow the light across to the lamp.'},
    {label:'Three new engineers', quote:'we will hire three engineers before the end of the year', scene:'Three engineers in hard hats hold the lamp shade up like a tent.', cue:'Reach over to the mug on the side table.'},
    {label:'Ask: support budget', quote:'we are asking for fifty thousand for the support team', scene:'The mug overflows with coins that spill across the side table.', cue:'Back to the bookshelf. Update complete.'}
   ]},
  {id:'demo-exam', name:'Bio midterm', hue:120, date:12, tags:['Exam'], places:['plant', 'lamp', 'photo frame', 'side table', 'waste basket'],
   seed:[[2,2.5,2,0,0,-2], [4,2.5,3,0,3,-1], null, null, [6,2.6,3,0,5,-1]],
   pts:[
    {label:'Mitochondria make ATP', quote:'mitochondria turn glucose and oxygen into ATP, the energy of the cell', scene:'The plant pot is a tiny power station; every leaf is a battery stamped ATP.', cue:'Follow the power cable up to the lamp.'},
    {label:'Photosynthesis', quote:'chloroplasts use light, water and carbon dioxide to make glucose and oxygen', scene:'The lamp beams onto a green leaf that gulps a glass of water and breathes out bubbles.', cue:'Glance across to the photo frame.'},
    {label:'DNA base pairs', quote:'A pairs with T, and C pairs with G', scene:'The photo frame shows an Apple hugging a Tree and a Cat hugging a Goat.', cue:'Step down to the side table.'},
    {label:'Mitosis makes twins', quote:'mitosis splits one cell into two identical daughter cells', scene:'The side table splits down the middle into two identical tables, each holding the same cup.', cue:'Drop to the waste basket on the floor.'},
    {label:'Enzymes speed reactions', quote:'enzymes are proteins that lower the activation energy of a reaction', scene:'A tiny protein worker with a shovel lowers a hill so paper balls roll straight into the basket.', cue:'Back to the plant. Revision complete.'}
   ]},
  {id:'demo-spanish', name:'Spanish verbs', hue:30, date:null, tags:['Language'], places:['clock', 'painting', 'mug', 'light switch', 'ceiling light'],
   seed:[[1,2.5,1,0,-1,-2], [3,2.5,2,0,0,-3], null, [5,2.5,3,0,2,-3], null],
   pts:[
    {label:'Hablar: -ar endings', quote:'regular -ar verbs end o, as, a, amos, an', scene:'The clock talks (habla) on the hour, chanting O, AS, A, AMOS, AN like a cuckoo.', cue:'Look across to the painting.'},
    {label:'Comer: -er endings', quote:'regular -er verbs end o, es, e, emos, en', scene:'The painting is a feast; a diner eats (come) while the plates spell O, ES, E, EMOS, EN.', cue:'Down to the mug for a drink.'},
    {label:'Vivir: -ir endings', quote:'regular -ir verbs end o, es, e, imos, en', scene:'A goldfish lives (vive) in the mug, blowing bubbles shaped O, ES, E, IMOS, EN.', cue:'Reach over to the light switch.'},
    {label:'Ser or estar', quote:'ser is for what something is, estar for how and where it is right now', scene:'The light switch has two labels: SER (always) and ESTAR (for now). Flick it and the room changes mood.', cue:'Look up at the ceiling light.'},
    {label:'Tener: yo tengo', quote:'tener goes tengo, tienes, tiene, tenemos, tienen', scene:'The ceiling light holds ten (tengo) glowing bulbs, each one counting itself out loud.', cue:'Back to the clock. Verbs complete.'}
   ]}
];
var IDS = ['elm'].concat(DEMO.map(function(d){ return d.id; }));
var RV = null;   // live session {pid, queue:[{id, relearn}], pos, shown}; null outside a session
/* Transient list UI: the row whose add-tag input is open (and its typed text), and the tag awaiting a remove confirm. */
var UI = {adding:null, addText:'', confirm:null};

function $(s, r){ return (r || document).querySelector(s); }
function ucFirst(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
function plural(n, w){ return n + ' ' + w + (n === 1 ? '' : 's'); }

/* ---------- days: integer day numbers from the local calendar date ---------- */
function dayNum(d){ return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); }
function today(){ return dayNum(new Date()) + S.dayOff; }
function isoDay(n){ return new Date(n * DAY).toISOString().slice(0, 10); }
function parseIso(s){
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  var n = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
  return isoDay(n) === s ? n : null;
}
function fmtDay(n){
  var d = new Date(n * DAY);
  return 'SunMonTueWedThuFriSat'.substr(d.getUTCDay() * 3, 3) + ' ' + d.getUTCDate() + ' ' + 'JanFebMarAprMayJunJulAugSepOctNovDec'.substr(d.getUTCMonth() * 3, 3);
}

/* ---------- state: seed, validate, keep cards in step with their points ---------- */
function seedReview(){
  var t0 = dayNum(new Date()), out = {elm:{}};
  DEMO.forEach(function(d){
    out[d.id] = {};
    d.seed.forEach(function(s, i){ out[d.id][String(i + 1)] = s ? {ivl:s[0], ease:s[1], reps:s[2], lapses:s[3], due:t0 + s[4], last:t0 + s[5], place:d.places[i]} : Sched.newCard(d.places[i]); });
  });
  return out;
}
function seedDates(){
  var t0 = dayNum(new Date()), out = {elm:isoDay(t0 + 7)};
  DEMO.forEach(function(d){ if (d.date !== null) out[d.id] = isoDay(t0 + d.date); });
  return out;
}
function seedTags(){
  var out = {elm:['Talk']};
  DEMO.forEach(function(d){ out[d.id] = d.tags.slice(); });
  return out;
}
function plainObj(o){ return !!o && typeof o === 'object' && !Array.isArray(o); }
function validReview(r){
  return plainObj(r) && Object.keys(r).every(function(pid){
    return IDS.indexOf(pid) >= 0 && plainObj(r[pid]) && Object.keys(r[pid]).every(function(k){ return Sched.validCard(r[pid][k]); });
  });
}
function validDates(t){ return plainObj(t) && Object.keys(t).every(function(pid){ return IDS.indexOf(pid) >= 0 && parseIso(t[pid]) !== null; }); }
function validRetired(a){ return Array.isArray(a) && a.every(function(id, i){ return IDS.indexOf(id) >= 0 && a.indexOf(id) === i; }); }
/* Any bad slice falls back to its seed: a half-trusted schedule is worse than a fresh one. v5 stores kept dates as `talks`. */
function load(saved){
  var o = plainObj(saved) ? saved : {};
  S.review = validReview(o.review) ? o.review : seedReview();
  S.dates = validDates(o.dates) ? o.dates : validDates(o.talks) ? o.talks : seedDates();
  S.tags = T.validTags(o.tags, IDS) ? o.tags : seedTags();
  S.rvView = T.normView(o.rvView, allTags());
  S.dayOff = Number.isInteger(o.dayOff) && o.dayOff >= 0 && o.dayOff <= 3650 ? o.dayOff : 0;
  S.retired = validRetired(o.retired) ? o.retired : [];
  syncCards();
}

/* Every palace has one shape: stops in walking order, each {id, n, place, box, ready}. Elm reads the live palace. */
function palaces(){
  var elm = {id:'elm', name:'Elm Street tool library', demo:false, stops:S.order.map(function(id, ix){
    return {id:String(id), n:ix + 1, place:S.places[ix], box:A.LOCI[ix].box, ready:A.eff(id, ix) === 'ready'};
  })};
  return [elm].concat(DEMO.map(function(d){
    return {id:d.id, name:d.name, demo:true, hue:d.hue, stops:d.places.map(function(pl, i){ return {id:String(i + 1), n:i + 1, place:pl, box:A.OBJ(pl).box, ready:true}; })};
  }));
}
function palace(pid){ return palaces().filter(function(p){ return p.id === pid; })[0]; }
function dateDay(pid){ return parseIso(S.dates[pid]); }
function tagsOf(pid){ return S.tags[pid] || []; }
function allTags(){ return IDS.reduce(function(a, id){ return a.concat(tagsOf(id)); }, []); }
function noun(pid){ return T.noun(tagsOf(pid)); }
function isRetired(pid){ return S.retired.indexOf(pid) >= 0; }
/* A card belongs to a point at one place. A new place or an unbuilt scene means the old memory no longer applies, so it starts over. */
function syncCards(){
  palaces().forEach(function(pal){
    var old = S.review[pal.id] || {}, keep = {};
    pal.stops.forEach(function(st){
      var c = old[st.id];
      keep[st.id] = st.ready && c && c.place === st.place ? c : Sched.newCard(st.place);
    });
    S.review[pal.id] = keep;
  });
}
function card(pal, st){ var c = (S.review[pal.id] || {})[st.id]; return c && c.place === st.place ? c : null; }
/* Read-only counts (no syncCards) so the rail can show them on any screen without touching saved cards. */
function stats(pal){
  var t = today(), o = {due:0, overdue:0, nw:0, next:null, notBuilt:0};
  pal.stops.forEach(function(st){
    if (!st.ready) { o.notBuilt++; return; }
    var c = card(pal, st);
    if (!c || c.due === null) o.nw++;
    else if (c.due === t) o.due++;
    else if (c.due < t) o.overdue++;
    else if (o.next === null || c.due < o.next) o.next = c.due;
  });
  o.work = o.due + o.overdue + o.nw;
  return o;
}
function total(){ return palaces().reduce(function(s, p){ return s + (isRetired(p.id) ? 0 : stats(p).work); }, 0); }
function nextLabel(o){
  if (o.work) return 'today';
  if (o.next === null) return 'not scheduled';
  return (o.next === today() + 1 ? 'tomorrow, ' : '') + fmtDay(o.next);
}
function dateChip(pid){
  var tk = dateDay(pid); if (tk === null) return 'No date';
  var n = tk - today();
  return (T.kindOf(tagsOf(pid)) || 'Date') + ' ' + fmtDay(tk) + ' - ' + (n > 0 ? plural(n, 'day') : n === 0 ? 'today' : 'done ' + plural(-n, 'day') + ' ago');
}
/* No book or cap icon exists in the sprite, so Exam shares the mic with Talk; anything else gets the calendar. */
function kindIcon(pid){ return T.kindOf(tagsOf(pid)) ? 'mic' : 'calendar'; }

/* ---------- nav ---------- */
function jumpOption(){ return '<option value="' + TOK + '"' + (S.screen === 9 ? ' selected' : '') + '>Practice &middot; Review</option>'; }
function renderRail(){
  var a = $('#rail-review'), n = total();
  if (S.screen === 9) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  $('#rail-due').innerHTML = n ? n + '<span class="sr-only"> due</span>' : '';
}
/* Arriving on Review always opens the palace list; leaving restores the single-palace name in the top bar. */
window.addEventListener('hashchange', function(){
  var on = location.hash === '#' + TOK;
  if (on) { RV = null; S.st[9] = 'list'; UI = {adding:null, addText:'', confirm:null}; }
  else $('.palace-name').innerHTML = PALACE_NAME;
});

/* ---------- list ---------- */
/* Tag chips with a two-step remove, plus the '+ Tag' button or its open input. Tag text is user data: esc() everywhere. */
function tagsHtml(pal){
  var pid = esc(pal.id), name = esc(pal.name), c = UI.confirm;
  var chips = tagsOf(pal.id).map(function(tag){
    var tg = esc(tag);
    if (c && c.pid === pal.id && c.tag === tag) {
      return '<span class="rv-chip rv-confirm"><span class="rv-chip-t" id="rv-cq">Remove ' + tg + '?</span>' +
        '<button class="btn btn-danger" type="button" data-act="rv-untag-yes" aria-describedby="rv-cq">Remove</button>' +
        '<button class="btn" type="button" id="rv-untag-no" data-act="rv-untag-no" aria-describedby="rv-cq">Keep</button></span>';
    }
    return '<span class="rv-chip"><span class="rv-chip-t">' + tg + '</span><button class="rv-chip-x" type="button" data-act="rv-untag" data-pal="' + pid +
      '" data-tag="' + tg + '" aria-label="Remove tag ' + tg + ' from ' + name + '">' + icon('x') + '</button></span>';
  }).join('');
  var add = UI.adding !== pal.id ? '<button class="btn rv-tag-add" type="button" data-act="rv-addtag" data-pal="' + pid + '" aria-label="Add tag to ' + name + '">+ Tag</button>' :
    '<span class="rv-addtag"><input type="text" class="rv-tag-input" id="rv-tag-in" data-pal="' + pid + '" list="rv-tag-list" autocomplete="off" aria-label="New tag for ' + name +
    '" aria-describedby="rv-tag-msg" value="' + esc(UI.addText) + '"><span class="field-err rv-tag-msg" id="rv-tag-msg" aria-live="polite"></span></span>';
  return '<div class="rv-tags"><span class="rv-tags-h">Tags</span><div class="rv-chips" role="group" aria-label="Tags for ' + name + '">' + chips + add + '</div></div>';
}
function row(r){
  var pal = r.pal, o = stats(pal), t = today(), tk = dateDay(pal.id), ret = isRetired(pal.id), pid = esc(pal.id), nn = noun(pal.id);
  var after = tk !== null && t > tk, eve = tk !== null && t === tk - 1, can = o.work > 0 && !ret;
  var btn = function(cls, label, ic){ return '<button class="btn ' + cls + '" type="button" data-act="' + cls + '" data-pal="' + pid + '">' + (ic ? icon(ic) : '') + label + '</button>'; };
  var html = '<li class="rv-row' + (ret ? ' retired' : '') + '" data-palace="' + pid + '"><div class="rv-head"><div class="rv-title">' +
    '<h2 class="rv-name">' + esc(pal.name) + (pal.demo ? ' <span class="tag">Demo</span>' : '') + '</h2>' +
    '<span class="rv-talk' + (eve || tk === t ? ' soon' : '') + '">' + icon(tk === null ? 'calendar' : kindIcon(pal.id)) + esc(dateChip(pal.id)) + '</span></div>' +
    (pal.demo ? '' : '<a class="btn rv-open" href="#walk">' + icon('walk') + 'Open palace</a>') + '</div>' +
    '<dl class="rv-counts"><div><dt>Due</dt><dd class="rv-due">' + o.due + '</dd></div><div' + (o.overdue ? ' class="late"' : '') + '><dt>Overdue</dt><dd class="rv-overdue">' + o.overdue + '</dd></div>' +
    '<div><dt>New</dt><dd class="rv-new">' + o.nw + '</dd></div><div><dt>Next review</dt><dd class="rv-next">' + esc(ucFirst(nextLabel(o))) + '</dd></div></dl>';
  if (o.notBuilt) html += '<p class="rv-warn">' + icon('alert') + '<a class="rv-notbuilt" href="#walk">' + plural(o.notBuilt, 'stop') + ' not built</a><span class="hint">Make their scenes and they join your reviews.</span></p>';
  if (ret) html += '<div class="rv-decide"><p><strong>Retired.</strong> Reviews for this palace are paused.</p><div class="btn-row">' + btn('rv-unretire', 'Resume reviews', 'refresh') + '</div></div>';
  else if (after) html += '<div class="rv-decide"><p><strong>The ' + nn + ' is done.</strong> Keep reviewing so it stays with you, or retire the palace and pause its reviews.</p>' +
    '<div class="btn-row">' + btn('rv-keep', 'Keep reviewing', 'refresh') + btn('rv-retire', 'Retire') + '</div></div>';
  else if (eve) html += '<div class="rv-callout"><p><strong>Your ' + nn + ' is tomorrow.</strong> Run every point once' + (nn === 'talk' ? ', then say the whole speech out loud.' : ' more.') + '</p><div class="btn-row">' +
    btn('rv-all', 'Dress rehearsal: review all', 'play') + (pal.demo ? '' : '<a class="btn" href="#recite">' + icon('mic') + 'Recite out loud</a>') + '</div></div>';
  return html + '<div class="rv-foot"><div class="rv-date"><label for="rv-date-' + pid + '">Date</label>' +
    '<input type="date" class="rv-talk-date" id="rv-date-' + pid + '" data-pal="' + pid + '" aria-label="' + esc(pal.name) + ' date" value="' + (tk === null ? '' : isoDay(tk)) + '"></div>' +
    tagsHtml(pal) + '<button class="btn btn-primary rv-start" type="button" data-act="rv-start" data-pal="' + pid + '"' + (can ? '' : ' disabled') + '>' + icon('play') +
    (can ? 'Start review &middot; ' + o.work : 'Nothing due') + '</button></div></li>';
}
/* Sort select + single-select tag filter. Counts cover every palace, so the filter can never empty the list. */
function viewHtml(counts, all){
  var v = S.rvView, chip = function(tag, label, n){
    return '<button class="rv-fchip" type="button" data-act="rv-filter"' + (tag === null ? '' : ' data-tag="' + esc(tag) + '"') + ' aria-pressed="' + (v.tag === tag) + '">' +
      label + ' <span class="rv-fn">(' + n + ')</span></button>';
  };
  return '<div class="rv-view"><div class="rv-sort"><label for="rv-sort">Sort by</label><select id="rv-sort">' + T.SORTS.map(function(s){
    return '<option value="' + s + '"' + (v.sort === s ? ' selected' : '') + '>' + SORT_LABELS[s] + '</option>';
  }).join('') + '</select></div><div class="rv-filter" role="group" aria-label="Filter by tag">' + chip(null, 'All', all) +
    counts.map(function(c){ return chip(c.tag, esc(c.tag), c.count); }).join('') + '</div></div>';
}
function renderList(){
  syncCards();
  var t = today(), all = palaces().map(function(p){
    return {id:p.id, name:p.name, date:dateDay(p.id), tags:tagsOf(p.id), work:isRetired(p.id) ? 0 : stats(p).work, retired:isRetired(p.id), pal:p};
  });
  var counts = T.tagCounts(all), inUse = counts.map(function(c){ return c.tag; }), v = S.rvView = T.normView(S.rvView, inUse);
  A.save();
  var inp = $('#rv-tag-in'); if (inp) UI.addText = inp.value;
  var shown = T.filterRows(all, v.tag), body = v.sort !== 'tag' ? T.sortPalaces(shown, v.sort, t).map(row).join('') : T.groupPalaces(shown, t).map(function(g){
    return '<li class="rv-group"><h2>' + (g.tag === null ? 'No tag' : esc(g.tag)) + '</h2></li>' + g.rows.map(row).join('');
  }).join('');
  var sugg = T.KINDS.concat(inUse.filter(function(x){ return T.KINDS.indexOf(x) < 0; }));
  var n = total(), active = all.filter(function(r){ return !r.retired; }).length;
  $('#rv-list').innerHTML = '<div class="panel"><p class="rv-total-line"><span class="rv-big" id="rv-total">' + n + '</span><span>' + (n === 1 ? 'card' : 'cards') +
    ' to review today across ' + plural(active, 'palace') + '</span></p>' +
    '<p class="hint">Today is ' + fmtDay(today()) + (S.dayOff ? ' (pretending, ' + plural(S.dayOff, 'day') + ' ahead)' : '') + '.</p>' +
    '<div class="rv-tools"><label class="rv-check"><input type="checkbox" id="rv-shuffle"' + (S.rvShuffle ? ' checked' : '') + '>Shuffle order</label>' +
    '<button class="btn" type="button" id="rv-tomorrow" data-act="rv-tomorrow">' + icon('right') + 'Pretend it\'s tomorrow</button>' +
    (S.dayOff ? '<button class="btn btn-quiet" type="button" id="rv-today" data-act="rv-today">Back to today</button>' : '') + '</div></div>' +
    viewHtml(counts, all.length) + '<ul class="rv-rows" aria-label="Palaces">' + body + '</ul>' +
    '<datalist id="rv-tag-list">' + sugg.map(function(x){ return '<option value="' + esc(x) + '"></option>'; }).join('') + '</datalist>';
  A.renderNav();
}
function focusRow(pid, cls){ var b = $('.rv-row[data-palace="' + pid + '"] .' + cls); if (b && !b.disabled) { b.focus(); return true; } return false; }
/* Tag values can hold quotes or markup, so match on decoded data-tag values instead of building a selector from them. */
function focusTagged(sel, tag){
  [].some.call(document.querySelectorAll(sel), function(b){ var bt = b.hasAttribute('data-tag') ? b.dataset.tag : null; if (bt === tag) b.focus(); return bt === tag; });
}
function commitTag(inp){
  var pid = inp.dataset.pal; if (IDS.indexOf(pid) < 0) return;
  var r = T.addTag(tagsOf(pid), inp.value, allTags());
  if (r.error) { $('#rv-tag-msg').textContent = r.error; return; }
  S.tags[pid] = r.list; UI.adding = null; UI.addText = '';
  renderList(); focusRow(pid, 'rv-tag-add');
  $('#rv-live').textContent = 'Tagged ' + palace(pid).name + ' ' + r.list[r.list.length - 1] + '.';
}
function cancelAdd(pid){ UI.adding = null; UI.addText = ''; renderList(); focusRow(pid, 'rv-tag-add'); }
function cancelUntag(){ var c = UI.confirm; UI.confirm = null; renderList(); focusTagged('.rv-row[data-palace="' + c.pid + '"] .rv-chip-x', c.tag); }
function untag(){
  var c = UI.confirm, list = tagsOf(c.pid).slice(), ix = list.indexOf(c.tag);
  UI.confirm = null;
  if (ix >= 0) { list.splice(ix, 1); S.tags[c.pid] = list; }
  renderList(); focusRow(c.pid, 'rv-tag-add');
  if (ix < 0) return;
  A.toast('Removed tag ' + c.tag + ' from ' + palace(c.pid).name + '.', function(){
    var cur = tagsOf(c.pid).slice();
    if (T.addTag(cur, c.tag, cur).error) return;   // re-added meanwhile, or the palace is full
    cur.splice(Math.min(ix, cur.length), 0, c.tag); S.tags[c.pid] = cur;
    if (S.screen === 9 && S.st[9] === 'list') { renderList(); focusTagged('.rv-row[data-palace="' + c.pid + '"] .rv-chip-x', c.tag); } else A.save();
  });
}
function setRetired(pid, on){
  var i = S.retired.indexOf(pid);
  if (on && i < 0) S.retired.push(pid);
  if (!on && i >= 0) S.retired.splice(i, 1);
  if (S.screen === 9 && S.st[9] === 'list') renderList(); else A.save();
}
function retire(pid){
  if (isRetired(pid)) return;
  setRetired(pid, true); focusRow(pid, 'rv-unretire');
  A.toast('Retired ' + palace(pid).name + '. Its reviews are paused.', function(){ setRetired(pid, false); focusRow(pid, 'rv-retire'); });
}

/* ---------- session ---------- */
function shuffle(a){ for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
function start(pid, all){
  if (IDS.indexOf(pid) < 0 || isRetired(pid)) return;
  syncCards();
  var t = today(), cs = S.review[pid];
  var q = palace(pid).stops.filter(function(st){ return st.ready && (all || cs[st.id].due === null || cs[st.id].due <= t); })
    .map(function(st){ return {id:st.id, relearn:false}; });
  if (!q.length) return;
  RV = {pid:pid, queue:S.rvShuffle ? shuffle(q) : q, pos:0, shown:false};
  S.st[9] = 'session'; A.applyState(9); renderSession(); $('#rv-show').focus();
}
function back(pal, st){
  if (pal.demo) return DEMO[IDS.indexOf(pal.id) - 1].pts[st.n - 1];
  var id = +st.id, ix = st.n - 1, p = A.P(id);
  return {label:p.label, scene:A.sceneText(id, ix), quote:p.quote, cue:A.walkCue(id, ix)};
}
function renderSession(){
  var pal = palace(RV.pid), it = RV.queue[RV.pos], st = pal.stops.filter(function(s){ return s.id === it.id; })[0];
  var t = today(), c = S.review[pal.id][it.id], pv = Sched.preview(c, t, dateDay(pal.id)), b = back(pal, st), box = st.box, vb = A.cropVB(0, box), anyCap = false, nn = noun(pal.id);
  RV.shown = false;
  var grades = GRADES.map(function(name, i){
    var g = i + 1, capped = !it.relearn && pv[g].capped;
    // Again always comes back within this session; a re-queued card keeps the date its Again already set.
    var ivl = g === 1 ? Sched.fmtIvl(0) : Sched.fmtIvl(it.relearn ? c.due - t : pv[g].ivl);
    anyCap = anyCap || capped;
    return '<button class="btn rv-grade" type="button" data-act="rv-grade" data-grade="' + g + '"><span>' + name + '</span><span class="rv-ivl">' + esc(ivl) +
      (capped ? ' <span class="rv-eve">eve of ' + nn + '</span>' : '') + '</span><kbd class="rv-key" aria-hidden="true">' + g + '</kbd></button>';
  }).join('');
  var rect = function(cls){ return '<rect class="' + cls + '" vector-effect="non-scaling-stroke" x="' + (box[0] - 6) + '" y="' + (box[1] - 6) + '" width="' + (box[2] + 12) + '" height="' + (box[3] + 12) + '" rx="10"/>'; };
  var ov = '<svg class="ov" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><g class="on">' + rect('o-under') + rect('o-line') + '</g>' +
    A.pinSVG(box[0] - 6, box[1] - 6, st.n, vb[2] * 0.04, 'on') + '</svg>';
  $('#rv-session').innerHTML = '<div class="panel rv-card"><div class="rv-top"><p class="eyebrow">' + esc(pal.name) + ' &middot; ' + (S.rvShuffle ? 'shuffled' : 'route order') + '</p>' +
    '<p class="rv-progress" id="rv-progress">' + (RV.pos + 1) + ' of ' + RV.queue.length + '</p></div>' +
    '<div class="bar" aria-hidden="true"><span style="width:' + Math.round(RV.pos / RV.queue.length * 100) + '%"></span></div>' +
    '<div class="rv-front"><div class="frame ar-43" role="img" aria-label="Close crop of place ' + st.n + ', the ' + esc(st.place) + '">' +
    A.photo(vb.join(' '), pal.demo ? 'tinted' : '', pal.demo ? pal.hue : undefined) + ov + '</div>' +
    '<p class="rv-where"><span class="num" id="rv-place-no">' + st.n + '</span><span id="rv-place">' + esc(st.place) + '</span></p>' +
    '<p class="hint">Which point did you leave here? Say it, then check.</p></div>' +
    '<button class="btn btn-primary rv-show" type="button" id="rv-show" data-act="rv-show">' + icon('eye') + 'Show answer<kbd class="rv-key" aria-hidden="true">Space</kbd></button>' +
    '<div class="rv-answer" id="rv-answer" tabindex="-1" hidden><p class="eyebrow">The point</p><h2 class="rv-label">' + esc(b.label) + '</h2>' +
    '<p class="scene-text">' + esc(b.scene) + '</p><blockquote class="quote">&ldquo;' + esc(b.quote) + '&rdquo;</blockquote>' +
    '<div class="cue">' + icon('walk') + '<p><strong>Walk cue.</strong> ' + esc(b.cue) + '</p></div>' +
    '<p class="hint">How well did you remember it? Keys 1 to 4 work too.</p><div class="rv-grades" role="group" aria-label="Grade your recall">' + grades + '</div>' +
    (anyCap ? '<p class="hint">Marked intervals are shortened so your last review lands on the eve of the ' + nn + '.</p>' : '') + '</div></div>' +
    '<div class="btn-row"><button class="btn" type="button" data-act="rv-list">' + icon('left') + 'End session</button></div>';
}
function show(){
  if (!RV || RV.shown) return;
  RV.shown = true; $('#rv-show').hidden = true;
  var a = $('#rv-answer'); a.hidden = false; a.focus();
}
function grade(g){
  if (!RV || !RV.shown) return;
  var sess = RV, it = sess.queue[sess.pos], cs = S.review[sess.pid], t = today(), pal = palace(sess.pid);
  var snap = {sess:sess, pid:sess.pid, id:it.id, card:JSON.stringify(cs[it.id]), queue:JSON.stringify(sess.queue), pos:sess.pos};
  var label = back(pal, pal.stops.filter(function(s){ return s.id === it.id; })[0]).label;
  var r = Sched.grade(cs[it.id], g, t, dateDay(sess.pid), it.relearn);
  cs[it.id] = r.card;
  if (r.requeue) sess.queue.push({id:it.id, relearn:true});
  sess.pos++; A.save(); A.renderNav();
  if (sess.pos < sess.queue.length) { renderSession(); $('#rv-show').focus(); }
  else { S.st[9] = 'done'; A.applyState(9); renderDone(); $('#rv-done-h').focus(); }
  A.toast(GRADES[g - 1] + ': ' + label + (r.requeue ? '. It comes back in a minute.' : '. Next review in ' + Sched.fmtIvl(r.card.due - t) + '.'), function(){ undo(snap); });
}
/* Undo puts the card back as it was and, if that session is still on screen, returns to the same card and queue position. */
function undo(snap){
  S.review[snap.pid][snap.id] = JSON.parse(snap.card); A.save(); A.renderNav();
  if (S.screen !== 9) return;
  if (RV === snap.sess) {
    RV.queue = JSON.parse(snap.queue); RV.pos = snap.pos;
    S.st[9] = 'session'; A.applyState(9); renderSession(); $('#rv-show').focus();
  } else if (S.st[9] === 'list') renderList();
}
function renderDone(){
  var pals = palaces().filter(function(p){ return RV ? p.id === RV.pid : !isRetired(p.id); });
  var o = pals.reduce(function(a, p){ var s = stats(p); return {work:a.work + s.work, next:s.next === null ? a.next : a.next === null ? s.next : Math.min(a.next, s.next)}; }, {work:0, next:null});
  var tk = RV ? dateDay(RV.pid) : null, eve = RV && RV.pid === 'elm' && tk !== null && today() === tk - 1;
  $('#rv-done').innerHTML = '<div class="panel rv-donep"><h2 id="rv-done-h" tabindex="-1">' + icon('check') + '<span>All caught up - next review ' + esc(nextLabel(o)) + '</span></h2>' +
    '<p class="hint">Short daily reviews beat one long cram. Come back when the next cards are due.</p>' +
    '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="rv-list">' + icon('left') + 'Back to palaces</button>' +
    (eve ? '<a class="btn" href="#recite">' + icon('mic') + 'Recite out loud</a>' : '') + '</div></div>';
}

/* ---------- state bar + render ---------- */
function setState(st){
  if (st === 'list') { RV = null; renderList(); }
  else if (st === 'session') {
    if (RV && RV.pos < RV.queue.length) { renderSession(); return; }
    syncCards();
    var pal = palaces().filter(function(p){ return !isRetired(p.id) && stats(p).work; })[0];
    if (pal) start(pal.id, false); else { RV = null; S.st[9] = 'done'; A.applyState(9); renderDone(); }
  }
  else if (st === 'done') renderDone();
}
function render(){ $('.palace-name').innerHTML = '&middot; Review: all palaces'; setState(S.st[9]); }

/* ---------- events ---------- */
document.addEventListener('click', function(e){
  var t = e.target.closest('[data-act^="rv-"]'); if (!t || t.disabled) return;
  var pid = t.dataset.pal;
  switch (t.dataset.act) {
    case 'rv-start': start(pid, false); break;
    case 'rv-all': start(pid, true); break;
    case 'rv-show': show(); break;
    case 'rv-grade': grade(+t.dataset.grade); break;
    case 'rv-list': RV = null; S.st[9] = 'list'; A.applyState(9); renderList(); $('#t9').focus(); break;
    case 'rv-tomorrow':
    case 'rv-today':
      S.dayOff = t.dataset.act === 'rv-today' ? 0 : S.dayOff + 1; renderList(); $('#rv-tomorrow').focus();
      $('#rv-live').textContent = 'Showing reviews for ' + fmtDay(today()) + '.'; break;
    case 'rv-keep':
      delete S.dates[pid]; renderList(); if (!focusRow(pid, 'rv-start')) focusRow(pid, 'rv-talk-date');
      $('#rv-live').textContent = 'Kept ' + palace(pid).name + ' in your reviews, with no date.'; break;
    case 'rv-retire': retire(pid); break;
    case 'rv-unretire': setRetired(pid, false); focusRow(pid, 'rv-talk-date'); break;
    case 'rv-filter':
      var tag = t.hasAttribute('data-tag') ? t.dataset.tag : null;
      S.rvView.tag = S.rvView.tag === tag ? null : tag; renderList(); focusTagged('#rv-list .rv-fchip', tag); break;
    case 'rv-addtag':
      if (IDS.indexOf(pid) < 0) break;
      UI.adding = pid; UI.addText = ''; renderList(); $('#rv-tag-in').focus(); break;
    case 'rv-untag':
      if (IDS.indexOf(pid) < 0 || tagsOf(pid).indexOf(t.dataset.tag) < 0) break;
      UI.confirm = {pid:pid, tag:t.dataset.tag}; renderList(); $('#rv-untag-no').focus(); break;
    case 'rv-untag-yes': if (UI.confirm) untag(); break;
    case 'rv-untag-no': if (UI.confirm) cancelUntag(); break;
  }
});
document.addEventListener('change', function(e){
  if (e.target.id === 'rv-shuffle') S.rvShuffle = e.target.checked;
  if (e.target.id === 'rv-sort') {
    if (T.SORTS.indexOf(e.target.value) >= 0) S.rvView.sort = e.target.value;
    renderList(); $('#rv-sort').focus(); return;
  }
  if (!e.target.classList.contains('rv-talk-date')) return;
  var pid = e.target.dataset.pal; if (IDS.indexOf(pid) < 0) return;
  if (parseIso(e.target.value) === null) delete S.dates[pid]; else S.dates[pid] = e.target.value;
  renderList(); focusRow(pid, 'rv-talk-date');
});
/* Add-tag input: Enter commits, Escape cancels; Escape anywhere in the list also backs out of a pending tag remove. */
$('#rv-list').addEventListener('keydown', function(e){
  if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
  if (e.target.id === 'rv-tag-in') {
    e.preventDefault();
    if (e.key === 'Enter') commitTag(e.target); else cancelAdd(e.target.dataset.pal);
  } else if (e.key === 'Escape' && UI.confirm) { e.preventDefault(); cancelUntag(); }
});
/* Space/Enter reveal, 1-4 grade. preventDefault stops a focused button from also firing its own click on the same key. */
$('#s9').addEventListener('keydown', function(e){
  if (S.st[9] !== 'session' || !RV || e.target.matches('input,textarea,select') || e.ctrlKey || e.metaKey || e.altKey) return;
  var reveal = (e.key === ' ' || e.key === 'Enter') && !RV.shown && (e.target.id === 'rv-show' || !e.target.closest('button,a'));
  var rate = RV.shown && /^[1-4]$/.test(e.key);
  if (!reveal && !rate) return;
  e.preventDefault();
  if (e.repeat) return;
  if (reveal) show(); else grade(+e.key);
});

return {TOK:TOK, load:load, render:render, setState:setState, jumpOption:jumpOption, renderRail:renderRail};
};
