// Run the SHIPPED boqGenerateInPage against a realistic Flow reply, with the
// network and reCAPTCHA stubbed. Catches exactly the class of bug that turned
// a successful generation into BOQ_NO_MEDIA_URL.
const fs = require("fs");

const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function extract(name) {
  const start = src.indexOf("async function " + name + "(cfg) {");
  if (start === -1) throw new Error("not found: " + name);
  // These are top-level declarations, so the closing brace is the first line
  // that is exactly "}" at column 0. Brace counting would trip over the `}`
  // inside the `)]}'` comments.
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error("no terminator: " + name);
  return src.slice(start, end + 3);
}

// ── build a reply shaped like the real one, with a Vietnamese prompt ──────
const URL_ = "https://flow-content.google/image/39098d5b-a51b-462e-93cf-a481067d6367?Expires=1789134925&KeyName=labs-flow-prod-cdn-key&Signature=olmbuuyLRm43m0MiJwo9iQZdrJA";
const inner = JSON.stringify([[["39098d5b-a51b-462e-93cf-a481067d6367", null,
  "25457ef5-186e-4884-b7d3-7f31df90606f", null, null, null,
  [[null, 710924939, null, null, null, null, 1, "create a dog", 29, null, null,
    "25457ef5-186e-4884-b7d3-7f31df90606f", null, URL_, 1,
    [null, null, [["tạo một con chó", null, [[["tạo một con chó"]]]]], []],
    null, "39098d5b-a51b-462e-93cf-a481067d6367"], null, [1024, 1024]]]]]);
const frame = JSON.stringify([["wrb.fr", "ogiZ0b", inner, null, null, null, "generic"],
  ["di", 31251], ["af.httprm", 31250, "-2278067171703891649", 26]]);
const tail = JSON.stringify([["e", 4, null, null, 994]]);
const bl = (s) => Buffer.byteLength(s, "utf8");   // Google counts BYTES
const reply = ")]}'\n\n" + bl(frame) + "\n" + frame + "\n" + bl(tail) + "\n" + tail + "\n";

// ── stub the page environment ────────────────────────────────────────────
let captured = null;
global.window = {
  WIZ_global_data: { SNlM0e: "AT_TOKEN", cfb2h: "boq_labs-ai-sandbox-frontend_20260909.10_p0",
                     FdrFJe: "-2265854675289420126", EP: "vi" },
  grecaptcha: { enterprise: { execute: async () => "0cAFcWeA5_fake_token" } },
  crypto: { randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
};
global.fetch = async (url, init) => {
  captured = { url, body: init.body };
  return { ok: true, status: 200, text: async () => reply };
};
global.URLSearchParams = URLSearchParams;

const boqGenerateInPage = eval("(" + extract("boqGenerateInPage") + ")");

(async () => {
  let fails = 0;
  const check = (label, ok, extra) => {
    console.log((ok ? "  PASS  " : "  FAIL  ") + label + (extra ? "  " + extra : ""));
    if (!ok) fails++;
  };

  // 1. text → image
  let r = await boqGenerateInPage({
    projectId: "968df978-691a-4502-b2bc-2fa32c8f96e6", prompt: "tạo một con chó",
    mediaInputs: [], seed: 123456, groupId: "G-1",
    endpoint: "/_/AiSandboxAngularFrontend/data/batchexecute", rpcId: "ogiZ0b",
    siteKey: "k", modelTag: "NARWHAL", surfaceId: 22,
  });
  console.log("text → image");
  check("parses the reply", !r.error, r.error || "");
  check("media id", r.mediaId === "39098d5b-a51b-462e-93cf-a481067d6367", r.mediaId);
  check("signed url", r.url === URL_);

  const freq = JSON.parse(new URLSearchParams(captured.body).get("f.req"));
  const sent = JSON.parse(freq[0][0][1]);
  check("INPUTS null when no refs", sent[1][0][2] === null, JSON.stringify(sent[1][0][2]));
  check("seed in slot 3", sent[1][0][3] === 123456, String(sent[1][0][3]));
  check("model tag", sent[1][0][5] === "NARWHAL");
  check("batch id honoured", sent[4][0] === "G-1", sent[4][0]);
  check("prompt", JSON.stringify(sent[1][0][8]) === JSON.stringify([[["tạo một con chó"]]]));
  check("captcha in both contexts",
    sent[1][0][7][10][0] === "0cAFcWeA5_fake_token" && sent[3][10][0] === "0cAFcWeA5_fake_token");

  // 2. image → image
  console.log("image → image");
  r = await boqGenerateInPage({
    projectId: "968df978-691a-4502-b2bc-2fa32c8f96e6", prompt: "thay con chó thành con mèo",
    mediaInputs: ["65119829-cc5e-41b7-a824-d3acafbece90", "854ad80a-45ba-4338-bb20-33da675651cd"],
    seed: 7, groupId: "G-2",
    endpoint: "/x", rpcId: "ogiZ0b", siteKey: "k", modelTag: "NARWHAL", surfaceId: 22,
  });
  const sent2 = JSON.parse(JSON.parse(new URLSearchParams(captured.body).get("f.req"))[0][0][1]);
  check("still parses", !r.error, r.error || "");
  check("INPUTS shape", JSON.stringify(sent2[1][0][2]) === JSON.stringify([
    ["65119829-cc5e-41b7-a824-d3acafbece90", null, null, null, 1],
    ["854ad80a-45ba-4338-bb20-33da675651cd", null, null, null, 1]]),
    JSON.stringify(sent2[1][0][2]));

  // 3. tree walk misses → raw-text fallback still recovers the url
  console.log("fallback");
  global.fetch = async () => ({ ok: true, status: 200, text: async () => reply.replace(/\n/g, " ") });
  r = await boqGenerateInPage({
    projectId: "p", prompt: "x", mediaInputs: [], seed: 1, groupId: "G",
    endpoint: "/x", rpcId: "ogiZ0b", siteKey: "k", modelTag: "NARWHAL", surfaceId: 22,
  });
  check("recovers url from mangled envelope", r.url === URL_, r.error || r.url);

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
