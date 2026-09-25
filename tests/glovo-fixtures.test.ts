import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { redact } from "../src/glovo/recorder";

// Every committed Glovo fixture must be a fixed point of redact() and free of the patterns the discovery checklist greps for.
const DIR = new URL("./fixtures/glovo/", import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

test("there are Glovo fixtures", () => expect(files.length).toBeGreaterThan(10));

for (const f of files) {
  test(`${f} is already redacted and carries no personal patterns`, () => {
    const text = readFileSync(DIR + f, "utf8");
    const json = JSON.parse(text);
    expect(redact(json)).toEqual(json);
    expect(text).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);
    expect(text).not.toMatch(/\+995|\b5\d{8}\b/);
    expect(text).not.toMatch(/226551300|@gmail|@[a-z0-9-]+\.[a-z]{2,}"/i);
    expect(json.url).toMatch(/^https:\/\/api\.glovoapp\.com\//);
    expect(typeof json.endpoint).toBe("string");
  });
}
