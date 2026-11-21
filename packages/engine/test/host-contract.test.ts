/**
 * The Lightroom plug-in drives the engine over HTTP and parses the replies with
 * its own hand-written JSON scanner. That scanner is the fragile part of the
 * contract: it looks for `"id":"…"` as a literal byte sequence, so a response
 * that is pretty-printed, reordered or switched to a different shape would
 * break the plug-in while every JSON-aware client kept working.
 *
 * These tests pin the plug-in's side of that boundary:
 *
 * * every `.lua` file parses (a syntax error makes Lightroom drop the whole
 *   plug-in, with no error dialog);
 * * the fields the plug-in reads are present in the HTTP replies, in the exact
 *   compact form its scanner expects;
 * * the session payload it sends is accepted as-is.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import luaparse from "luaparse";
import { afterAll, describe, expect, it } from "vitest";

import { encodePng16 } from "../../core/src/io/codec/png.js";
import { startApi, tempApp } from "./helpers.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(here, "../../..");
const PLUGIN = join(REPO, "hosts/lightroom/colorfm.lrplugin");

const temp = tempApp("host-contract");
const apiPromise = startApi(temp.app);
afterAll(async () => {
  await (await apiPromise).close();
  temp.cleanup();
});

// ---------------------------------------------------------------------------
// The plug-in's JSON reader, ported from EngineClient.lua so the assertions use
// the same rules the plug-in does instead of JSON.parse.
// ---------------------------------------------------------------------------

/** `EngineClient.valueOffset`: end of `"key":` (whitespace tolerated). */
function valueOffset(text: string, key: string): number | undefined {
  const needle = `"${key}"`;
  let init = 0;
  for (;;) {
    const hit = text.indexOf(needle, init);
    if (hit === -1) return undefined;
    let index = hit + needle.length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === ":") {
      index += 1;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      return index;
    }
    init = hit + needle.length;
  }
}

function jsonString(text: string, key: string): string | undefined {
  const start = valueOffset(text, key);
  if (start === undefined || text[start] !== '"') return undefined;
  const out: string[] = [];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      out.push(next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next);
      index += 1;
      continue;
    }
    if (char === '"') return out.join("");
    out.push(char);
  }
  return undefined;
}

function jsonNumber(text: string, key: string): number | undefined {
  const start = valueOffset(text, key);
  if (start === undefined) return undefined;
  const match = /^-?\d+\.?\d*/.exec(text.slice(start));
  return match ? Number(match[0]) : undefined;
}

function jsonBool(text: string, key: string): boolean | undefined {
  const start = valueOffset(text, key);
  return start === undefined ? undefined : text.slice(start, start + 4) === "true";
}

/** `EngineClient.listSessions`: literal search, newest first. */
function scanSessions(body: string): { id: string; state?: string; label?: string }[] {
  const out: { id: string; state?: string; label?: string }[] = [];
  let init = 0;
  for (;;) {
    const first = body.indexOf('"id":"', init);
    if (first === -1) break;
    const idStart = first + '"id":"'.length;
    const idEnd = body.indexOf('"', idStart);
    if (idEnd === -1) break;
    const id = body.slice(idStart, idEnd);

    let state: string | undefined;
    const stateFirst = body.indexOf('"state":"', idEnd);
    if (stateFirst !== -1) {
      const start = stateFirst + '"state":"'.length;
      const end = body.indexOf('"', start);
      if (end !== -1) state = body.slice(start, end);
    }

    let label: string | undefined;
    const labelFirst = body.indexOf('"label":"', idEnd);
    if (labelFirst !== -1) {
      const start = labelFirst + '"label":"'.length;
      const end = body.indexOf('"', start);
      if (end !== -1) label = body.slice(start, end);
    }

    out.push({ id, state, label });
    init = idEnd + 1;
  }
  return out;
}

/** Raw request, because the point is to see the bytes the plug-in would see. */
async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const api = await apiPromise;
  const response = await fetch(api.base + path, {
    method,
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe("Lightroom plug-in contract", () => {
  it("parses every plug-in file", async () => {
    const files = readdirSync(PLUGIN).filter((name) => name.endsWith(".lua"));
    const info = readFileSync(join(PLUGIN, "Info.lua"), "utf8");

    // A menu entry naming a file that was deleted is a plug-in that fails to load,
    // so the two lists have to agree: every `file = "..."` must exist on disk.
    const entries = [...info.matchAll(/file = "([^"]+\.lua)"/g)].map((match) => match[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(files, entry).toContain(entry);

    for (const name of files) {
      const source = readFileSync(join(PLUGIN, name), "utf8");
      // Lua 5.1 is what Lightroom embeds; luaparse targets exactly that.
      expect(() => luaparse.parse(source, { luaVersion: "5.1" }), name).not.toThrow();
    }
  });

  it("keeps both string tables in step, and every key reachable", async () => {
    const source = readFileSync(join(PLUGIN, "Strings.lua"), "utf8");
    const ast = luaparse.parse(source, { luaVersion: "5.1" });

    // Pull the two literal tables out of Strings.lua by name.
    const tables: Record<string, Map<string, string>> = {};
    for (const node of ast.body) {
      if (node.type !== "LocalStatement" || node.init.length !== 1) continue;
      const name = node.variables[0]?.name;
      const init = node.init[0];
      if (!name || init.type !== "TableConstructorExpression") continue;
      const entries = new Map<string, string>();
      for (const field of init.fields) {
        if (field.type !== "TableKeyString") continue;
        // luaparse leaves `value` null in the default encoding mode; `raw` keeps
        // the source text (quotes included), which is all the placeholder check
        // needs.
        entries.set(field.key.name, field.value.type === "StringLiteral" ? (field.value.raw ?? "") : "");
      }
      tables[name] = entries;
    }

    const english = tables.ENGLISH;
    const chinese = tables.CHINESE;
    expect(english, "ENGLISH table").toBeDefined();
    expect(chinese, "CHINESE table").toBeDefined();

    // A missing translation falls back to English, which is silent — catch it here.
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());

    // string.format throws when the argument count does not match, and the two
    // languages must therefore use the same placeholders.
    const placeholders = (text: string) => (text.match(/%[sd]/g) ?? []).join(",");
    for (const [key, text] of english) {
      expect(placeholders(chinese.get(key) ?? ""), key).toBe(placeholders(text));
    }

    // Every Strings.t("key") in the plug-in has to name a key that exists.
    for (const file of readdirSync(PLUGIN).filter((name) => name.endsWith(".lua"))) {
      const body = readFileSync(join(PLUGIN, file), "utf8");
      for (const match of body.matchAll(/Strings\.t\("([^"]+)"/g)) {
        expect(english.has(match[1]), `${file}: ${match[1]}`).toBe(true);
      }
    }
  });

  it("only calls module functions that are actually defined", async () => {
    // A module whose file got clobbered still parses, so syntax is not enough:
    // the call sites would fail at run time with "attempt to call a nil value".
    const modules = ["Session", "EngineClient", "Exporter", "TestSupport", "Strings"];
    const sources = new Map(
      readdirSync(PLUGIN)
        .filter((name) => name.endsWith(".lua"))
        .map((name) => [name, readFileSync(join(PLUGIN, name), "utf8")]),
    );
    // Comments mention paths like "Session.lua", which would otherwise look like
    // a call to Session.lua; strip them before scanning for call sites.
    const all = [...sources.values()].map((text) => text.replace(/--[^\n]*/g, "")).join("\n");

    for (const module of modules) {
      const definition = sources.get(`${module}.lua`);
      expect(definition, `${module}.lua`).toBeDefined();

      // Two ways a module exposes a function: `function Mod.x(...)` and
      // `Mod.x = someLocal`.
      const definitionPattern = new RegExp(
        `function ${module}\\.([A-Za-z_0-9]+)\\s*\\(|${module}\\.([A-Za-z_0-9]+)\\s*=`,
        "g",
      );
      const defined = new Set(
        [...(definition ?? "").matchAll(definitionPattern)].map((match) => match[1] ?? match[2]),
      );
      expect(defined.size, `${module} exports`).toBeGreaterThan(0);

      const called = new Set(
        [...all.matchAll(new RegExp(`\\b${module}\\.([A-Za-z_0-9]+)\\b`, "g"))].map((m) => m[1]),
      );
      for (const name of called) {
        expect(defined.has(name), `${module}.${name} is called but not defined`).toBe(true);
      }
    }
  });

  it("answers the health check the way the plug-in reads it", async () => {
    const health = await raw("GET", "/v1/health");
    expect(health.status).toBe(200);

    // Session.diagnose prints these two.
    expect(jsonString(health.text, "version")).toBeTruthy();
    expect(jsonBool(health.text, "model_loaded")).toBeTypeOf("boolean");

    // Main.rs refuses to reuse an engine that lacks either capability.
    const capabilities = JSON.parse(health.text).data.capabilities as string[];
    expect(capabilities).toContain("lightroom-sessions");
    expect(capabilities).toContain("history");
  });

  it("accepts the session payload the exporter sends", async () => {
    const content = join(temp.root, "export.tiff.png");
    const samples = new Uint16Array(24 * 24 * 3);
    for (let i = 0; i < samples.length; i += 3) {
      samples[i] = 30000;
      samples[i + 1] = 20000;
      samples[i + 2] = 10000;
    }
    writeFileSync(content, await encodePng16(24, 24, samples));

    // Exactly the fields `EngineClient.createSession` builds in Session.lua.
    const created = await raw("POST", "/v1/lightroom/sessions", {
      content_path: content,
      label: "IMG_0001.CR3",
      strength: 1.0,
      output_path: join(temp.root, "IMG_0001_ColorFM.tif"),
      catalog_path: join(temp.root, "Catalog.lrcat"),
      photo_uuid: "uuid-abc",
      photo_name: "IMG_0001.CR3",
      raw_path: join(temp.root, "IMG_0001.CR3"),
    });

    // 201 for a new resource. The plug-in never looks at the status — `LrHttp`
    // hands back the body either way — but the value is part of the contract
    // for every other client, so it is pinned here.
    expect(created.status).toBe(201);
    expect(created.text).toContain('"ok":true');

    const id = jsonString(created.text, "id");
    expect(id).toMatch(/^s_/);
    // The scanner has no notion of nesting: it finds the first `"id"`.
    expect(id).toBe(JSON.parse(created.text).data.session.id);

    const listed = await raw("GET", "/v1/lightroom/sessions?active=1");
    const sessions = scanSessions(listed.text);
    expect(sessions.length).toBeGreaterThan(0);
    // A session with a source waits for the window to take it over.
    expect(sessions[0]).toMatchObject({ id, state: "waiting_for_ui", label: "IMG_0001.CR3" });

    // `EngineClient.getSession` builds this table; every field must be readable.
    const one = await raw("GET", `/v1/lightroom/sessions/${id}`);
    expect(jsonString(one.text, "state")).toBe("waiting_for_ui");
    expect(jsonString(one.text, "label")).toBe("IMG_0001.CR3");
    expect(jsonString(one.text, "content_path")).toBe(content);
    expect(jsonString(one.text, "raw_path")).toBe(join(temp.root, "IMG_0001.CR3"));
    expect(jsonNumber(one.text, "strength")).toBe(1);
    // Absent members stay absent rather than becoming `null`, which the
    // scanner would read as the string "null".
    expect(jsonString(one.text, "reference_path")).toBeUndefined();
    expect(jsonString(one.text, "result_path")).toBeUndefined();

    const claimed = await raw("POST", `/v1/lightroom/sessions/${id}/claim`);
    expect(jsonString(claimed.text, "state")).toBe("waiting_for_reference");
  });

  it("stores strength as f32, which is what the blend reads", async () => {
    // The value reaches the blend as a weight, so it has to be f32: a double
    // 0.8 shifts the blend by ~1e-8 and moves samples at the quantisation
    // boundary.
    const content = join(temp.root, "strength.tiff.png");
    const samples = new Uint16Array(16 * 16 * 3).fill(20000);
    writeFileSync(content, await encodePng16(16, 16, samples));

    const created = await raw("POST", "/v1/lightroom/sessions", {
      content_path: content,
      label: "strength.png",
      strength: 0.8,
    });
    expect(created.status).toBe(201);
    expect(created.text).toContain('"strength":0.800000011920929');

    const id = jsonString(created.text, "id");
    const one = await raw("GET", `/v1/lightroom/sessions/${id}`);
    expect(jsonNumber(one.text, "strength")).toBe(Math.fround(0.8));
  });

  it("keeps the replies compact, which the scanner requires", async () => {
    // `"id":"x"` is found by literal search; `JSON.stringify` with indentation
    // would produce `"id": "x"` and the plug-in would see no sessions at all.
    const listed = await raw("GET", "/v1/lightroom/sessions?active=1");
    expect(listed.text).not.toContain('"id": ');
    expect(listed.text).not.toMatch(/\n\s+"id"/);
    expect(scanSessions(listed.text).length).toBeGreaterThan(0);
  });

  it("reports a bad payload with a code the plug-in can show", async () => {
    const failed = await raw("POST", "/v1/lightroom/sessions", {});
    expect(failed.status).toBe(400);
    expect(jsonBool(failed.text, "ok")).toBe(false);
    // EngineClient.errorCode reads this and puts it in the dialog.
    expect(jsonString(failed.text, "code")).toBe("E_BAD_REQUEST");
  });
});
