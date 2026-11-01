// Agent action dispatch tests: each tool's effect on the session, the
// engine and the messages pushed to the phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentActions, type ActionContext } from "./actions.js";
import { DecisionEngine } from "./decision.js";
import type { DownMessage } from "./protocol.js";
import { Session } from "./session.js";

function makeCtx(): ActionContext & { sent: DownMessage[]; cashChecks: number } {
  const ctx = {
    session: new Session(),
    engine: new DecisionEngine(),
    sent: [] as DownMessage[],
    cashChecks: 0,
    send(msg: DownMessage): void {
      ctx.sent.push(msg);
    },
    async cashCheck(): Promise<string> {
      ctx.cashChecks++;
      return "MOCK CASH";
    },
  };
  return ctx;
}

test("look_around toggles the session and pushes state", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "look_around", on: true }], ctx);
  assert.equal(ctx.session.lookAround, true);
  assert.equal(ctx.session.sceneState.lookAround, true);
  assert.deepEqual(ctx.sent, [
    { type: "state", lookAround: true, muted: false, agentBusy: false, lang: "pa" },
  ]);
  await applyAgentActions([{ tool: "look_around", on: false }], ctx);
  assert.equal(ctx.session.lookAround, false);
});

test("mute toggles the engine and the session, and pushes state", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "mute", on: true }], ctx);
  assert.equal(ctx.engine.isMuted(), true);
  assert.equal(ctx.session.muted, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal((ctx.sent[0] as { muted: boolean }).muted, true);
});

test("cash_check speaks the fresh read as P1", async () => {
  const ctx = makeCtx();
  await applyAgentActions([{ tool: "cash_check" }], ctx);
  assert.equal(ctx.cashChecks, 1);
  const speaks = ctx.engine.takeSpeak();
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0]?.text, "MOCK CASH");
  assert.equal(speaks[0]?.priority, "P1");
});

test("prompt 06/07 tools log and change nothing", async () => {
  const ctx = makeCtx();
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await applyAgentActions(
      [
        { tool: "remember_person", ref: "P1", name: "Pardeep" },
        { tool: "confirm_consent", name: "Pardeep", granted: true },
        { tool: "forget_person", name: "Pardeep" },
        { tool: "find", noun: "Kainchi" },
      ],
      ctx
    );
  } finally {
    console.log = origLog;
  }
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.engine.takeSpeak().length, 0);
  assert.ok(lines.some((l) => l.includes("remember_person stub (prompt 06)")));
  assert.ok(lines.some((l) => l.includes("confirm_consent stub (prompt 06)")));
  assert.ok(lines.some((l) => l.includes("forget_person stub (prompt 06)")));
  assert.ok(lines.some((l) => l.includes("find stub (prompt 07)")));
});
