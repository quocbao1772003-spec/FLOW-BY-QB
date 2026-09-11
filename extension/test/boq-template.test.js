// Tests for the self-healing payload template, run against the functions as
// they actually ship in background.js.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

// Pull out the pure helpers by name. They are top-level declarations, so the
// closing brace is the first line that is exactly "}" at column 0.
function fn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error("not found: " + name);
  const end = src.indexOf("\n}\n", start);
  if (end === -1) throw new Error("no terminator: " + name);
  return src.slice(start, end + 3);
}
const NAMES = ["boqFindPaths", "boqFindPathsBy", "boqGetAt", "boqSetAt", "boqClone",
  "boqLearnTemplate", "boqBuildFromTemplate", "boqVerifyTemplate", "boqExtractSampleValues"];
const RE = src.match(/const BOQ_UUID_UPPER_RE = [^\n]+/)[0];
eval(RE + "\n" + NAMES.map(fn).join("\n"));

let fails = 0;
const check = (label, ok, extra) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (extra ? "  " + extra : ""));
  if (!ok) fails++;
};

const PROJECT = "968df978-691a-4502-b2bc-2fa32c8f96e6";
const TOKEN = "0cAFcWeA5".padEnd(2446, "x");
const GROUP = "ED9A1E94-1713-4187-A449-1763747781B6";

// The payload shape captured from Flow, i2i with one reference.
function makeInner(extraSlot) {
  const ctx = [null, 22, null, null, null, PROJECT, null, null, null, null, [TOKEN, 1]];
  const item = [null, null, [["c21a6286-cc99-4bd6-a8ce-55f0cb931d7b", null, null, null, 1]],
    1835000232, 1, "NARWHAL", null, ctx, [[["thay con meò thành con rồng"]]],
    null, null, null, "8231A96B-A377-4472-8851-112DBFDFD04F",
    "510CAE63-781E-4E04-8B3E-4A27DD997685"];
  if (extraSlot) item.splice(1, 0, "SOMETHING_NEW");   // Google inserts a slot
  return [null, [item], 1, ctx, [GROUP]];
}

console.log("learn from a real-shaped sample");
const inner = makeInner(false);
const values = boqExtractSampleValues(inner, PROJECT);
check("finds the prompt", values.prompt === "thay con meò thành con rồng", values.prompt);
check("finds the captcha token", values.token === TOKEN);
check("finds the seed", values.seed === 1835000232, String(values.seed));
check("finds the batch id", values.groupId === GROUP, values.groupId);
check("finds the reference media", JSON.stringify(values.mediaIds) ===
  JSON.stringify(["c21a6286-cc99-4bd6-a8ce-55f0cb931d7b"]), JSON.stringify(values.mediaIds));

const learned = boqLearnTemplate({ rpcId: "ogiZ0b", bl: "boq_x", endpoint: "/e", inner, values });
check("learns without error", !learned.error, learned.error || "");
const tpl = learned.template;
check("prompt path", JSON.stringify(tpl.paths.prompt) === "[1,0,8,0,0,0]", JSON.stringify(tpl.paths.prompt));
check("seed path", JSON.stringify(tpl.paths.seed) === "[1,0,3]", JSON.stringify(tpl.paths.seed));
check("two context copies for project", tpl.paths.project.length === 2);
check("two context copies for token", tpl.paths.token.length === 2);
check("inputs container", JSON.stringify(tpl.paths.inputs) === "[1,0,2]", JSON.stringify(tpl.paths.inputs));

console.log("stored skeleton keeps no secrets");
const stored = JSON.stringify(tpl.skeleton);
check("no captcha token", stored.indexOf(TOKEN) === -1);
check("no project id", stored.indexOf(PROJECT) === -1);
check("no prompt text", stored.indexOf("thay con meò") === -1);
check("no media id", stored.indexOf("c21a6286") === -1);
check("keeps the constants", stored.indexOf("NARWHAL") !== -1);

console.log("round-trip verification");
check("verifies against its own sample",
  boqVerifyTemplate(tpl, { inner, values }).ok);
const bad = boqClone(tpl);
bad.paths.seed = [1, 0, 4];           // wrong slot on purpose
check("rejects a mislearned template", !boqVerifyTemplate(bad, { inner, values }).ok,
  boqVerifyTemplate(bad, { inner, values }).reason);

console.log("rebuild with our own values");
const built = boqBuildFromTemplate(tpl, {
  prompt: "giữ nguyên hộp, thay bộ nails",
  projectId: "3c22ead1-64ef-4ccc-9235-877373699ad2",
  token: "NEWTOKEN", seed: 42, groupId: "G-BATCH",
  mediaIds: ["82318fd0-6178-4c36-8a0c-2da58c50d08f", "d6602a2d-a11b-4990-9553-b6199ad75eac"],
  newUuid: () => "U-U-U-U-U",
});
check("prompt written", boqGetAt(built, tpl.paths.prompt) === "giữ nguyên hộp, thay bộ nails");
check("seed written", boqGetAt(built, tpl.paths.seed) === 42);
check("both contexts get the token",
  tpl.paths.token.every((p) => boqGetAt(built, p) === "NEWTOKEN"));
check("two references expand", JSON.stringify(boqGetAt(built, tpl.paths.inputs)) ===
  JSON.stringify([["82318fd0-6178-4c36-8a0c-2da58c50d08f", null, null, null, 1],
                  ["d6602a2d-a11b-4990-9553-b6199ad75eac", null, null, null, 1]]),
  JSON.stringify(boqGetAt(built, tpl.paths.inputs)));
check("batch id written", boqGetAt(built, tpl.paths.group[0]) === "G-BATCH");

console.log("text-only rebuild clears the reference slot");
const t2i = boqBuildFromTemplate(tpl, {
  prompt: "p", projectId: "x", token: "t", seed: 1, groupId: "g",
  mediaIds: [], newUuid: () => "U",
});
check("inputs null when no refs", boqGetAt(t2i, tpl.paths.inputs) === null);

console.log("THE POINT: Google inserts a slot and we relearn");
const inner2 = makeInner(true);
const values2 = boqExtractSampleValues(inner2, PROJECT);
const learned2 = boqLearnTemplate({ rpcId: "ogiZ0b", bl: "boq_y", endpoint: "/e", inner: inner2, values: values2 });
check("relearns the shifted payload", !learned2.error, learned2.error || "");
check("seed path moved 3 -> 4",
  JSON.stringify(learned2.template.paths.seed) === "[1,0,4]",
  JSON.stringify(learned2.template.paths.seed));
check("old template no longer round-trips on the new shape",
  !boqVerifyTemplate(tpl, { inner: inner2, values: values2 }).ok);
check("new template does",
  boqVerifyTemplate(learned2.template, { inner: inner2, values: values2 }).ok);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
