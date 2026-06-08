(function() {
  var head = document.getElementsByTagName("head")[0];
  var base = (document.currentScript || {src:''}).src.replace(/phosphor-loader\.js$/, '');
  ["regular","thin","light","bold","fill","duotone"].forEach(function(w) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = base + "phosphor/" + w + "/style.css";
    head.appendChild(link);
  });
})();
