// Preview-only driver for Pal's first-run tour (preview.html). Not app code; persists nothing,
// so every reload starts the tour again. Query: ?s=1..10 step, 11 Settings replay, 12 skip toast.
(function () {
  var q = new URLSearchParams(location.search);
  var theme = q.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);

  function E(cp) { return String.fromCodePoint(cp); }

  // story: centered card with an optional locus figure (fig rows: spot, icon, item; sub = nested spots).
  var STEPS = [
    { target: null, title: "Hi! I'm King Memri.",
      body: "But call me Pal. My dog house is the Memri Palace. Let me show you how it works, then help you build a palace of your own.",
      next: "Show me" },
    { story: true, title: "A trick older than kibble",
      body: "About 2,500 years ago a banquet hall collapsed. The poet Simonides could name every guest by where they had sat. Greek and Roman speakers then used his trick to remember whole speeches.",
      after: "They call it the memory palace. Clearly named after me.",
      next: "Next" },
    { story: true, title: "My Royal Shopping List",
      body: "One item per spot, in the order I walk my dog house:",
      fig: [
        { spot: "Doormat", icon: E(0x1F953), item: "sizzling bacon" },
        { spot: "Water bowl", icon: E(0x1F3BE), item: "squeaking tennis ball" },
        { spot: "Chew-toy throne", icon: E(0x1F95C), item: "dripping peanut butter" },
        { spot: "Scratching post", icon: E(0x1F3AB), item: "belly-rub voucher, wax paw seal" },
        { spot: "Window", icon: E(0x1F451), item: "spare paper crown, in case of rain, or a coup" }
      ],
      next: "Next" },
    { story: true, title: "Then I walk it again",
      body: "At the store I stroll the house in my head. Each spot hands back its item:",
      fig: [
        { spot: "Doormat", icon: "\u2713", item: "bacon", done: true },
        { spot: "Water bowl", icon: "\u2713", item: "tennis ball", done: true },
        { spot: "Chew-toy throne", icon: "\u2713", item: "peanut butter", done: true },
        { spot: "Scratching post", icon: "\u2713", item: "belly-rub voucher", done: true },
        { spot: "Window", icon: "\u2713", item: "paper crown", done: true },
        { spot: "(nowhere)", icon: "?", item: "item six", faded: true }
      ],
      after: "Item six I forgot because I didn't put it in the palace. Lesson.",
      next: "Next" },
    { story: true, title: "Five spots for five snacks? Amateur.",
      body: "I park the whole cart on the doormat. The cart is a mini-palace of its own:",
      fig: [
        { spot: "Doormat", icon: E(0x1F6D2), item: "the whole cart", sub: [
          { spot: "Handle", item: "leash" },
          { spot: "Child seat", item: "squeaky duck" },
          { spot: "Basket", item: "kibble" },
          { spot: "Bottom rack", item: "dog shampoo" },
          { spot: "Wheels", item: "four tennis balls" }
        ] }
      ],
      after: "The other spots stay free for my next list.",
      next: "Next" },
    { story: true, title: "A palace inside my palace",
      body: "One spot can hold a whole list, if the picture packs it in:",
      fig: [
        { spot: "Scratching post", icon: E(0x1F3AB), item: "CBE: Commander of the Belly Empire", sub: [
          { spot: "C", item: "Chin" }, { spot: "B", item: "Belly" }, { spot: "E", item: "Ears" }
        ] },
        { spot: "Window", icon: E(0x1F451), item: "the crown's 3 points", sub: [
          { spot: "Point 1", item: "glue" }, { spot: "Point 2", item: "glitter" }, { spot: "Point 3", item: "spare paper" }
        ] }
      ],
      after: "I am very powerful.",
      next: "Next" },
    { target: ".tab[href=\"#routes\"]", title: "Walk a place you know",
      body: "Pick a walk you take often. Stop at a few spots and snap a photo. Each spot becomes a room in your palace.",
      next: "Next" },
    { target: ".drawer-handle", title: "Your routes live here",
      body: "Open this to map a new route. No time to walk? Tap Load demo and try one I made earlier.",
      next: "Next" },
    { target: ".tab[href=\"#recall\"]", title: "Store it, then recall it",
      body: "Put one thing to remember at each spot. Later, walk the route in your head and tell me what you find. I'll keep score.",
      next: "Next" },
    { target: ".tab[href=\"#settings\"]", title: "Now let's build your palace",
      body: "You can replay this tour any time from Settings.",
      next: "Let's go" }
  ];

  function $(id) { return document.getElementById(id); }
  var tour = $("tour");
  var spot = tour.querySelector(".tour-spot");
  var card = tour.querySelector(".tour-card");
  var dotList = tour.querySelector(".tour-dots");
  var fig = $("tour-fig");
  var back = $("tour-back");
  var next = $("tour-next");
  var toast = $("tour-toast");
  var cur = 0;
  var toastTimer = null;

  // Dots and total follow STEPS, so adding a step needs no markup change.
  $("tour-total").textContent = String(STEPS.length);
  for (var k = 0; k < STEPS.length; k++) dotList.appendChild(document.createElement("li"));
  var dots = dotList.children;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function figRow(r) {
    var li = el("li", "fig-row" + (r.done ? " is-done" : "") + (r.faded ? " is-faded" : ""));
    li.appendChild(el("span", "fig-spot", r.spot));
    if (r.icon) li.appendChild(el("span", "fig-icon", r.icon));
    li.appendChild(el("span", "fig-item", r.item));
    if (r.sub) {
      var ol = el("ol", "fig-sub");
      r.sub.forEach(function (c) { ol.appendChild(figRow(c)); });
      li.appendChild(ol);
    }
    return li;
  }

  function placeSpot() {
    var sel = STEPS[cur].target || null;
    var el = sel ? document.querySelector(sel) : null;
    if (el) {
      var r = el.getBoundingClientRect();
      var pad = 6;
      spot.style.top = (r.top - pad) + "px";
      spot.style.left = (r.left - pad) + "px";
      spot.style.width = (r.width + 2 * pad) + "px";
      spot.style.height = (r.height + 2 * pad) + "px";
      spot.classList.remove("is-empty");
    } else {
      // Collapse to a point at screen centre so the welcome step has no cut-out.
      spot.classList.add("is-empty");
      spot.style.top = (innerHeight / 2) + "px";
      spot.style.left = (innerWidth / 2) + "px";
      spot.style.width = "0px";
      spot.style.height = "0px";
    }
  }

  function show(i) {
    cur = i;
    var s = STEPS[i];
    tour.hidden = false;
    tour.classList.toggle("is-welcome", s.target === null);
    tour.classList.toggle("is-story", !!s.story);
    $("tour-n").textContent = String(i + 1);
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("is-current", d === i);
    $("tour-title").textContent = s.title;
    $("tour-body").textContent = s.body;
    fig.textContent = "";
    (s.fig || []).forEach(function (r) { fig.appendChild(figRow(r)); });
    fig.hidden = !s.fig;
    $("tour-after").textContent = s.after || "";
    $("tour-after").hidden = !s.after;
    back.hidden = i === 0;
    next.textContent = s.next;
    placeSpot();
    next.focus();
  }

  function showToast() {
    toast.hidden = false;
    clearTimeout(toastTimer);
    // Screenshots run under webdriver; keep the toast up so it lands in the shot.
    if (!navigator.webdriver) toastTimer = setTimeout(function () { toast.hidden = true; }, 4000);
  }

  function close(skipped) {
    tour.hidden = true;
    if (skipped) showToast();
  }

  function showTab(name) {
    $("tab-routes").hidden = name !== "routes";
    $("tab-settings").hidden = name !== "settings";
    document.querySelectorAll(".tabbar .tab").forEach(function (a) {
      if (a.getAttribute("href") === "#" + name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  next.addEventListener("click", function () {
    if (cur < STEPS.length - 1) show(cur + 1);
    else close(false);
  });
  back.addEventListener("click", function () { if (cur > 0) show(cur - 1); });
  $("tour-skip").addEventListener("click", function () { close(true); });
  $("tour-replay").addEventListener("click", function () {
    showTab("routes");
    clearTimeout(toastTimer);
    toast.hidden = true;
    show(0);
  });
  window.addEventListener("resize", function () { if (!tour.hidden) placeSpot(); });

  document.addEventListener("keydown", function (e) {
    if (tour.hidden) return;
    if (e.key === "Escape") { close(true); return; }
    if (e.key !== "Tab" || !tour.contains(document.activeElement)) return;
    // Focus trap: cycle the card's visible buttons only.
    var btns = Array.prototype.filter.call(card.querySelectorAll("button"), function (b) { return !b.hidden; });
    if (!btns.length) return;
    e.preventDefault();
    var at = btns.indexOf(document.activeElement);
    var to = e.shiftKey ? (at <= 0 ? btns.length - 1 : at - 1) : (at + 1) % btns.length;
    btns[to].focus();
  });

  var s = parseInt(q.get("s"), 10);
  var n = STEPS.length;
  if (s >= 1 && s <= n) show(s - 1);
  else if (s === n + 1) { tour.hidden = true; showTab("settings"); }
  else if (s === n + 2) { tour.hidden = true; showToast(); }
  else show(0);
})();
