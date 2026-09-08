(function () {
  var W = window.SimpleWebAuthnBrowser;
  var $ = function (id) { return document.getElementById(id); };
  function show(id, on) { $(id).hidden = !on; }
  function status(el, msg, cls) { var n = $(el); n.hidden = !msg; n.textContent = msg || ""; n.className = "status " + (cls || ""); }
  function post(path, body) { return fetch("auth" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); }); }
  if (!W || !window.PublicKeyCredential) { status("auth-status", "这个浏览器不支持 Passkey (WebAuthn)。", "bad"); $("approve").disabled = true; $("register").disabled = true; }
  fetch("auth/state").then(function (r) { return r.json(); }).then(function (s) {
    if (s.session) { location.replace("./"); return; }
    var first = !s.registered;
    show("auth", !first);
    if (first) { $("reg").open = true; $("reg-summary").textContent = "还没有任何 Passkey —— 注册这台设备"; }
  });
  function approve() {
    $("approve").disabled = true; status("auth-status", "等待 Passkey…");
    post("/options").then(function (o) { return W.startAuthentication({ optionsJSON: o.options }).then(function (resp) { return post("/verify", { challengeId: o.challengeId, response: resp }); }); })
      .then(function (r) { status("auth-status", "已通过 Passkey「" + r.passkey + "」登录，正在进入…", "ok"); location.replace("./"); })
      .catch(function (e) { status("auth-status", e.message || String(e), "bad"); $("approve").disabled = false; });
  }
  var enrollmentId = null, timer = null;
  function register() {
    var label = $("label").value.trim(); if (!label) { status("reg-status", "先给这个 Passkey 起个名字。", "bad"); return; }
    $("register").disabled = true; status("reg-status", "正在创建 Passkey…");
    post("/register/options", { label: label }).then(function (o) { enrollmentId = o.enrollmentId; return W.startRegistration({ optionsJSON: o.options }).then(function (resp) { return post("/register/verify", { enrollmentId: o.enrollmentId, response: resp }); }); })
      .then(function (r) { $("code").textContent = r.code; $("cmd").textContent = r.approvalCommand; show("pending", true); show("reg-form", false); status("reg-status", ""); timer = setInterval(poll, 2500); })
      .catch(function (e) { status("reg-status", e.message || String(e), "bad"); $("register").disabled = false; });
  }
  function poll() {
    fetch("auth/register/" + enrollmentId).then(function (r) { return r.json(); }).then(function (s) {
      if (s.status === "approved") { clearInterval(timer); show("pending", false); show("approved", true); show("auth", true); status("auth-status", "Passkey 已批准，点击登录。", "ok"); $("approve").disabled = false; $("approve").scrollIntoView({ behavior: "smooth" }); }
      else if (s.status === "rejected" || s.status === "expired" || s.status === "unknown") { clearInterval(timer); $("pending-status").textContent = "注册已" + ({ rejected: "被拒绝", expired: "过期", unknown: "失效" })[s.status] + "，刷新页面重新注册。"; $("pending-status").className = "status bad"; }
    }).catch(function () {});
  }
  $("approve").addEventListener("click", approve);
  $("register").addEventListener("click", register);
  $("label").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); register(); } });
})();
