// Preview-only helpers shared by preview.html (S1-S4) and preview-2.html (S5-S9):
// screen filter, theme switch, painted placeholder pictures.
(function () {
  var q = new URLSearchParams(location.search);
  var root = document.documentElement;
  var theme = q.get("theme");
  if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
  var want = (q.get("s") || "").split(",").filter(Boolean);
  if (want.length) {
    document.querySelectorAll("[data-s]").forEach(function (el) {
      if (want.indexOf(el.getAttribute("data-s")) < 0) el.hidden = true;
    });
  }
  // Full-page screenshots would pin the sticky Capture button over the strip; unstick it there only.
  if (navigator.webdriver) {
    document.querySelectorAll(".capture-btn").forEach(function (el) { el.style.position = "relative"; });
  }
  document.getElementById("theme-flip").addEventListener("click", function (e) {
    e.preventDefault();
    var dark = getComputedStyle(root).colorScheme.indexOf("dark") >= 0;
    q.set("theme", dark ? "light" : "dark");
    location.search = q.toString();
  });
  function ph(hue, w, h) {
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h + "' viewBox='0 0 120 90'>" +
      "<rect width='120' height='90' fill='hsl(" + hue + ",35%,72%)'/>" +
      "<circle cx='30' cy='28' r='22' fill='hsl(" + ((+hue + 40) % 360) + ",45%,82%)' opacity='.8'/>" +
      "<path d='M0 70 Q30 50 60 64 T120 58 V90 H0Z' fill='hsl(" + ((+hue + 180) % 360) + ",30%,45%)' opacity='.7'/>" +
      "<rect x='70' y='30' width='26' height='34' fill='hsl(" + hue + ",30%,38%)' opacity='.8'/></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }
  document.querySelectorAll("img[data-ph]").forEach(function (img) {
    img.src = ph(img.getAttribute("data-ph"), img.getAttribute("data-w") || 112, img.getAttribute("data-h") || 84);
  });
  // The S7 scene canvas lives on preview-2.html only.
  var c = document.getElementById("scene");
  if (!c) return;
  var ctx = c.getContext("2d");
  var g = ctx.createLinearGradient(0, 0, 0, 360);
  g.addColorStop(0, "#c9d8e8"); g.addColorStop(1, "#b98f63");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 480, 360);
  ctx.fillStyle = "#8a3b2a"; ctx.fillRect(150, 110, 200, 170);
  ctx.fillStyle = "#f3e7cf"; ctx.fillRect(170, 150, 70, 90); ctx.fillRect(260, 150, 70, 90);
  ctx.strokeStyle = "#ffd34d"; ctx.lineWidth = 5; ctx.strokeRect(140, 100, 220, 190);
})();
