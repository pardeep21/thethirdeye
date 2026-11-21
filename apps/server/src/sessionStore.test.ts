// SessionStore tests: resume within 60 s keeps context, a longer gap or
// an unknown device starts fresh, and resume consumes the entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./session.js";
import { SESSION_RESUME_MS, SessionStore } from "./sessionStore.js";

test("resume within 60 s returns the same session", () => {
  const store = new SessionStore();
  const s = new Session();
  s.lang = "en";
  s.muted = true;
  s.pushTurn({ role: "user", text: "hi" });
  store.keep("s23", s, 1000);
  const got = store.resume("s23", 1000 + SESSION_RESUME_MS - 1);
  assert.equal(got, s);
  assert.equal(got?.lang, "en");
  assert.equal(got?.muted, true);
  assert.equal(got?.history.length, 1);
});

test("resume after 60 s starts fresh", () => {
  const store = new SessionStore();
  store.keep("s23", new Session(), 1000);
  assert.equal(store.resume("s23", 1000 + SESSION_RESUME_MS), null);
  assert.equal(store.resume("s23", 1000 + SESSION_RESUME_MS + 5000), null);
});

test("unknown device starts fresh and resume consumes the entry", () => {
  const store = new SessionStore();
  assert.equal(store.resume("never-seen", 1000), null);
  const s = new Session();
  store.keep("s23", s, 1000);
  assert.equal(store.resume("s23", 2000), s);
  assert.equal(store.resume("s23", 3000), null);
});

test("a newer disconnect replaces the parked session", () => {
  const store = new SessionStore();
  const old = new Session();
  const fresh = new Session();
  store.keep("s23", old, 1000);
  store.keep("s23", fresh, 2000);
  assert.equal(store.resume("s23", 3000), fresh);
});
