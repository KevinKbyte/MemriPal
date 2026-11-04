// Preview-only driver for Pal's first-run tour (preview.html). Not app code; persists nothing,
// so every reload starts the tour again. Query: ?s=1..5 step, 6 Settings replay, 7 skip toast.
(function () {
  var q = new URLSearchParams(location.search);
  var theme = q.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);

  var STEPS = [
    { target: null, title: "Hi! I'm King Memri.",
      body: "But call me Pal. My dog house is the Memri Palace, and I'd love to help you build a palace of your own. The tour takes under a minute.",
      next: "Show me around" },
    { target: ".tab[href=\"#routes\"]", title: "Walk a place you know",
      body: "Pick a walk you take often. Stop at a few spots and snap a photo. Each spot becomes a room in your palace.",
      next: "Next" },
    { target: ".drawer-handle", title: "Your routes live here",
      body: "Open this to map a new route. No time to walk? Tap Load demo and try one I made earlier.",
      next: "Next" },
    { target: ".tab[href=\"#recall\"]", title: "Store it, then recall it",
      body: "Put one thing to remember at each spot. Later, walk the route in your head and tell me what you find. I'll keep score.",
      next: "Next" },
    { target: ".tab[href=\"#settings\"]", title: "That's the tour!",
      body: "You can replay it any time from Settings. Ready to build your palace?",
      next: "Let's go" }
  ];

  function $(id) { return document.getElementById(id); }
  var tour = $("tour");
  var spot = tour.querySelector(".tour-spot");
  var card = tour.querySelector(".tour-card");
  var dots = tour.querySelectorAll(".tour-dots li");
  var back = $("tour-back");
  var next = $("tour-next");
  var toast = $("tour-toast");
  var cur = 0;
  var toastTimer = null;

  function placeSpot() {
    var sel = STEPS[cur].target;
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
    $("tour-n").textContent = String(i + 1);
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("is-current", d === i);
    $("tour-title").textContent = s.title;
    $("tour-body").textContent = s.body;
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
  if (s >= 1 && s <= 5) show(s - 1);
  else if (s === 6) { tour.hidden = true; showTab("settings"); }
  else if (s === 7) { tour.hidden = true; showToast(); }
  else show(0);
})();
