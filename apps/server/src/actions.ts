// Agent action dispatch (prompt 02): executes the tools the JSON-action
// agent returns. remember/consent/forget (prompt 06) and find (prompt 07)
// are stubs that log; the rest take effect immediately.
import type { DownMessage } from "./protocol.js";
import type { AgentAction } from "./adapters/agent.js";
import type { DecisionEngine } from "./decision.js";
import type { Session } from "./session.js";

export interface ActionContext {
  session: Session;
  engine: DecisionEngine;
  send: (msg: DownMessage) => void;
  /** Fresh cash read; reuses the howmuch path. */
  cashCheck: () => Promise<string>;
}

function pushState(ctx: ActionContext): void {
  ctx.send({
    type: "state",
    lookAround: ctx.session.lookAround,
    muted: ctx.session.muted,
    agentBusy: ctx.session.agentBusy,
    lang: ctx.session.lang,
  });
}

export async function applyAgentActions(actions: AgentAction[], ctx: ActionContext): Promise<void> {
  for (const a of actions) {
    switch (a.tool) {
      case "look_around":
        ctx.session.lookAround = a.on;
        ctx.session.sceneState.lookAround = a.on;
        pushState(ctx);
        break;
      case "mute":
        ctx.engine.setMuted(a.on);
        ctx.session.muted = a.on;
        pushState(ctx);
        break;
      case "cash_check":
        ctx.engine.answer(await ctx.cashCheck(), ctx.session.lang);
        break;
      case "find":
        console.log(`find stub (prompt 07): ${a.noun}`);
        break;
      case "remember_person":
        console.log(`remember_person stub (prompt 06): ref=${a.ref} name=${a.name}`);
        break;
      case "confirm_consent":
        console.log(`confirm_consent stub (prompt 06): name=${a.name} granted=${a.granted}`);
        break;
      case "forget_person":
        console.log(`forget_person stub (prompt 06): name=${a.name}`);
        break;
    }
  }
}
