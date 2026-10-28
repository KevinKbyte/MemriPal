(function(){
'use strict';

/* Every object the segmentation scan found; the label doubles as the id. The first 10 are the default places. */
var OBJECTS = [
  {label:'door',          conf:.97, kind:'fixture',   box:[26,126,118,318]},
  {label:'left books',    conf:.95, kind:'furniture', box:[156,146,128,298]},
  {label:'window',        conf:.96, kind:'fixture',   box:[294,74,182,172]},
  {label:'plant',         conf:.93, kind:'decor',     box:[280,280,120,164]},
  {label:'clock',         conf:.91, kind:'wall',      box:[484,84,72,72]},
  {label:'painting',      conf:.94, kind:'wall',      box:[584,84,172,112]},
  {label:'lamp',          conf:.92, kind:'light',     box:[692,222,86,222]},
  {label:'armchair',      conf:.96, kind:'furniture', box:[514,294,180,150]},
  {label:'mug',           conf:.88, kind:'small',     box:[426,328,52,50]},
  {label:'rug',           conf:.90, kind:'floor',     box:[226,458,348,84]},
  {label:'side table',    conf:.84, kind:'furniture', box:[402,366,106,76]},
  {label:'light switch',  conf:.71, kind:'wall',      box:[474,242,32,42]},
  {label:'waste basket',  conf:.77, kind:'small',     box:[52,446,64,58]},
  {label:'ceiling light', conf:.69, kind:'light',     box:[620,0,60,72]},
  {label:'photo frame',   conf:.74, kind:'wall',      box:[180,70,80,60]}
];
var KIND = {furniture:'furniture', wall:'small wall items', small:'small objects', floor:'floor areas', light:'lights', fixture:'doors and windows', decor:'plants and decor'};
var DEFAULT_PLACES = OBJECTS.slice(0, 10).map(function(o){ return o.label; });
/* Downstream screens hold this array and read LOCI[ix], so syncLoci refills it in place rather than replacing it. */
var LOCI = [];

var NOTES = "Elm Street tool library - talk to the neighbourhood association, about 5 minutes.\n\n" +
"Open with a question: think of the drill in your garage. When did you last use it?\n" +
"Problem: every garage on this street stores the same ladder, the same hedge trimmer, the same tile saw.\n" +
"Proposal: the old bike shop at 41 Elm has been empty for two years. Let's lend tools from there.\n" +
"How it works: members borrow with a library card, one week at a time, just like books.\n" +
"Cost: fifteen dollars a year per household covers insurance and repairs.\n" +
"Other towns already run tool libraries. We don't need to invent rules; we can copy what works.\n" +
"We need six volunteers for Saturday morning shifts to get started.\n" +
"Once a month, a repair night: bring something broken and we fix it together.\n" +
"The real win: you'll finally meet the people you've waved at for years.\n" +
"The ask: vote yes tonight, and sign the volunteer sheet by the door.";

var CH = [
  {k:'kinesthetic', name:'Kinesthetic'}, {k:'auditory', name:'Auditory'}, {k:'visual', name:'Visual'}, {k:'emotional', name:'Emotional'},
  {k:'conceptual', name:'Conceptual'}, {k:'olfactory', name:'Olfactory'}, {k:'gustatory', name:'Gustatory'}, {k:'spatial', name:'Spatial'}
];

var PTS = [
 {id:1, hue:0, label:'Idle drill', quote:'think of the drill in your garage. When did you last use it?', kw:['drill'],
  scene:'A giant drill lies wedged across the doorway, snoring. Its dust sheet slides off as you shoulder past.',
  ch:{kinesthetic:'Shoulder the heavy, cold drill aside', auditory:'A low, rattling snore from the motor', visual:'Grey dust drifting off it in the doorway light', emotional:'A twinge of guilt: you forgot you owned it', conceptual:'Owned tools mostly sit idle', olfactory:'Stale machine oil', gustatory:'Metallic dust on your tongue', spatial:'Across the door at waist height'},
  cue:'Squeeze past the drill and step right to the bookshelf.', q:'Why open with a question instead of a fact?'},
 {id:2, hue:190, label:'Duplicate ladders', quote:'every garage on this street stores the same ladder', kw:['ladder'],
  scene:'Every book on the shelf is a tiny, identical ladder. Pull one out and ten more clatter to the floor.',
  ch:{kinesthetic:'Tug one ladder; the whole row lurches', auditory:'Aluminium clatter, ten times over', visual:'Rows of matching silver spines', emotional:'Exasperation at the waste', conceptual:'Every household buys the same things', olfactory:'Cold metal and garage dust', gustatory:'Chalky, like biting foil', spatial:'Eye level, filling the left wall'},
  cue:'Follow the falling ladders toward the bright window.', q:'Which item on your street is most duplicated, and how would you say it?'},
 {id:3, hue:160, label:'Empty bike shop', quote:'the old bike shop at 41 Elm has been empty for two years', kw:['bike shop','41 elm','bike'],
  scene:'Through the window you see 41 Elm: dusty bikes in an empty shop and a faded FOR LEASE sign.',
  ch:{kinesthetic:'Press your palm flat on the cool glass', auditory:'A lone bike bell rings inside', visual:'Dusty bikes behind a faded FOR LEASE sign', emotional:'Wistful: a good space going to waste', conceptual:'A real place, ready now', olfactory:'Old rubber tyres', gustatory:'Dry, dusty air', spatial:'Straight ahead, framed by the window'},
  cue:'Look down from the window to the plant on the floor.', q:'Why does naming a real address make the proposal feel possible?'},
 {id:4, hue:100, label:'Library-card loans', quote:'members borrow with a library card, one week at a time', kw:['library card','borrow'],
  scene:'The plant\'s leaves are library cards, each stamped with a due date one week away.',
  ch:{kinesthetic:'Peel off a stiff card-leaf', auditory:'The thunk of a date stamp', visual:'Green cards with red due-date stamps', emotional:'Familiar and easy', conceptual:'Borrowing rules people already know', olfactory:'Fresh soil and paper', gustatory:'A bitter green leaf', spatial:'Below the window, knee height'},
  cue:'Rise from the plant up to the clock on the wall.', q:'How would you explain borrowing to someone who has never used a library?'},
 {id:5, hue:15, label:'$15 a year', quote:'fifteen dollars a year per household covers insurance and repairs', kw:['fifteen','15 dollars','insurance'],
  scene:'The clock has fifteen gold coins for numbers. It ticks only once a year, with a loud ring.',
  ch:{kinesthetic:'Push the heavy hand once around', auditory:'One coin-ring per year', visual:'Fifteen gold coins circling the face', emotional:'Relief: it\'s cheap', conceptual:'One small fee pays insurance and repairs', olfactory:'Brass polish', gustatory:'The tang of a coin', spatial:'High on the wall, above the plant'},
  cue:'Follow the ring of the coin right, to the painting.', q:'What does $15 a year compare to that your audience already pays for?'},
 {id:6, hue:250, label:'Copy what works', quote:'we can copy what works', kw:['copy what works','other towns','copy'],
  scene:'The painting shows other towns\' tool libraries. You trace it onto thin paper, line for line.',
  ch:{kinesthetic:'Pencil gliding as you trace', auditory:'Graphite scratching thin paper', visual:'Tiny tool sheds from other towns', emotional:'Confident: it has been done before', conceptual:'Proven models cut the risk', olfactory:'Pencil shavings', gustatory:'Waxy tracing paper', spatial:'Right of the clock, at head height'},
  cue:'Drop your gaze from the painting to the tall lamp.', q:'Why reassure people that others have done this first?'},
 {id:7, hue:30, label:'Six Saturday volunteers', quote:'We need six volunteers for Saturday morning shifts', kw:['six volunteers','saturday'],
  scene:'Six tiny volunteers hold up the lamp\'s beam like a tent pole, shouting "Saturday!"',
  ch:{kinesthetic:'Lift the warm beam with them', auditory:'Six small voices chanting Saturday', visual:'A pool of light held up by six figures', emotional:'Team spirit', conceptual:'A small, concrete ask: six people', olfactory:'Morning coffee', gustatory:'Buttered toast', spatial:'Right corner, tall, beside the armchair'},
  cue:'Step down out of the light into the armchair.', q:'Who in the room could you name as a likely volunteer?'},
 {id:8, hue:215, label:'Repair night', quote:'Once a month, a repair night', kw:['repair'],
  scene:'The torn armchair stitches itself back together with glowing thread under a full moon.',
  ch:{kinesthetic:'Sink into the cushion as it tightens', auditory:'The zip of thread through fabric', visual:'Glowing seams in moonlight', emotional:'Satisfying: broken made whole', conceptual:'A monthly event builds the habit', olfactory:'Warm fabric and machine oil', gustatory:'Peppermint tea', spatial:'Centre right, sitting height'},
  cue:'Reach left to the mug on the side table.', q:'What broken thing would you bring to the first repair night?'},
 {id:9, hue:320, label:'Meet the neighbours', quote:'you\'ll finally meet the people you\'ve waved at for years', kw:['meet','waved','neighbo'],
  scene:'The mug is full of tiny neighbours, waving at you from the steam.',
  ch:{kinesthetic:'Hands cupped around a warm mug', auditory:'A chorus of small hellos', visual:'Waving figures rising in the steam', emotional:'Warmth and belonging', conceptual:'Community is the real payoff', olfactory:'Cinnamon tea', gustatory:'Sweet, spiced tea', spatial:'Side table, waist height, middle of the room'},
  cue:'Look down at the rug under your feet.', q:'Why save the community benefit until near the end?'},
 {id:10, hue:45, label:'Vote yes tonight', quote:'vote yes tonight, and sign the volunteer sheet by the door', kw:['vote','tonight'],
  scene:'The rug spells YES in huge letters. Stand on the Y and a pen pops up to sign the sheet.',
  ch:{kinesthetic:'Plant both feet on the big Y', auditory:'Applause rising from the floor', visual:'Bold YES woven into the rug', emotional:'Decisive and energised', conceptual:'A clear, two-part call to action', olfactory:'Fresh-cleaned wool', gustatory:'Celebration fizz', spatial:'Centre of the floor, under you'},
  cue:'Turn back to the door, where the volunteer sheet hangs. Walk complete.', q:'What exactly should people do in the first minute after you finish?'}
];
var BASE_TIER = {1:1,2:1,3:1,4:1,5:2,6:3,7:1,8:1,9:2,10:1};
var ORIG = {}; PTS.forEach(function(p,i){ ORIG[p.id] = i; });
var BAD_QUOTE = 'we should copy whatever works elsewhere';

var REPLAY = [
  'Okay. Think of the drill in your garage. When did you last use it?',
  'Every garage on our street has the same ladder, the same trimmer.',
  'We would lend them with a library card, a week at a time.',
  'It costs fifteen dollars a year, which covers insurance.',
  'Other towns already do this, so we can copy what works.',
  'Once a month there would be a repair night.',
  'Mostly, you will finally meet neighbours you have only waved at.',
  'So please vote yes tonight, and sign the sheet by the door.'
];
var REPLAY_MISSES = [
  'The old bike shop at 41 Elm is empty. We can lend from there.',
  'We need six volunteers for Saturday mornings.'
];
var SEED_RUNS = [
  {id:'r3', n:3, when:'Oct 28, 7:42 pm', said:{1:REPLAY[0],2:REPLAY[1],4:REPLAY[2],5:REPLAY[3],6:REPLAY[4],8:REPLAY[5],9:REPLAY[6],10:REPLAY[7]}, manual:{}},
  {id:'r2', n:2, when:'Oct 27, 9:15 pm', said:{1:'think of the drill in your garage', 2:'every garage on this street has the same ladder and trimmer', 4:'borrow with a library card, a week at a time', 5:'fifteen dollars a year covers insurance', 8:'a repair night once a month', 9:'meet the people you have waved at', 10:'vote yes tonight and sign the sheet'}, manual:{}},
  {id:'r1', n:1, when:'Oct 26, 8:05 pm', said:{1:'think of your drill, when did you use it last', 2:'every garage has the same ladder', 5:'fifteen dollars a year', 9:'you will meet your neighbours', 10:'vote yes tonight'}, manual:{6:true}}
];
var STATES = {
  1:[['locked','Locked (public link)'],['live','Live unlocked'],['finding','Finding places'],['error','Error']],
  2:[['found','Found'],['scanning','Scanning'],['toofew','Too few places']],
  3:[['ready','Key points'],['empty','Empty'],['toolarge','Over 20 KB']],
  5:[['list','Points'],['empty','All removed']],
  6:[['running','Progress'],['offline','Connection lost']],
  7:[['ready','Ready'],['listening','Listening'],['denied','Mic denied'],['finished','Finished']],
  8:[['runs','Runs'],['empty','No rehearsals']], 9:[['list','Palaces'],['session','Session'],['done','All caught up'],['empty','No palaces']]
};
var SCREENS = [
  {tok:'photo', name:'Photo'}, {tok:'places', name:'Places'}, {tok:'notes', name:'Notes'}, {tok:'scenes', name:'Scenes'},
  {tok:'route', name:'Route'}, {tok:'walk', name:'Generate & walk'}, {tok:'recite', name:'Recite'}, {tok:'history', name:'History'}
];
var STORE = 'memripal-proto-v1';

function $(s, r){ return (r || document).querySelector(s); }
function $$(s, r){ return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function icon(n, cls){ return '<svg class="i ' + (cls || '') + '" aria-hidden="true" focusable="false"><use href="#i-' + n + '"></use></svg>'; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function P(id){ for (var i = 0; i < PTS.length; i++) if (PTS[i].id === id) return PTS[i]; return null; }
function lcFirst(s){ return s.charAt(0).toLowerCase() + s.slice(1); }
var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var REPLAY_TAG = '<span class="replay">' + icon('replay') + 'Recorded replay</span>';

/* ---------- state ---------- */
function freshData(){
  var gen = {}, sl = {}, tiers = {};
  PTS.forEach(function(p, i){ gen[p.id] = 'ready'; sl[p.id] = i; tiers[p.id] = BASE_TIER[p.id]; });
  gen[3] = 'invalid'; gen[7] = 'missing'; sl[7] = -1;
  return { order: PTS.map(function(p){ return p.id; }), gen: gen, sceneLocus: sl, tiers: tiers, auto: false, genRunning: false,
           runs: JSON.parse(JSON.stringify(SEED_RUNS)), screen: 1, places: DEFAULT_PLACES.slice(), learn: {on:false, log:[], applied:false} };
}
function OBJ(id){ for (var i = 0; i < OBJECTS.length; i++) if (OBJECTS[i].label === id) return OBJECTS[i]; return null; }
function validPlaces(p){ return Array.isArray(p) && p.length === DEFAULT_PLACES.length && p.every(function(id, i){ return !!OBJ(id) && p.indexOf(id) === i; }); }
function validEdit(e){
  if (!e || typeof e !== 'object') return false;
  if (e.t === 'swap') return typeof e.ix === 'number' && !!OBJ(e.from) && !!OBJ(e.to);
  return e.t === 'move' && !!OBJ(e.obj) && typeof e.from === 'number' && typeof e.to === 'number';
}
var S = freshData();
try {
  var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && Array.isArray(saved.order) && saved.gen && saved.sceneLocus && Array.isArray(saved.runs)) {
    Object.keys(S).forEach(function(k){ if (saved[k] !== undefined) S[k] = saved[k]; });
  }
} catch (e) {}
if (!validPlaces(S.places)) S.places = DEFAULT_PLACES.slice();
if (!S.learn || typeof S.learn !== 'object' || !Array.isArray(S.learn.log)) S.learn = {on:false, log:[], applied:false};
S.learn = {on: S.learn.on === true, log: S.learn.log.filter(validEdit), applied: S.learn.applied === true};
function syncLoci(){ LOCI.length = 0; S.places.forEach(function(id){ LOCI.push(OBJ(id)); }); }
syncLoci();
/* Screen 9 (Review) lives in review.js; it reads the review slices from the same saved blob and resets cards whose place changed. */
var REV = MPReview({S:S, LOCI:LOCI, eff:eff, P:P, OBJ:OBJ, sceneText:sceneText, walkCue:walkCue, photo:photo, pinSVG:pinSVG, cropVB:cropVB, toast:toast, save:save, applyState:applyState, renderNav:renderNav, esc:esc, icon:icon});
REV.load(saved);
S.st = {1:'locked',2:'found',3:'ready',5:'list',6:'running',7:'ready',8:'runs',9:'list'};
S.labels = window.matchMedia ? window.matchMedia('(min-width: 600px)').matches : true;
S.sel2 = 0; S.s4 = 0; S.s4tier = 'auto'; S.walk = 0; S.confirm = null; S.runConfirm = null; S.runSel = null;
S.extract = {}; PTS.forEach(function(p){ S.extract[p.id] = 'valid'; });
S.extract[6] = 'invalid'; S.badQuote = true; S.editing = null; S.tab = 'paste';
S.typed = PTS.slice(0, 4).map(function(p){ return p.label; });
S.rc = freshRecall(); S.hide = false; S.genBusy = false; S.resetSnap = null; S.resetConfirm = false;
S.others = false; S.swapIx = null; S.learnConfirm = false;

function freshRecall(){ return { got:{}, said:{}, manual:{}, running:false, token:0, transcript:'', runId:null, answers:{}, started:0 }; }
function save(){
  try { localStorage.setItem(STORE, JSON.stringify({order:S.order, gen:S.gen, sceneLocus:S.sceneLocus, tiers:S.tiers, auto:S.auto, genRunning:S.genRunning, runs:S.runs, screen:S.screen, places:S.places, learn:S.learn, review:S.review, dates:S.dates, tags:S.tags, rvView:S.rvView, dayOff:S.dayOff, retired:S.retired})); } catch (e) {}
}
/* A point keeps its hand-written scene and cue only at its original index AND while that place is still the default object. */
function isOrig(id, ix){ return ix === ORIG[id] && S.places[ix] === DEFAULT_PLACES[ix]; }
function eff(id, ix){
  var g = S.gen[id];
  if (g === 'generating') return 'generating';
  if (g === 'invalid') return 'invalid';
  if (g === 'ready' && S.sceneLocus[id] === ix) return 'ready';
  return 'missing';
}

/* ---------- toast ---------- */
var toastTimer = null;
function toast(msg, undo){
  var t = $('#toast');
  t.innerHTML = '<p>' + esc(msg) + '</p>' + (undo ? '<button class="btn" type="button" id="toast-undo">' + icon('undo') + 'Undo</button>' : '') +
    '<button class="btn btn-quiet icon-btn" type="button" id="toast-close" aria-label="Dismiss message">' + icon('x') + '</button>';
  t.hidden = false;
  var close = function(){ t.hidden = true; clearTimeout(toastTimer); };
  if (undo) $('#toast-undo').onclick = function(){ close(); undo(); };
  $('#toast-close').onclick = close;
  var arm = function(){ clearTimeout(toastTimer); toastTimer = setTimeout(close, 10000); };
  t.onmouseenter = t.onfocusin = function(){ clearTimeout(toastTimer); };
  t.onmouseleave = t.onfocusout = arm;
  arm();
}

/* ---------- navigation ---------- */
function screenFromHash(){
  var h = (location.hash || '').replace('#', '');
  for (var i = 0; i < SCREENS.length; i++) if (SCREENS[i].tok === h) return i + 1;
  return h === REV.TOK ? 9 : 0;
}
function nav(n){ var tok = SCREENS[n - 1].tok; if (location.hash !== '#' + tok) location.hash = tok; else show(n); }
function renderNav(){
  $('#rail-list').innerHTML = SCREENS.map(function(s, i){
    var n = i + 1, cur = n === S.screen;
    var skip = (n === 5 && S.auto) ? '<span class="skip">auto</span>' : '';
    return '<li><a href="#' + s.tok + '"' + (cur ? ' aria-current="step"' : '') + '><span class="num">' + n + '</span>' + s.name + skip + '</a></li>';
  }).join('');
  $('#jump').innerHTML = SCREENS.map(function(s, i){
    return '<option value="' + s.tok + '"' + (i + 1 === S.screen ? ' selected' : '') + '>' + (i + 1) + ' of 8 &middot; ' + s.name + '</option>';
  }).join('') + REV.jumpOption(); REV.renderRail();
}
function show(n, noFocus){
  S.screen = n; save();
  $$('.screen[id^="s"]').forEach(function(s){ if (/^s\d$/.test(s.id)) s.hidden = s.id !== 's' + n; });
  renderNav();
  var r = RENDER[n]; if (r) r();
  if (!noFocus) { var h = $('#t' + n); if (h) h.focus({preventScroll:true}); window.scrollTo(0, 0); }
  if (n === 6 && S.genRunning && !S.genBusy && S.st[6] !== 'offline') runGen();
}
window.addEventListener('hashchange', function(){ var n = screenFromHash(); if (n) show(n); });
$('#jump').addEventListener('change', function(e){ location.hash = e.target.value; });

/* ---------- state bars ---------- */
function renderStatebars(){
  $$('.statebar').forEach(function(b){
    var n = +b.dataset.for;
    b.setAttribute('role', 'group'); b.setAttribute('aria-label', 'Prototype: preview screen state');
    b.innerHTML = '<span class="sb-label">' + icon('eye') + 'Preview state</span>' + STATES[n].map(function(s){
      return '<button type="button" data-act="state" data-s="' + n + '" data-st-val="' + s[0] + '" aria-pressed="' + (S.st[n] === s[0]) + '">' + s[1] + '</button>';
    }).join('');
  });
}
function applyState(n){
  var sec = $('#s' + n), st = S.st[n];
  $$('[data-st]', sec).forEach(function(el){ el.hidden = el.dataset.st.split(' ').indexOf(st) < 0; });
  $$('.statebar button', sec).forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.stVal === st)); });
}
function setState(n, st, fromBar){
  var prev = S.st[n]; S.st[n] = st; applyState(n);
  if (n === 1) { $('#photo').disabled = st !== 'live'; if (fromBar && st === 'finding') { $('#user-photo').hidden = true; } }
  if (n === 2) renderLoci();
  if (n === 6) { if (st === 'offline') { S.genPaused = true; } renderGen(); }
  if (n === 7 && fromBar) {
    stopReplay();
    if (st === 'ready') { S.rc = freshRecall(); renderTiles(); $('#strip').innerHTML = ''; }
    if (st === 'listening') { startRecital('full'); return; }
    if (st === 'finished' && !Object.keys(S.rc.got).length && !Object.keys(S.rc.manual).length) { demoFill(); }
    if (st === 'finished') { finishRun(); renderEnd(); }
    if (st === 'denied') { S.rc = freshRecall(); renderTiles(); }
  }
  if (n === 8) renderHistory();
  if (n === 9) REV.setState(st);
  if (n === 5) renderRoute();
  if (n === 3) renderKP();
  return prev;
}

/* ---------- room helpers ---------- */
function buildBooks(){
  var g = document.getElementById('books'), pal = ['#8E3B2F','#2F5D7C','#C49A3A','#4C7A4C','#6B4C7A','#D8D0C0','#A65E2E'];
  var bottoms = [208, 266, 324, 382, 432], seed = 3, out = '';
  bottoms.forEach(function(b){
    var x = 169;
    while (x < 262) {
      seed = (seed * 37 + 11) % 101;
      var w = 8 + seed % 8, h = 30 + seed % 17;
      if (x + w > 271) break;
      out += '<rect x="' + x + '" y="' + (b - h) + '" width="' + (w - 1) + '" height="' + h + '" fill="' + pal[seed % pal.length] + '"/>';
      x += w + (seed % 5 === 0 ? 4 : 1);
    }
  });
  g.innerHTML = out;
}
function photo(vb, cls, hue){
  return '<svg class="photo ' + (cls || '') + '" viewBox="' + vb + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"' + (hue !== undefined ? ' style="--h:' + hue + 'deg"' : '') + '><use href="#room" width="800" height="560"></use></svg>';
}
function cropVB(ix, box){
  var b = box || LOCI[ix].box, aspect = 4 / 3, cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
  var W = Math.max(b[2] * 1.8, 220), H = Math.max(b[3] * 1.8, 165);
  if (W / H < aspect) W = H * aspect; else H = W / aspect;
  if (H > 560) { H = 560; W = H * aspect; }
  var x0 = clamp(cx - W / 2, 0, 800 - W), y0 = clamp(cy - H / 2, 0, 560 - H);
  return [x0, y0, W, H].map(function(v){ return Math.round(v); });
}
function pinSVG(x, y, n, r, cls){
  r = r || 18;
  var px = clamp(x, r + 2, 800 - r - 2), py = clamp(y, r + 2, 560 - r - 2);
  return '<g class="pin ' + (cls || '') + '"><circle cx="' + px + '" cy="' + py + '" r="' + r + '"/><text x="' + px + '" y="' + (py + r * 0.36) + '" text-anchor="middle" style="font-size:' + Math.round(r * 1.05) + 'px">' + n + '</text></g>';
}
function sparkles(cx, cy, s){
  var o = '';
  for (var k = 0; k < 7; k++) {
    var a = k * 0.9 + 0.4, rr = s * (0.55 + (k % 3) * 0.08);
    o += '<circle class="spark" cx="' + Math.round(cx + Math.cos(a) * rr) + '" cy="' + Math.round(cy + Math.sin(a) * rr) + '" r="' + (s * (0.012 + (k % 2) * 0.01)).toFixed(1) + '"/>';
  }
  return o;
}

/* ---------- screen 2: loci ---------- */
function unusedObjects(){ return OBJECTS.filter(function(o){ return S.places.indexOf(o.label) < 0; }).sort(function(a, b){ return b.conf - a.conf; }); }
function pct(o){ return Math.round(o.conf * 100) + '%'; }
function lociOverlay(count, sel, labels, cands){
  var list = LOCI.slice(0, count), o = '<svg class="ov" viewBox="0 0 800 560" aria-hidden="true" focusable="false">', lbls = '', chips = '', taken = [];
  list.forEach(function(l){ taken.push([l.box[0] - 20, l.box[1] - 20, 40, 40]); });
  if (labels) list.forEach(function(l){
    var b = l.box, w = l.label.length * 10.5 + 18, x = b[0] + 24, y = b[1] - 13;
    if (x + w > 796) x = b[0] - 24 - w;
    if (y < 4) y = b[1] + 8;
    taken.push([x, y, w, 28]);
    lbls += '<g class="lbl"><rect x="' + x + '" y="' + y + '" width="' + w + '" height="28" rx="6"/><text x="' + (x + 9) + '" y="' + (y + 20) + '">' + esc(l.label) + '</text></g>';
  });
  function hits(x, y, w){
    return taken.some(function(t){ return x < t[0] + t[2] + 2 && x + w + 2 > t[0] && y < t[1] + t[3] + 2 && y + 26 > t[1]; });
  }
  (cands || []).forEach(function(c){
    // Chips go below, above, then inside the box, sliding sideways to stay clear of pins, place labels and other chips.
    var b = c.box, txt = c.label + ' ' + pct(c), w = Math.round(txt.length * 9.6 + 16), spots = [], pick = null;
    [b[1] + b[3] + 4, b[1] - 28, b[1] + 4].forEach(function(y){
      if (y < 2 || y + 24 > 558) return;
      [0, 1, -1, 2, -2, 3, -3].forEach(function(k){ spots.push([clamp(b[0] + k * 40, 4, 796 - w), y]); });
    });
    spots.some(function(s){ return !hits(s[0], s[1], w) && (pick = s); });
    pick = pick || spots[0] || [clamp(b[0], 4, 796 - w), clamp(b[1] + 4, 2, 532)];
    taken.push([pick[0], pick[1], w, 24]);
    o += '<rect class="cand" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="8"/>';
    chips += '<g class="clbl"><rect x="' + pick[0] + '" y="' + pick[1] + '" width="' + w + '" height="24" rx="6"/><text x="' + (pick[0] + 8) + '" y="' + (pick[1] + 17) + '">' + esc(txt) + '</text></g>';
  });
  o += '<polyline class="route-line" points="' + list.map(function(l){ return (l.box[0] + l.box[2] / 2) + ',' + (l.box[1] + l.box[3] / 2); }).join(' ') + '"/>';
  // All outlines first, then all pins, so a later place's outline never paints over an earlier pin.
  list.forEach(function(l, i){
    var b = l.box, on = sel === i ? 'on' : '';
    o += '<g class="' + on + '"><rect class="o-under" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="10"/><rect class="o-line" x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="10"/></g>';
  });
  list.forEach(function(l, i){ o += pinSVG(l.box[0], l.box[1], i + 1, 18, sel === i ? 'on' : ''); });
  return o + lbls + chips + '</svg>';
}
function renderLoci(){
  var st = S.st[2], count = st === 'found' ? 10 : (st === 'scanning' ? 7 : 6), found = st === 'found';
  var fig = $('#loci-fig'), unused = unusedObjects(), cands = found && (S.others || S.swapIx !== null) ? unused : [];
  fig.innerHTML = photo('0 0 800 560') + lociOverlay(count, found ? S.sel2 : -1, S.labels, cands) +
    (st === 'scanning' ? '<div class="scanline" aria-hidden="true"></div><p class="scan-msg">' + icon('loader', 'spin') + 'Outlining objects: 7 of 10</p>' : '');
  fig.classList.toggle('scan', st === 'scanning');
  // Fit each label box to its measured text so left and right padding match (layout above only estimates width).
  [['.clbl', 16], ['.lbl', 18]].forEach(function(p){
    fig.querySelectorAll('.ov ' + p[0]).forEach(function(g){
      var t = g.querySelector('text'), len = t && t.getComputedTextLength();
      if (len) g.querySelector('rect').setAttribute('width', Math.ceil(len + p[1]));
    });
  });
  fig.setAttribute('aria-label', 'Room photo with ' + count + ' numbered outlines: ' + LOCI.slice(0, count).map(function(l, i){ return (i + 1) + ' ' + l.label; }).join(', ') + '.' +
    (cands.length ? ' Dashed outlines show ' + cands.length + ' other objects: ' + cands.map(function(c){ return c.label; }).join(', ') + '.' : ''));
  $('#t2').textContent = found ? '10 places found' : (st === 'scanning' ? 'Finding places' : 'Not enough places');
  var isDefault = S.places.join('|') === DEFAULT_PLACES.join('|');
  $('#loci-lede').textContent = isDefault ? 'Numbered in walking order. Start at the door and go clockwise around the room.' : 'Numbered in walking order. Start at the ' + LOCI[0].label + ' and follow the numbers.';
  var n = LOCI.length;
  $('#loci-list').innerHTML = LOCI.map(function(l, i){
    var open = S.swapIx === i, lb = esc(l.label);
    var row = '<div class="lrow"><button class="loci-sel" type="button" data-act="sel-locus" data-i="' + i + '" aria-pressed="' + (S.sel2 === i) + '"><span class="num">' + (i + 1) + '</span><span class="lname">' + lb + '</span></button>' +
      '<button class="btn icon-btn" type="button" data-act="place-up" data-i="' + i + '" aria-label="Move ' + lb + ' earlier"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
      '<button class="btn icon-btn" type="button" data-act="place-down" data-i="' + i + '" aria-label="Move ' + lb + ' later"' + (i === n - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>' +
      '<button class="btn lswap" type="button" data-act="swap" data-i="' + i + '" aria-expanded="' + open + '" aria-label="Swap ' + lb + ' for another object">Swap</button></div>';
    var pick = open ? '<div class="picker" role="group" aria-labelledby="pk-' + i + '"><p id="pk-' + i + '"><strong>Pick an object to replace ' + (i + 1) + ' ' + lb + '</strong></p><div class="picker-opts">' +
      unused.map(function(o){ return '<button class="btn" type="button" data-act="swap-pick" data-i="' + i + '" data-obj="' + esc(o.label) + '">' + esc(o.label) + ' <span class="conf">' + pct(o) + '</span></button>'; }).join('') +
      '</div><div><button class="btn" type="button" data-act="swap-cancel" data-i="' + i + '">Cancel</button></div></div>' : '';
    return '<li>' + row + pick + '</li>';
  }).join('');
  var sw = $('#sw-labels'); sw.setAttribute('aria-checked', String(S.labels));
  $('#sw-others').setAttribute('aria-checked', String(S.others));
  $('#sw-others-d').textContent = unused.length + ' more objects the scan found';
  $('#pref-badge').hidden = !S.learn.applied;
  $('#proto-photo-note').hidden = !S.userPhoto;
  renderLearn();
}
function focusPlace(act, i){
  var b = $('#loci-list [data-act="' + act + '"][data-i="' + i + '"]');
  if (!b || b.disabled) return false;
  b.focus(); return true;
}
/* Swap/move undo restores places, the scene links they broke, and any edit they logged. */
function placeSnap(){ return JSON.stringify({places:S.places, sceneLocus:S.sceneLocus, log:S.learn.log, sel2:S.sel2}); }
function restorePlaces(snap){
  var o = JSON.parse(snap);
  S.places = o.places; S.sceneLocus = o.sceneLocus; S.learn.log = o.log; S.sel2 = o.sel2; S.swapIx = null;
  syncLoci(); save(); renderCurrent();
}
function logEdit(e){ if (S.learn.on) S.learn.log.push(e); }
function swapPlace(ix, to){
  if (!OBJ(to) || S.places.indexOf(to) >= 0) return;
  var from = S.places[ix], snap = placeSnap();
  S.places[ix] = to;
  if (ix < S.order.length) S.sceneLocus[S.order[ix]] = -1;
  logEdit({t:'swap', ix:ix, from:from, to:to});
  S.swapIx = null; syncLoci(); save(); renderLoci(); focusPlace('swap', ix);
  toast('Swapped ' + from + ' for ' + to + ' at place ' + (ix + 1) + '.', function(){ restorePlaces(snap); focusPlace('swap', ix); });
}
function movePlace(ix, d){
  var j = ix + d; if (j < 0 || j >= S.places.length) return;
  var obj = S.places[ix], snap = placeSnap(), act = d < 0 ? 'place-up' : 'place-down', other = d < 0 ? 'place-down' : 'place-up';
  S.places[ix] = S.places[j]; S.places[j] = obj;
  [ix, j].forEach(function(k){ if (k < S.order.length) S.sceneLocus[S.order[k]] = -1; });
  logEdit({t:'move', obj:obj, from:ix, to:j});
  if (S.sel2 === ix) S.sel2 = j; else if (S.sel2 === j) S.sel2 = ix;
  S.swapIx = null; syncLoci(); save(); renderLoci();
  if (!focusPlace(act, j)) focusPlace(other, j);
  $('#loci-live').textContent = 'Moved ' + obj + ' to place ' + (j + 1) + (j ? ', after the ' + LOCI[j - 1].label : ', the first stop') + '.';
  toast('Moved ' + obj + ' ' + (d < 0 ? 'earlier' : 'later') + ', to place ' + (j + 1) + '.', function(){
    restorePlaces(snap);
    if (!focusPlace(act, ix)) focusPlace(other, ix);
    $('#loci-live').textContent = 'Moved ' + obj + ' back to place ' + (ix + 1) + '.';
  });
}

/* ---------- screen 2: learned preferences ---------- */
/* Deterministic summary of the edit log; this text is what would ride along with future generation requests. */
function learnLines(){
  var log = S.learn.log, lines = ['Starts at the ' + LOCI[0].label + '.'];
  var moves = log.filter(function(e){ return e.t === 'move'; }), swaps = log.filter(function(e){ return e.t === 'swap'; });
  if (!moves.length) lines.push('Goes clockwise around the room.');
  else {
    var net = {}, seen = [];
    moves.forEach(function(m){ if (!net[m.obj]) { net[m.obj] = {from:m.from, to:m.to}; seen.push(m.obj); } else net[m.obj].to = m.to; });
    var moved = seen.filter(function(o){ return net[o].to !== net[o].from; }).slice(0, 2).map(function(o){ return o + (net[o].to < net[o].from ? ' earlier' : ' later'); });
    lines.push('Mostly clockwise, with ' + moves.length + ' order change' + (moves.length === 1 ? '' : 's') + (moved.length ? ': moved ' + moved.join(' and ') : '') + '.');
  }
  var groups = [], byKey = {};
  swaps.forEach(function(s){
    var tk = OBJ(s.to).kind, fk = OBJ(s.from).kind, k = tk + '|' + fk;
    if (!byKey[k]) { byKey[k] = {to:tk, from:fk, ex:s, n:0}; groups.push(byKey[k]); }
    byKey[k].n++;
  });
  groups.sort(function(a, b){ return b.n - a.n; }).slice(0, 2).forEach(function(g){
    var ex = ' (swapped ' + g.ex.from + ' for ' + g.ex.to + ').';
    lines.push(g.to === g.from ? 'Picks other ' + KIND[g.to] + ex : 'Prefers ' + KIND[g.to] + ' over ' + KIND[g.from] + ex);
  });
  lines.push('From ' + log.length + ' edit' + (log.length === 1 ? '' : 's') + '.');
  return lines;
}
function renderLearn(){
  var L = S.learn, n = L.log.length, card = $('#learn-card');
  $('#sw-learn').setAttribute('aria-checked', String(L.on));
  $('#sw-learn-d').textContent = L.on ? 'On: room photos and your place edits are kept. In this prototype everything stays in this browser.' : 'Off: photos are not kept. In this prototype everything stays in this browser.';
  if (!L.on && !n) { card.innerHTML = ''; return; }
  var body = n ? '<ul class="learn-lines">' + learnLines().map(function(t){ return '<li>' + icon('check') + '<span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' :
    '<p class="hint">Nothing yet. Swap or reorder a place and it shows up here.</p>';
  var clear = n ? '<div class="btn-row"><button class="btn btn-danger" type="button" data-act="learn-clear" aria-expanded="' + S.learnConfirm + '">' + icon('trash') + 'Clear what it learned</button></div>' +
    (S.learnConfirm ? '<div class="confirm" role="group" aria-labelledby="lc-q"><p id="lc-q"><strong>Clear what MemriPal has learned?</strong> Your ' + n + ' edit' + (n === 1 ? ' is' : 's are') + ' removed from this browser. Your places stay as they are.</p>' +
      '<div class="btn-row"><button class="btn btn-danger-solid" type="button" data-act="learn-clear-yes">' + icon('trash') + 'Clear</button><button class="btn" type="button" data-act="learn-clear-no" id="learn-keep">Keep it</button></div></div>' : '') : '';
  card.innerHTML = '<div class="learn-card"><h3>What MemriPal has learned</h3>' + body +
    '<p class="hint">Sent with future place and scene generation to tune the defaults.</p>' +
    (L.on ? '' : '<p class="hint">Learning is paused. Turn it back on to keep adding to this.</p>') + clear + '</div>';
}
function clearLearn(){
  var snap = JSON.stringify(S.learn.log);
  S.learn.log = []; S.learnConfirm = false; save(); renderLoci(); $('#sw-learn').focus();
  toast('Cleared what MemriPal learned.', function(){
    S.learn.log = JSON.parse(snap); save(); renderCurrent();
    var b = $('[data-act="learn-clear"]'); if (b && S.screen === 2) b.focus();
  });
}

/* ---------- screen 3: notes ---------- */
function kb(text){ var n = (window.TextEncoder ? new TextEncoder().encode(text).length : text.length); return n / 1024; }
function updateSize(){
  var v = $('#notes').value, k = kb(v), over = k > 20 || S.st[3] === 'toolarge';
  var shown = S.st[3] === 'toolarge' ? 23.4 : k;
  var el = $('#notes-size'); el.textContent = shown.toFixed(1) + ' KB of 20 KB' + (over ? ' - too long' : '');
  el.classList.toggle('over', over);
  $('#extract-btn').disabled = over || !v.trim();
}
var STAT = {pending:['ring','Pending'], generating:['loader','Generating'], valid:['check','Valid'], invalid:['alert','Needs fix'], ready:['check','Ready'], missing:['ring','Missing']};
function chip(st, extra){ var d = STAT[st]; return '<span class="schip s-' + st + '">' + icon(d[0], st === 'generating' ? 'spin' : '') + d[1] + (extra || '') + '</span>'; }
function renderKP(){
  var notes = $('#notes').value, counts = {valid:0, invalid:0, pending:0, generating:0};
  $('#kp-list').innerHTML = PTS.map(function(p, i){
    var st = S.extract[p.id]; counts[st]++;
    var q = (p.id === 6 && S.badQuote) ? BAD_QUOTE : p.quote, body = '';
    if (S.editing === p.id) {
      body = '<form class="kp-edit" data-form="kp" data-id="' + p.id + '"><label for="kp-l-' + p.id + '">Label</label><input type="text" id="kp-l-' + p.id + '" maxlength="40" value="' + esc(p.label) + '">' +
        '<label for="kp-q-' + p.id + '">Exact quote from your notes</label><textarea id="kp-q-' + p.id + '" rows="2">' + esc(q) + '</textarea>' +
        '<p class="field-err" id="kp-e-' + p.id + '" hidden></p><div class="btn-row"><button class="btn btn-primary" type="submit">Save point</button><button class="btn" type="button" data-act="kp-cancel">Cancel</button></div></form>';
    } else if (st === 'invalid') {
      body = '<p class="kp-err">' + icon('alert') + '<span>This quote isn\'t in your notes word for word. Edit it, or regenerate the point.</span></p>' +
        '<div class="btn-row"><button class="btn" type="button" data-act="kp-edit" data-id="' + p.id + '">' + icon('edit') + 'Edit</button><button class="btn" type="button" data-act="kp-regen" data-id="' + p.id + '">' + icon('refresh') + 'Regenerate</button></div>';
    }
    return '<li class="kp" data-status="' + st + '"><span class="num">' + (i + 1) + '</span><div class="kp-body"><div class="kp-top"><span class="kp-label">' + esc(p.label) + '</span>' + chip(st) + '</div>' +
      (st === 'pending' ? '' : '<blockquote class="quote">&ldquo;' + esc(q) + '&rdquo;</blockquote>') + body + '</div></li>';
  }).join('');
  var sum = counts.valid + ' valid';
  if (counts.invalid) sum += ' &middot; <strong style="color:var(--bad)">' + counts.invalid + ' need' + (counts.invalid === 1 ? 's' : '') + ' a fix</strong>';
  if (counts.pending + counts.generating) sum += ' &middot; ' + (counts.pending + counts.generating) + ' in progress';
  $('#kp-summary').innerHTML = PTS.length + ' of 12 max &middot; ' + sum;
  var nx = $('#notes-next'); nx.setAttribute('aria-disabled', String(counts.invalid > 0 || counts.pending + counts.generating > 0));
  void notes;
}
function renderTyped(){
  $('#typed').innerHTML = S.typed.map(function(v, i){
    return '<li><span class="num">' + (i + 1) + '</span><span><label class="sr-only" for="ty-' + i + '">Item ' + (i + 1) + '</label><input type="text" id="ty-' + i + '" data-ty="' + i + '" maxlength="100" value="' + esc(v) + '" style="width:100%" aria-describedby="tyc-' + i + '"></span><span class="cnt" id="tyc-' + i + '">' + v.length + ' / 100</span></li>';
  }).join('');
  $('#add-typed').disabled = S.typed.length >= 12;
  $('#typed-count').textContent = S.typed.length >= 12 ? 'That\'s the maximum of 12 items.' : S.typed.length + ' of 12 items';
}
async function runExtract(){
  if (S.extracting) return; S.extracting = true; S.badQuote = true; S.editing = null;
  PTS.forEach(function(p){ S.extract[p.id] = 'pending'; }); renderKP();
  for (var i = 0; i < PTS.length; i++) {
    var id = PTS[i].id; S.extract[id] = 'generating'; renderKP();
    await wait(reduced ? 80 : 380);
    S.extract[id] = id === 6 ? 'invalid' : 'valid'; renderKP();
  }
  S.extracting = false;
}

/* ---------- scenes ---------- */
function sceneText(id, ix){
  var p = P(id);
  if (S.sceneLocus[id] === ORIG[id] && isOrig(id, ix)) return p.scene;
  return 'The ' + LOCI[ix].label + ' becomes "' + p.label + '": ' + lcFirst(p.ch.visual) + ', and ' + lcFirst(p.ch.auditory) + '.';
}
function walkCue(id, ix){
  /* The hand-written cue names the next place (the last one wraps to place 1), so that place must be the default too. */
  var nextIx = ix + 1 < S.places.length ? ix + 1 : 0;
  if (isOrig(id, ix) && S.places[nextIx] === DEFAULT_PLACES[nextIx]) return P(id).cue;
  var nx = LOCI[ix + 1];
  return nx && ix + 1 < S.order.length ? 'Walk on to the ' + nx.label + '.' : 'Turn back to the ' + LOCI[0].label + '. Walk complete.';
}
function capTop(ix, label){ return '<div class="cap-top"><span class="num">' + (ix + 1) + '</span><span class="tag">' + esc(LOCI[ix].label) + ' &middot; ' + label + '</span></div>'; }
function tier1(id, ix){
  var p = P(id), b = LOCI[ix].box, x = b[0], y = b[1], w = b[2], h = b[3], s = 150, cx = x + w / 2;
  var mx = clamp(cx - s / 2, 8, 800 - s - 8), my = y - s - 6;
  if (my < 8) my = Math.min(y + h + 6, 560 - s - 8);
  var ov = '<svg class="ov" viewBox="0 0 800 560" aria-hidden="true" focusable="false">' +
    '<path class="dim" fill-rule="evenodd" d="M0 0H800V560H0Z M' + (x - 8) + ' ' + (y - 8) + 'h' + (w + 16) + 'v' + (h + 16) + 'h-' + (w + 16) + 'Z"/>' +
    '<circle cx="' + (mx + s / 2) + '" cy="' + (my + s / 2) + '" r="' + (s * 0.66) + '" fill="url(#halo)"/>' +
    '<rect class="glow-out" x="' + (x - 8) + '" y="' + (y - 8) + '" width="' + (w + 16) + '" height="' + (h + 16) + '" rx="14"/>' +
    '<rect class="glow-in" x="' + (x - 8) + '" y="' + (y - 8) + '" width="' + (w + 16) + '" height="' + (h + 16) + '" rx="14"/>' +
    '<use class="motif" href="#m-' + id + '" x="' + mx + '" y="' + my + '" width="' + s + '" height="' + s + '"></use>' +
    sparkles(mx + s / 2, my + s / 2, s) + pinSVG(x - 8, y - 8, ix + 1, 20, 'on') + '</svg>';
  return '<figure class="scene t1"><div class="frame ar-room" role="img" aria-label="Whole-photo scene at the ' + esc(LOCI[ix].label) + ': ' + esc(sceneText(id, ix)) + '">' + photo('0 0 800 560', 'tinted', p.hue) + ov + '</div>' +
    '<figcaption class="cap">' + capTop(ix, 'Whole-photo scene') + '<p class="scene-title">' + esc(p.label) + '</p><p class="scene-text">' + esc(sceneText(id, ix)) + '</p></figcaption></figure>';
}
function tier2(id, ix){
  var p = P(id), vb = cropVB(ix), b = LOCI[ix].box, ms = vb[2] * 0.3, mx = vb[0] + vb[2] - ms - vb[2] * 0.04, my = vb[1] + vb[3] * 0.06, r = vb[2] * 0.04;
  var ov = '<svg class="ov" viewBox="' + vb.join(' ') + '" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
    '<circle cx="' + (mx + ms / 2) + '" cy="' + (my + ms / 2) + '" r="' + (ms * 0.7) + '" fill="url(#halo)"/>' +
    '<rect class="glow-out" vector-effect="non-scaling-stroke" x="' + (b[0] - 6) + '" y="' + (b[1] - 6) + '" width="' + (b[2] + 12) + '" height="' + (b[3] + 12) + '" rx="10"/>' +
    '<rect class="glow-in" vector-effect="non-scaling-stroke" x="' + (b[0] - 6) + '" y="' + (b[1] - 6) + '" width="' + (b[2] + 12) + '" height="' + (b[3] + 12) + '" rx="10"/>' +
    '<use class="motif" href="#m-' + id + '" x="' + mx + '" y="' + my + '" width="' + ms + '" height="' + ms + '"></use>' +
    sparkles(mx + ms / 2, my + ms / 2, ms) + pinSVG(b[0] - 6, b[1] - 6, ix + 1, r, 'on') + '</svg>';
  return '<figure class="scene t2"><div class="t2-grid"><div class="frame ar-43" role="img" aria-label="Close crop of the ' + esc(LOCI[ix].label) + ' with its scene">' + photo(vb.join(' '), 'tinted', p.hue) + ov + '</div>' +
    '<div class="t2-card">' + capTop(ix, 'Scene card') + '<p class="scene-title">' + esc(p.label) + '</p><p class="scene-text">' + esc(sceneText(id, ix)) + '</p></div></div></figure>';
}
function tier3(id, ix, reason, retry){
  var p = P(id), l = LOCI[ix];
  return '<figure class="scene t3"><div class="frame ar-room">' + photo('0 0 800 560') +
    '<canvas width="800" height="560" data-outline="' + ix + '" data-id="' + id + '" role="img" aria-label="Outline of the ' + esc(l.label) + ', stop ' + (ix + 1) + ', labelled ' + esc(p.label) + '"></canvas></div>' +
    '<figcaption class="cap">' + capTop(ix, 'Outline view') + '<p class="scene-title">' + esc(p.label) + '</p>' +
    '<div class="fallback-note">' + icon('info') + '<div><p>' + esc(reason) + ' The place, point and walk cue still work for rehearsal.</p>' +
    (retry ? '<div><button class="btn" type="button" data-act="retry-scene" data-id="' + id + '">' + icon('refresh') + 'Try the scene again</button></div>' : '') + '</div></div></figcaption></figure>';
}
function tierGen(id, ix){
  return '<figure class="scene"><div class="frame ar-room">' + photo('0 0 800 560', 'faded') + '<div class="gen-overlay" role="status">' + icon('loader', 'spin i-lg') + '<span>Painting the scene for stop ' + (ix + 1) + ', the ' + esc(LOCI[ix].label) + '</span></div></div>' +
    '<figcaption class="cap">' + capTop(ix, 'Generating') + '<p class="scene-title">' + esc(P(id).label) + '</p></figcaption></figure>';
}
function renderScene(id, ix, force){
  var st = eff(id, ix);
  if (force === 'gen' || (!force && st === 'generating')) return tierGen(id, ix);
  var tier = force ? +force : (st === 'ready' ? S.tiers[id] : 3);
  if (tier === 1) return tier1(id, ix);
  if (tier === 2) return tier2(id, ix);
  var reason = st === 'invalid' ? 'The last scene didn\'t show the ' + LOCI[ix].label + ' clearly, so it was rejected.' :
               st === 'missing' ? 'This scene hasn\'t been made yet.' :
               force ? 'Preview of the fallback used when a scene image fails.' : 'The scene image failed twice, so this stop uses an outline.';
  return tier3(id, ix, reason, !force || st !== 'ready');
}
function rr(ctx, x, y, w, h, r){
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawOutlines(root){
  $$('canvas[data-outline]', root).forEach(function(cv){
    var ctx = cv.getContext && cv.getContext('2d'); if (!ctx) return;
    var ix = +cv.dataset.outline, id = +cv.dataset.id, b = LOCI[ix].box, x = b[0] - 8, y = b[1] - 8, w = b[2] + 16, h = b[3] + 16;
    ctx.clearRect(0, 0, 800, 560);
    ctx.fillStyle = 'rgba(14,18,26,0.55)'; ctx.beginPath(); ctx.rect(0, 0, 800, 560); rr(ctx, x, y, w, h, 14); ctx.fill('evenodd');
    ctx.setLineDash([16, 10]); ctx.beginPath(); rr(ctx, x, y, w, h, 14);
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    ctx.lineWidth = 4; ctx.strokeStyle = '#FFFFFF'; ctx.stroke(); ctx.setLineDash([]);
    var px = clamp(x, 28, 772), py = clamp(y, 28, 532);
    ctx.beginPath(); ctx.arc(px, py, 26, 0, Math.PI * 2); ctx.fillStyle = '#FFD27A'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#1B1305'; ctx.stroke();
    ctx.fillStyle = '#1B1305'; ctx.font = '700 26px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(ix + 1), px, py + 1);
    var txt = (ix + 1) + '. ' + P(id).label; ctx.font = '700 32px "Atkinson Hyperlegible", system-ui, sans-serif';
    var lw = ctx.measureText(txt).width + 36, lh = 54, lx = clamp(x + w / 2 - lw / 2, 10, 790 - lw), ly = y + h + 14;
    if (ly + lh > 552) ly = y - 14 - lh;
    if (ly < 8) ly = y + h / 2 - lh / 2;
    ctx.fillStyle = 'rgba(16,20,28,0.92)'; ctx.beginPath(); rr(ctx, lx, ly, lw, lh, 12); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.fillText(txt, lx + 18, ly + lh / 2 + 2);
  });
}

/* ---------- screen 4 ---------- */
function renderS4(){
  var n = S.order.length; S.s4 = clamp(S.s4, 0, Math.max(0, n - 1));
  $('#s4-stops').innerHTML = S.order.map(function(id, i){ return '<button type="button" data-act="s4-stop" data-i="' + i + '" aria-pressed="' + (S.s4 === i) + '" aria-label="Stop ' + (i + 1) + ', ' + esc(LOCI[i].label) + '">' + (i + 1) + '</button>'; }).join('');
  var tiers = [['auto','As generated'],['1','1 Whole photo'],['2','2 Scene card'],['3','3 Outline view'],['gen','Generating']];
  $('#s4-tiers').innerHTML = tiers.map(function(t){ return '<button type="button" data-act="s4-tier" data-t="' + t[0] + '" aria-pressed="' + (S.s4tier === t[0]) + '">' + t[1] + '</button>'; }).join('');
  if (!n) { $('#s4-view').innerHTML = '<div class="empty"><strong>No points yet</strong><p>Add key points in Notes first.</p></div>'; $('#scene-grid').innerHTML = ''; return; }
  var id = S.order[S.s4];
  $('#s4-view').innerHTML = renderScene(id, S.s4, S.s4tier === 'auto' ? null : S.s4tier);
  drawOutlines($('#s4-view'));
  $('#scene-grid').innerHTML = S.order.map(function(id, i){
    var st = eff(id, i), t = st === 'generating' ? 'Generating' : st !== 'ready' ? (st === 'invalid' ? 'Rejected &middot; outline' : 'Missing &middot; outline') : ['', 'Whole photo', 'Scene card', 'Outline view'][S.tiers[id]];
    var vb = cropVB(i).join(' '), cls = (st === 'ready' && S.tiers[id] !== 3) ? 'tinted' : '';
    return '<li><button type="button" data-act="s4-stop" data-i="' + i + '" aria-pressed="' + (S.s4 === i) + '"><span class="frame ar-43">' + photo(vb, cls, P(id).hue) + '</span>' +
      '<span class="sg-label"><span class="num">' + (i + 1) + '</span>' + esc(P(id).label) + '</span><span class="sg-tier">' + t + '</span></button></li>';
  }).join('');
  var nx = $('#scenes-next');
  nx.innerHTML = S.auto ? 'Generate (route review skipped)' + icon('right') : 'Review the route' + icon('right');
  nx.setAttribute('href', S.auto ? '#walk' : '#route');
}

/* ---------- screen 5: route ---------- */
function renderRoute(){
  $('#sw-auto').setAttribute('aria-checked', String(S.auto));
  if (!S.order.length && S.st[5] !== 'empty') { S.st[5] = 'empty'; applyState(5); }
  $('#route').innerHTML = S.order.map(function(id, i){
    var p = P(id), changed = S.sceneLocus[id] !== i && S.gen[id] === 'ready';
    var main = '<div class="route-main"><span class="num">' + (i + 1) + '</span><div class="route-txt"><span class="route-loc">' + esc(LOCI[i].label) + '</span><span class="route-pt">' + esc(p.label) + '</span>' +
      (changed ? '<span class="change">' + icon('refresh') + 'New place, scene will be remade</span>' : '') + '</div>' +
      '<div class="route-ctl"><button class="btn" type="button" data-act="up" data-id="' + id + '" aria-label="Move ' + esc(p.label) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + icon('up') + '</button>' +
      '<button class="btn" type="button" data-act="down" data-id="' + id + '" aria-label="Move ' + esc(p.label) + ' down"' + (i === S.order.length - 1 ? ' disabled' : '') + '>' + icon('down') + '</button>' +
      '<button class="btn btn-danger" type="button" data-act="remove" data-id="' + id + '" aria-label="Remove ' + esc(p.label) + '" aria-expanded="' + (S.confirm === id) + '">' + icon('trash') + '</button></div></div>';
    var conf = S.confirm === id ? '<div class="confirm" role="group" aria-labelledby="cf-' + id + '"><p id="cf-' + id + '"><strong>Remove &ldquo;' + esc(p.label) + '&rdquo;?</strong> Its scene goes too, and the points after it move up one place.</p>' +
      '<div class="btn-row"><button class="btn btn-danger-solid" type="button" data-act="confirm-remove" data-id="' + id + '">' + icon('trash') + 'Remove point</button><button class="btn" type="button" data-act="cancel-remove" id="keep-' + id + '">Keep it</button></div></div>' : '';
    return '<li id="route-' + id + '">' + main + conf + '</li>';
  }).join('');
  renderNav();
}
function moveRoute(id, d){
  var i = S.order.indexOf(id), j = i + d; if (j < 0 || j >= S.order.length) return;
  S.order[i] = S.order[j]; S.order[j] = id; S.confirm = null; save(); renderRoute();
  $('#route-live').textContent = 'Moved ' + P(id).label + ' to stop ' + (j + 1) + ', the ' + LOCI[j].label + '.';
  var btn = $('#route-' + id + ' [data-act="' + (d < 0 ? 'up' : 'down') + '"]');
  if (!btn || btn.disabled) btn = $('#route-' + id + ' [data-act="' + (d < 0 ? 'down' : 'up') + '"]');
  if (btn) btn.focus();
}

/* ---------- screen 6: generate + walk ---------- */
function readyCount(){ var c = 0; S.order.forEach(function(id, i){ if (eff(id, i) === 'ready') c++; }); return c; }
function renderGen(){
  var n = S.order.length, rc = readyCount(), todo = n - rc;
  $('#gen-count').textContent = rc + ' of ' + n + ' scenes ready';
  var bar = $('#gen-bar'); bar.setAttribute('aria-valuemax', String(n)); bar.setAttribute('aria-valuenow', String(rc));
  bar.firstElementChild.style.width = (n ? rc / n * 100 : 0) + '%';
  var btn = $('#gen-btn');
  if (S.genBusy && !S.genPaused) { btn.innerHTML = icon('stop') + 'Pause'; btn.disabled = false; }
  else if (!todo) { btn.innerHTML = icon('check') + 'All scenes ready'; btn.disabled = true; }
  else { btn.innerHTML = icon('play') + (S.st[6] === 'offline' || S.genPaused ? 'Resume' : 'Generate missing') + ' (' + todo + ')'; btn.disabled = false; }
  $('#gen-list').innerHTML = S.order.map(function(id, i){
    var st = eff(id, i), note = (st === 'ready' && S.tiers[id] === 3) ? ' &middot; outline' : '';
    return '<li><span class="num">' + (i + 1) + '</span><span class="gen-l"><span class="loc">' + esc(LOCI[i].label) + '</span><span class="pt">' + esc(P(id).label) + '</span></span>' + chip(st === 'invalid' ? 'invalid' : st, note) + '</li>';
  }).join('');
  if (S.screen === 6) renderWalk(true);
  if (S.screen === 4) renderS4();
  $('#walk-back').setAttribute('href', S.auto ? '#scenes' : '#route');
}
async function runGen(){
  if (S.genBusy) return;
  S.genBusy = true; S.genPaused = false; S.genRunning = true; save(); renderGen();
  while (true) {
    if (S.genPaused || S.st[6] === 'offline') break;
    var i = -1;
    for (var k = 0; k < S.order.length; k++) if (eff(S.order[k], k) !== 'ready') { i = k; break; }
    if (i < 0) break;
    var id = S.order[i]; S.gen[id] = 'generating'; save(); renderGen();
    await wait(reduced ? 300 : 1100);
    var ix = S.order.indexOf(id);
    if (ix < 0) continue;
    S.gen[id] = 'ready'; S.sceneLocus[id] = ix;
    S.tiers[id] = (isOrig(id, ix) && BASE_TIER[id] !== 3 && S.tiers[id] !== 3) ? BASE_TIER[id] : 1;
    save(); renderGen();
  }
  S.genBusy = false;
  if (!S.genPaused && S.st[6] !== 'offline') S.genRunning = false;
  save(); renderGen();
}
async function regenOne(id){
  S.gen[id] = 'generating'; renderCurrent();
  await wait(reduced ? 300 : 1400);
  var ix = S.order.indexOf(id); if (ix < 0) return;
  S.gen[id] = 'ready'; S.sceneLocus[id] = ix; S.tiers[id] = 1; save(); renderCurrent();
}
function renderWalk(keepFocus){
  var n = S.order.length, w = $('#walk');
  if (!n) { w.innerHTML = '<div class="empty"><strong>Nothing to walk yet</strong><p>Add points in Notes first.</p></div>'; return; }
  S.walk = clamp(S.walk, 0, n - 1);
  var ix = S.walk, id = S.order[ix], p = P(id), focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.act : null;
  w.innerHTML = '<div class="walk-head"><p class="eyebrow" aria-live="polite">Stop ' + (ix + 1) + ' of ' + n + ' &middot; ' + esc(LOCI[ix].label) + '</p><div class="walk-nav">' +
    '<button class="btn icon-btn" type="button" data-act="walk-prev" aria-label="Previous stop"' + (ix === 0 ? ' disabled' : '') + '>' + icon('left') + '</button>' +
    '<button class="btn icon-btn" type="button" data-act="walk-next" aria-label="Next stop"' + (ix === n - 1 ? ' disabled' : '') + '>' + icon('right') + '</button></div></div>' +
    renderScene(id, ix) +
    '<div class="walk-point"><p class="eyebrow">The point</p><h3>' + esc(p.label) + '</h3><blockquote class="quote">&ldquo;' + esc(p.quote) + '&rdquo;</blockquote></div>' +
    '<dl class="channels" aria-label="Eight sensory channels">' + CH.map(function(c){ return '<div class="ch"><dt>' + icon('ch-' + c.k) + c.name + '</dt><dd>' + esc(p.ch[c.k]) + '</dd></div>'; }).join('') + '</dl>' +
    '<div class="cue">' + icon('walk') + '<p><strong>Walk cue.</strong> ' + esc(walkCue(id, ix)) + '</p></div>' +
    '<div class="walk-foot"><button class="btn" type="button" data-act="walk-prev"' + (ix === 0 ? ' disabled' : '') + '>' + icon('left') + 'Previous</button>' +
    '<button class="btn btn-primary" type="button" data-act="walk-next"' + (ix === n - 1 ? ' disabled' : '') + '>Next stop' + icon('right') + '</button></div>';
  drawOutlines(w);
  if (keepFocus && (focused === 'walk-prev' || focused === 'walk-next')) {
    var b = $$('[data-act="' + focused + '"]', w).filter(function(x){ return !x.disabled; })[0] || $$('[data-act="' + (focused === 'walk-prev' ? 'walk-next' : 'walk-prev') + '"]', w)[0];
    if (b) b.focus();
  }
}

/* ---------- screen 7: recall ---------- */
function renderTiles(){
  $('#s7').classList.toggle('hidden-palace', S.hide);
  $('#sw-hide').setAttribute('aria-checked', String(S.hide));
  $('#tiles').innerHTML = S.order.map(function(id, i){
    var st = S.rc.got[id] ? 'got' : S.rc.manual[id] ? 'manual' : 'wait';
    var stat = st === 'wait' ? icon('ring') + 'Waiting' : icon('check') + (st === 'manual' ? 'Marked got' : 'Got it');
    return '<li class="tile" id="tile-' + id + '" data-state="' + st + '"><div class="frame ar-43 thumb">' + photo(cropVB(i).join(' '), 'tinted', P(id).hue) + '</div>' +
      '<div class="tile-body"><div class="tile-top"><span class="num">' + (i + 1) + '</span><span class="loc lbl-hide"' + (S.hide ? ' aria-hidden="true"' : '') + '>' + esc(LOCI[i].label) + '</span></div>' +
      '<span class="pt lbl-hide"' + (S.hide ? ' aria-hidden="true"' : '') + '>' + esc(P(id).label) + '</span>' + (S.hide ? '<span class="sr-only">Label hidden</span>' : '') +
      '<span class="tstat">' + stat + '</span></div></li>';
  }).join('');
}
function matchText(t){
  t = t.toLowerCase();
  return S.order.filter(function(id){ return P(id).kw.some(function(k){ return t.indexOf(k) >= 0; }); });
}
function markGot(id, said){
  if (S.rc.got[id]) return;
  S.rc.got[id] = true; S.rc.said[id] = said; delete S.rc.manual[id];
  renderTiles();
  var t = $('#tile-' + id); if (t && !reduced) { t.classList.add('flash'); }
  $('#recall-live').textContent = 'Got stop ' + (S.order.indexOf(id) + 1) + ': ' + P(id).label + '.';
}
var timerInt = null;
function stopReplay(){ S.rc.token++; S.rc.running = false; clearInterval(timerInt); updateMic(); }
function updateMic(){
  var on = S.rc.running, m = $('#mic');
  m.setAttribute('aria-pressed', String(on));
  m.innerHTML = icon(on ? 'stop' : 'mic') + '<span class="sr-only">' + (on ? 'Stop reciting' : 'Start reciting') + '</span>';
  $('#mic-label').textContent = on ? 'Listening. Tap to stop.' : 'Tap to start reciting';
}
function demoFill(){ S.rc = freshRecall(); REPLAY.forEach(function(c){ matchText(c).forEach(function(id){ S.rc.got[id] = true; S.rc.said[id] = c; }); }); renderTiles(); }
async function startRecital(mode){
  stopReplay();
  var chunks;
  if (mode === 'misses') {
    chunks = REPLAY_MISSES.filter(function(c){ return matchText(c).some(function(id){ return !S.rc.got[id]; }); });
    Object.keys(S.rc.manual).forEach(function(k){ delete S.rc.manual[k]; });
  } else { var keep = S.rc.answers; S.rc = freshRecall(); S.rc.answers = keep; chunks = REPLAY; }
  var tok = ++S.rc.token; S.rc.running = true; S.rc.started = Date.now(); S.rc.transcript = '';
  S.st[7] = 'listening'; applyState(7); renderTiles(); updateMic();
  var strip = $('#strip'); strip.innerHTML = '';
  var tm = $('#timer'); tm.textContent = '0:00';
  timerInt = setInterval(function(){ var s = Math.floor((Date.now() - S.rc.started) / 1000); tm.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 500);
  for (var c = 0; c < chunks.length; c++) {
    var words = chunks[c].split(' '), line = document.createElement('span');
    strip.appendChild(line);
    for (var wi = 0; wi < words.length; wi++) {
      if (tok !== S.rc.token) return;
      line.textContent += (wi ? ' ' : '') + words[wi];
      strip.scrollTop = strip.scrollHeight;
      await wait(reduced ? 40 : 120);
    }
    if (tok !== S.rc.token) return;
    var ids = matchText(chunks[c]).filter(function(id){ return !S.rc.got[id]; });
    if (ids.length) { var m = document.createElement('mark'); m.textContent = line.textContent; line.textContent = ''; line.appendChild(m); }
    line.appendChild(document.createTextNode(' '));
    ids.forEach(function(id){ markGot(id, chunks[c]); });
    await wait(reduced ? 80 : 450);
  }
  if (tok !== S.rc.token) return;
  stopReplay(); finishRun(); S.st[7] = 'finished'; applyState(7); renderEnd();
  var e = $('#end-title'); if (e) e.focus();
}
function finishRun(){
  var said = {}, manual = {};
  S.order.forEach(function(id){ if (S.rc.got[id]) said[id] = S.rc.said[id] || ''; if (S.rc.manual[id]) manual[id] = true; });
  var run = S.rc.runId ? S.runs.filter(function(r){ return r.id === S.rc.runId; })[0] : null;
  if (!run) {
    var maxN = S.runs.reduce(function(m, r){ return Math.max(m, r.n); }, 0), d = new Date(), h = d.getHours();
    run = {id:'r' + Date.now(), n:maxN + 1, when:'Today, ' + ((h % 12) || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? ' am' : ' pm'), said:{}, manual:{}};
    S.runs.unshift(run); S.rc.runId = run.id; S.runSel = run.id;
  }
  run.said = said; run.manual = manual; save();
  if (S.st[8] === 'empty') S.st[8] = 'runs';
}
function renderEnd(){
  var got = [], miss = [];
  S.order.forEach(function(id, i){ (S.rc.got[id] || S.rc.manual[id] ? got : miss).push({id:id, i:i}); });
  var n = S.order.length;
  var li = function(o, isGot){
    var p = P(o.id), manual = !!S.rc.manual[o.id];
    return '<li><span class="num">' + (o.i + 1) + '</span><span><strong>' + esc(p.label) + '</strong> <span class="hint">at the ' + esc(LOCI[o.i].label) + '</span>' + (manual ? ' <span class="small-tag">Marked by you</span>' : '') + '</span>' +
      (isGot ? (manual ? '<button class="btn" type="button" data-act="unmark" data-id="' + o.id + '" aria-pressed="true">' + icon('undo') + 'Unmark</button>' : '') :
       '<button class="btn" type="button" data-act="mark" data-id="' + o.id + '" aria-pressed="false">' + icon('check') + 'Mark got it</button>') + '</li>';
  };
  $('#end').innerHTML =
    '<div class="panel"><div class="end-sum"><h2 id="end-title" tabindex="-1"><span class="end-big">' + got.length + ' of ' + n + '</span> points recalled</h2>' + REPLAY_TAG + '</div>' +
    '<div class="end-cols"><section class="end-col" aria-labelledby="got-h"><h3 id="got-h">' + icon('check') + 'Got (' + got.length + ')</h3><ul>' + (got.map(function(o){ return li(o, true); }).join('') || '<li class="hint">None yet.</li>') + '</ul></section>' +
    '<section class="end-col" aria-labelledby="miss-h"><h3 id="miss-h">' + icon('x') + 'Missed (' + miss.length + ')</h3><ul>' + (miss.map(function(o){ return li(o, false); }).join('') || '<li class="hint">Nothing missed. Nice walk.</li>') + '</ul></section></div>' +
    '<div class="btn-row"><button class="btn btn-primary" type="button" data-act="rerecite"' + (miss.length ? '' : ' disabled') + '>' + icon('mic') + 'Re-recite misses (' + miss.length + ')</button>' +
    '<button class="btn" type="button" data-act="restart">Recite from the start</button></div></div>' +
    '<div class="panel selfcheck"><h2>Self-check</h2><p class="hint">One why-or-apply question per point. Answer out loud or jot a line; answers stay in this browser.</p><ol>' +
    S.order.map(function(id, i){
      var p = P(id);
      return '<li><p class="eyebrow">Stop ' + (i + 1) + ' &middot; ' + esc(p.label) + '</p><label for="sc-' + id + '">' + esc(p.q) + '</label><textarea id="sc-' + id + '" data-sc="' + id + '" rows="2">' + esc(S.rc.answers[id] || '') + '</textarea>' +
        '<details><summary>Show what your notes say</summary><blockquote class="quote">&ldquo;' + esc(p.quote) + '&rdquo;</blockquote></details></li>';
    }).join('') + '</ol></div>';
}

/* ---------- screen 8: history ---------- */
var STOP = ' a an the and or to of in on at it is we you i for by with that this be our your from just like so there can has have been its when did would will them which only one per all are let us'.split(' ');
function words(s){ return s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean); }
function hl(text, against){
  var set = {}; words(against).forEach(function(w){ if (STOP.indexOf(w) < 0) set[w] = 1; });
  return text.split(/(\s+)/).map(function(tok){
    var k = tok.toLowerCase().replace(/[^a-z0-9']/g, '');
    return (k && set[k] && STOP.indexOf(k) < 0) ? '<mark>' + esc(tok) + '</mark>' : esc(tok);
  }).join('');
}
function runHits(r){ return PTS.filter(function(p){ return r.said[p.id] !== undefined || (r.manual && r.manual[p.id]); }).length; }
function renderHistory(){
  if (!S.runs.length && S.st[8] !== 'empty') { S.st[8] = 'empty'; applyState(8); }
  if (S.runs.length && S.st[8] === 'empty' && !S.emptyPreview) { S.st[8] = 'runs'; applyState(8); }
  if (!S.runs.length) return;
  if (!S.runSel || !S.runs.some(function(r){ return r.id === S.runSel; })) S.runSel = S.runs[0].id;
  $('#runs').innerHTML = S.runs.map(function(r){
    var conf = S.runConfirm === r.id ? '<div class="confirm" role="group" aria-labelledby="rc-' + r.id + '"><p id="rc-' + r.id + '"><strong>Delete Run ' + r.n + '?</strong> Its transcript is removed from this browser and drops out of your hit rates.</p>' +
      '<div class="btn-row"><button class="btn btn-danger-solid" type="button" data-act="confirm-del-run" data-id="' + r.id + '">' + icon('trash') + 'Delete run</button><button class="btn" type="button" data-act="cancel-del-run" id="keep-run-' + r.id + '">Keep it</button></div></div>' : '';
    return '<li class="run" id="run-' + r.id + '"><div class="run-row"><button class="run-pick" type="button" data-act="pick-run" data-id="' + r.id + '" aria-pressed="' + (S.runSel === r.id) + '"><strong>Run ' + r.n + '</strong><span>' + esc(r.when) + ' &middot; ' + runHits(r) + ' of ' + PTS.length + ' recalled</span></button>' +
      '<button class="btn btn-danger" type="button" data-act="del-run" data-id="' + r.id + '" aria-expanded="' + (S.runConfirm === r.id) + '">' + icon('trash') + 'Delete</button></div>' + conf + '</li>';
  }).join('');
  var run = S.runs.filter(function(r){ return r.id === S.runSel; })[0];
  $('#cmp-title').textContent = 'Run ' + run.n + ': what you said vs what\'s in the palace';
  $('#cmp').innerHTML = PTS.map(function(p, i){
    var said = run.said[p.id], man = run.manual && run.manual[p.id], has = said !== undefined && said !== '';
    var st = has ? '<span class="schip s-valid">' + icon('check') + 'Said</span>' : man ? '<span class="schip s-pending">' + icon('check') + 'Marked by you</span>' : '<span class="schip s-invalid">' + icon('x') + 'Not said</span>';
    return '<li><div class="cmp-h"><span class="num">' + (i + 1) + '</span><strong>' + esc(p.label) + '</strong>' + st + '</div><div class="cmp-cols">' +
      '<div><p class="col-k">In the palace</p><p class="quote">&ldquo;' + (has ? hl(p.quote, said) : esc(p.quote)) + '&rdquo;</p></div>' +
      '<div><p class="col-k">What you said</p>' + (has ? '<p>' + hl(said, p.quote) + '</p>' : man ? '<p class="hint">Not in the transcript. You marked it as got.</p>' : '<p class="not-said">' + icon('x') + 'Not said</p>') + '</div></div></li>';
  }).join('');
  var R = S.runs.length, chronic = [];
  $('#hits').innerHTML = PTS.map(function(p, i){
    var hits = S.runs.filter(function(r){ return r.said[p.id] !== undefined || (r.manual && r.manual[p.id]); }).length;
    var bad = R >= 3 && hits / R <= 1 / 3; if (bad) chronic.push(p);
    var ix = S.order.indexOf(p.id);
    return '<li class="hit' + (bad ? ' chronic' : '') + '"><span class="num">' + (i + 1) + '</span><span class="hit-l"><strong>' + esc(p.label) + '</strong><span>' + (ix >= 0 ? 'at the ' + esc(LOCI[ix].label) : 'removed from route') + '</span></span>' +
      '<span class="meter" role="img" aria-label="Recalled in ' + hits + ' of ' + R + ' runs"><span style="width:' + (R ? hits / R * 100 : 0) + '%"></span></span><span class="hit-v">' + hits + '/' + R + '</span>' +
      (bad ? '<span class="flag">' + icon('alert') + 'Chronically missed</span>' : '') + '</li>';
  }).join('');
  $('#hits-sum').innerHTML = chronic.length ? '<div class="alert">' + icon('alert') + '<div><p><strong>Chronically missed: ' + chronic.map(function(p){ return esc(p.label); }).join(', ') + '.</strong> Recalled in a third of runs or fewer. Walk to those places and make the scenes louder in your head.</p><div><a class="btn" href="#walk">' + icon('walk') + 'Walk these stops</a></div></div></div>' :
    (R < 3 ? '<p class="hint">Hit rates firm up after 3 runs.</p>' : '<p class="hint">No chronic misses. Keep going.</p>');
}

/* ---------- misc ---------- */
function renderCurrent(){ var r = RENDER[S.screen]; if (r) r(); }
var RENDER = {
  1: function(){ applyState(1); $('#photo').disabled = S.st[1] !== 'live'; },
  2: function(){ applyState(2); renderLoci(); },
  3: function(){ applyState(3); updateSize(); renderKP(); renderTyped(); },
  4: function(){ renderS4(); },
  5: function(){ applyState(5); renderRoute(); },
  6: function(){ applyState(6); renderGen(); renderWalk(); showResume(); },
  7: function(){ applyState(7); renderTiles(); updateMic(); if (S.st[7] === 'finished') renderEnd(); },
  8: function(){ applyState(8); renderHistory(); },
  9: function(){ applyState(9); REV.render(); }
};
function showResume(){
  var n = $('#resume-note');
  if (S.resumed) { $('#resume-text').textContent = S.resumed; n.hidden = false; } else n.hidden = true;
}
async function startFinding(file){
  var img = $('#user-photo');
  if (file) { try { img.src = URL.createObjectURL(file); img.alt = 'Your room photo'; img.hidden = false; S.userPhoto = true; } catch (e) { img.hidden = true; } }
  setState(1, 'finding');
  await wait(2600);
  if (S.st[1] !== 'finding') return;
  S.st[1] = 'live'; nav(2); setState(2, 'found');
}
async function loadDemo(){
  S.userPhoto = false; S.swapIx = null;
  S.learn.applied = S.learn.on && S.learn.log.length > 0; save();
  nav(2); setState(2, 'scanning');
  await wait(1400);
  if (S.st[2] === 'scanning') setState(2, 'found');
}

/* ---------- events ---------- */
document.addEventListener('click', function(e){
  var t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  var a = t.dataset.act, id = t.dataset.id ? (isNaN(+t.dataset.id) ? t.dataset.id : +t.dataset.id) : null;
  switch (a) {
    case 'state':
      var sn = +t.dataset.s; S.emptyPreview = (sn === 8 && t.dataset.stVal === 'empty');
      if (sn === 6 && t.dataset.stVal === 'running') { S.genPaused = false; }
      setState(sn, t.dataset.stVal, true); break;
    case 'demo': loadDemo(); break;
    case 'labels': S.labels = !S.labels; renderLoci(); $('#sw-labels').focus(); break;
    case 'sel-locus': S.sel2 = +t.dataset.i; renderLoci(); focusPlace('sel-locus', S.sel2); break;
    case 'others': S.others = !S.others; renderLoci(); $('#sw-others').focus(); break;
    case 'swap':
      var si = +t.dataset.i; S.swapIx = S.swapIx === si ? null : si; renderLoci();
      if (S.swapIx === null) focusPlace('swap', si); else focusPlace('swap-pick', si);
      break;
    case 'swap-cancel': var ci = +t.dataset.i; S.swapIx = null; renderLoci(); focusPlace('swap', ci); break;
    case 'swap-pick': swapPlace(+t.dataset.i, t.dataset.obj); break;
    case 'place-up': movePlace(+t.dataset.i, -1); break;
    case 'place-down': movePlace(+t.dataset.i, 1); break;
    case 'learn':
      S.learn.on = !S.learn.on; S.learnConfirm = false; save(); renderLearn(); $('#sw-learn').focus();
      toast(S.learn.on ? 'MemriPal will keep your room photos and learn from your place edits.' : 'Learning paused. What it learned so far stays until you clear it.');
      break;
    case 'learn-clear': S.learnConfirm = !S.learnConfirm; renderLearn(); var lk = $('#learn-keep'); if (lk) lk.focus(); break;
    case 'learn-clear-no': S.learnConfirm = false; renderLearn(); $('[data-act="learn-clear"]').focus(); break;
    case 'learn-clear-yes': clearLearn(); break;
    case 'tab':
      S.tab = t.dataset.tab;
      $$('.tabs [role="tab"]').forEach(function(b){ var on = b.dataset.tab === S.tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      $('#panel-paste').hidden = S.tab !== 'paste'; $('#panel-list').hidden = S.tab !== 'list'; break;
    case 'extract': S.st[3] = 'ready'; applyState(3); runExtract(); break;
    case 'kp-edit': S.editing = id; renderKP(); var f = $('#kp-q-' + id); if (f) f.focus(); break;
    case 'kp-cancel': var was = S.editing; S.editing = null; renderKP(); var eb = $('[data-act="kp-edit"][data-id="' + was + '"]'); if (eb) eb.focus(); break;
    case 'kp-regen':
      S.extract[id] = 'generating'; S.editing = null; renderKP();
      setTimeout(function(){ if (id === 6) S.badQuote = false; S.extract[id] = 'valid'; renderKP(); }, reduced ? 200 : 1200); break;
    case 'add-typed': if (S.typed.length < 12) { S.typed.push(''); renderTyped(); $('#ty-' + (S.typed.length - 1)).focus(); } break;
    case 's4-stop': S.s4 = +t.dataset.i; renderS4(); var sb = $('#s4-stops [data-i="' + S.s4 + '"]'); if (t.closest('#s4-stops') && sb) sb.focus(); else { var gb = $('#scene-grid [data-i="' + S.s4 + '"]'); if (gb) gb.focus(); } break;
    case 's4-tier': S.s4tier = t.dataset.t; renderS4(); $('#s4-tiers [data-t="' + S.s4tier + '"]').focus(); break;
    case 'retry-scene': regenOne(id); break;
    case 'auto': S.auto = !S.auto; save(); renderRoute(); toast(S.auto ? 'Route review will be skipped next time.' : 'Route review is back on.'); $('#sw-auto').focus(); break;
    case 'up': moveRoute(id, -1); break;
    case 'down': moveRoute(id, 1); break;
    case 'remove': S.confirm = S.confirm === id ? null : id; renderRoute(); var k = $('#keep-' + id); if (k) k.focus(); break;
    case 'cancel-remove': S.confirm = null; renderRoute(); var rb = $('#route-' + id + ' [data-act="remove"]') || $('[data-act="remove"][data-id="' + (t.id || '').replace('keep-', '') + '"]'); var cid = +(t.id || '').replace('keep-', ''); rb = $('#route-' + cid + ' [data-act="remove"]'); if (rb) rb.focus(); break;
    case 'confirm-remove':
      (function(){
        var ix = S.order.indexOf(id), p = P(id);
        S.order.splice(ix, 1); S.confirm = null; save(); renderRoute();
        $('#route-live').textContent = 'Removed ' + p.label + '.';
        var nextId = S.order[Math.min(ix, S.order.length - 1)], nb = nextId ? $('#route-' + nextId + ' [data-act="remove"]') : null;
        if (nb) nb.focus(); else $('#t5').focus();
        toast('Removed "' + p.label + '".', function(){
          S.order.splice(ix, 0, id); if (S.st[5] === 'empty') { S.st[5] = 'list'; applyState(5); }
          save(); renderRoute(); $('#route-live').textContent = 'Restored ' + p.label + ' at stop ' + (ix + 1) + '.';
          var b = $('#route-' + id + ' [data-act="remove"]'); if (b) b.focus();
        });
      })(); break;
    case 'gen':
      if (S.genBusy && !S.genPaused) { S.genPaused = true; S.genRunning = false; save(); renderGen(); }
      else { if (S.st[6] === 'offline') { S.st[6] = 'running'; applyState(6); } S.resumed = null; showResume(); S.genPaused = false; runGen(); }
      break;
    case 'walk-prev': S.walk--; renderWalk(true); break;
    case 'walk-next': S.walk++; renderWalk(true); break;
    case 'hide': S.hide = !S.hide; renderTiles(); $('#sw-hide').focus(); break;
    case 'mic':
      if (S.rc.running) { stopReplay(); finishRun(); S.st[7] = 'finished'; applyState(7); renderEnd(); }
      else startRecital('full');
      break;
    case 'check-typed':
      var txt = $('#typed-recall').value; S.rc = freshRecall();
      txt.split(/[.!?\n]+/).forEach(function(sentence){ matchText(sentence).forEach(function(mid){ if (!S.rc.got[mid]) { S.rc.got[mid] = true; S.rc.said[mid] = sentence.trim(); } }); });
      renderTiles(); finishRun(); S.st[7] = 'finished'; applyState(7); renderEnd(); $('#end-title').focus(); break;
    case 'mark': S.rc.manual[id] = true; finishRun(); renderTiles(); renderEnd(); var ub = $('[data-act="unmark"][data-id="' + id + '"]'); if (ub) ub.focus(); break;
    case 'unmark': delete S.rc.manual[id]; finishRun(); renderTiles(); renderEnd(); var mb = $('[data-act="mark"][data-id="' + id + '"]'); if (mb) mb.focus(); break;
    case 'rerecite': startRecital('misses'); $('#mic').focus(); break;
    case 'restart': S.rc.runId = null; startRecital('full'); $('#mic').focus(); break;
    case 'pick-run': S.runSel = id; S.runConfirm = null; renderHistory(); $('[data-act="pick-run"][data-id="' + id + '"]').focus(); break;
    case 'del-run': S.runConfirm = S.runConfirm === id ? null : id; renderHistory(); var kr = $('#keep-run-' + id); if (kr) kr.focus(); break;
    case 'cancel-del-run': var rid = (t.id || '').replace('keep-run-', ''); S.runConfirm = null; renderHistory(); var db = $('[data-act="del-run"][data-id="' + rid + '"]'); if (db) db.focus(); break;
    case 'confirm-del-run':
      (function(){
        var ix = -1; S.runs.forEach(function(r, i){ if (r.id === id) ix = i; });
        var run = S.runs.splice(ix, 1)[0]; S.runConfirm = null; if (S.rc.runId === id) S.rc.runId = null; save(); renderHistory();
        var first = $('#runs [data-act="pick-run"]'); if (first) first.focus(); else $('#t8').focus();
        toast('Deleted Run ' + run.n + '.', function(){
          S.runs.splice(ix, 0, run); S.runSel = run.id; S.emptyPreview = false; save(); renderHistory();
          var b = $('[data-act="pick-run"][data-id="' + run.id + '"]'); if (b) b.focus();
        });
      })(); break;
    case 'reset':
      $('#reset-area').innerHTML = '<div class="confirm" role="group" aria-labelledby="reset-q" style="width:100%"><p id="reset-q"><strong>Reset the prototype?</strong> Place and route changes, what MemriPal learned, scene progress and new runs go back to the demo.</p><div class="btn-row"><button class="btn btn-danger-solid" type="button" data-act="reset-yes">Reset</button><button class="btn" type="button" data-act="reset-no" id="reset-no">Keep my changes</button></div></div>';
      $('#reset-no').focus(); break;
    case 'reset-no': $('#reset-area').innerHTML = '<button class="btn btn-quiet" type="button" data-act="reset">Reset this prototype</button>'; $('[data-act="reset"]').focus(); break;
    case 'reset-yes':
      (function(){
        var snap = JSON.stringify({order:S.order, gen:S.gen, sceneLocus:S.sceneLocus, tiers:S.tiers, auto:S.auto, runs:S.runs, places:S.places, learn:S.learn});
        S.genPaused = true; stopReplay();
        var f = freshData(); ['order','gen','sceneLocus','tiers','auto','runs','places','learn'].forEach(function(k){ S[k] = f[k]; });
        S.genRunning = false; S.rc = freshRecall(); S.resumed = null; S.swapIx = null; S.learnConfirm = false; syncLoci(); save();
        $('#reset-area').innerHTML = '<button class="btn btn-quiet" type="button" data-act="reset">Reset this prototype</button>';
        renderCurrent(); $('[data-act="reset"]').focus();
        toast('Prototype reset to the demo.', function(){ var o = JSON.parse(snap); Object.keys(o).forEach(function(k){ S[k] = o[k]; }); syncLoci(); save(); renderCurrent(); });
      })(); break;
  }
});
document.addEventListener('submit', function(e){
  if (e.target.id === 'pass-form') {
    e.preventDefault();
    var v = $('#passcode').value.trim(), err = $('#pass-err');
    if (!v) { err.hidden = false; $('#passcode').setAttribute('aria-invalid', 'true'); $('#passcode').focus(); return; }
    err.hidden = true; $('#passcode').removeAttribute('aria-invalid'); $('#passcode').value = '';
    setState(1, 'live'); $('#photo').focus();
    return;
  }
  if (e.target.dataset.form === 'kp') {
    e.preventDefault();
    var id = +e.target.dataset.id, q = $('#kp-q-' + id).value.trim(), l = $('#kp-l-' + id).value.trim(), er = $('#kp-e-' + id);
    var notes = $('#notes').value.toLowerCase().replace(/\s+/g, ' ');
    if (!l) { er.textContent = 'Give the point a short label.'; er.hidden = false; $('#kp-l-' + id).focus(); return; }
    if (!q || notes.indexOf(q.toLowerCase().replace(/\s+/g, ' ')) < 0) { er.textContent = 'That quote still isn\'t in your notes word for word. Copy it straight from the notes above.'; er.hidden = false; $('#kp-q-' + id).focus(); return; }
    var p = P(id); p.label = l; p.quote = q; if (id === 6) S.badQuote = false;
    S.extract[id] = 'valid'; S.editing = null; renderKP();
  }
});
document.addEventListener('input', function(e){
  if (e.target.id === 'notes') { if (S.st[3] === 'toolarge') { S.st[3] = 'ready'; applyState(3); } updateSize(); }
  if (e.target.dataset.ty !== undefined) { var i = +e.target.dataset.ty; S.typed[i] = e.target.value; $('#tyc-' + i).textContent = e.target.value.length + ' / 100'; }
  if (e.target.dataset.sc !== undefined) { S.rc.answers[e.target.dataset.sc] = e.target.value; }
});
document.addEventListener('change', function(e){
  if ((e.target.id === 'photo' || e.target.id === 'photo2') && e.target.files && e.target.files[0]) { S.st[1] = 'live'; startFinding(e.target.files[0]); e.target.value = ''; }
});
$('.tabs').addEventListener('keydown', function(e){
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  var next = S.tab === 'paste' ? 'list' : 'paste'; var b = $('.tabs [data-tab="' + next + '"]'); b.click(); b.focus(); e.preventDefault();
});
$('#walk').addEventListener('keydown', function(e){
  if (e.target.matches('input,textarea')) return;
  if (e.key === 'ArrowRight' && S.walk < S.order.length - 1) { S.walk++; renderWalk(); e.preventDefault(); }
  if (e.key === 'ArrowLeft' && S.walk > 0) { S.walk--; renderWalk(); e.preventDefault(); }
});
document.addEventListener('click', function(e){
  var a = e.target.closest('a[aria-disabled="true"]');
  if (a) { e.preventDefault(); e.stopPropagation(); toast('Fix the point marked "Needs fix" first, or regenerate it.'); }
}, true);

/* ---------- init ---------- */
buildBooks();
$('#notes').value = NOTES;
renderStatebars();
Object.keys(STATES).forEach(function(n){ applyState(+n); });
$('#photo').disabled = true;
var hadGenerating = false;
Object.keys(S.gen).forEach(function(k){ if (S.gen[k] === 'generating') { S.gen[k] = 'missing'; hadGenerating = true; } });
if (S.genRunning || hadGenerating) {
  var rc0 = readyCount(), todo0 = S.order.length - rc0;
  if (todo0) { S.resumed = 'Picked up where you left off: ' + rc0 + ' scenes were already saved. Making only the ' + todo0 + ' that ' + (todo0 === 1 ? 'is' : 'are') + ' missing or rejected.'; S.genRunning = true; }
}
var start = screenFromHash() || S.screen || 1;
if (!screenFromHash()) { try { history.replaceState(null, '', '#' + (start === 9 ? REV.TOK : SCREENS[start - 1].tok)); } catch (e) {} }
show(start, true);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function(){ drawOutlines(document); });
})();
