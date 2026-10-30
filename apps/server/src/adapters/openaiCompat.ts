// OpenAI-compatible vision provider: one client for the Meta Model API,
// OpenRouter-served Muse, plain OpenAI, or a local Ollama server.
// Base URL, model and key come from env (see factory below). Compile-only in
// this repo's tests: no test in this file touches the network.
import OpenAI from "openai";
import type { Denomination, TriagePerson, TriageResult } from "../protocol.js";
import type { NamedTriage, VisionAnswer } from "./index.js";

export const TRIAGE_MAX_TOKENS = 80;
export const ANSWER_MAX_TOKENS = 150;

export const TRIAGE_SYSTEM_PROMPT = [
  "You are a vision module for a blind shopkeeper's assistant.",
  "Look at the image and return ONLY a JSON object with this exact shape, no other text:",
  '{"notes":[{"denomination":10|20|50|100|200|500|null,"confidence":0-1}],"people":[{"position":"left"|"centre"|"right","distance":"near"|"far","gender":"man"|"woman"|null,"age_range":"<like 20s or 60+ or null>","action":"<short, e.g. handing a note, or null>"}]}',
  "Rules: Indian rupee notes only; use null denomination when a note-like object is unclear (never guess the value); confidence is your certainty 0..1; omit people you cannot see; never name anyone.",
].join(" ");

const DENOMS: Denomination[] = [10, 20, 50, 100, 200, 500];

/** Strict parse of model JSON into TriageResult; throws on any shape violation. */
export function parseTriageResult(text: string): TriageResult {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("triage output is not JSON");
    try {
      obj = JSON.parse(m[0]);
    } catch {
      throw new Error("triage output is not JSON");
    }
  }
  if (typeof obj !== "object" || obj === null) throw new Error("triage output must be an object");
  const root = obj as Record<string, unknown>;
  const notesRaw = root.notes ?? [];
  const peopleRaw = root.people ?? [];
  if (!Array.isArray(notesRaw)) throw new Error("triage.notes must be an array");
  if (!Array.isArray(peopleRaw)) throw new Error("triage.people must be an array");

  const notes = notesRaw.map((n, i) => {
    if (typeof n !== "object" || n === null) throw new Error(`triage.notes[${i}] must be an object`);
    const rec = n as Record<string, unknown>;
    const d = rec.denomination;
    if (d !== null && (typeof d !== "number" || !DENOMS.includes(d as Denomination))) {
      throw new Error(`triage.notes[${i}].denomination must be 10|20|50|100|200|500|null`);
    }
    const c = rec.confidence;
    if (typeof c !== "number" || Number.isNaN(c)) {
      throw new Error(`triage.notes[${i}].confidence must be a number`);
    }
    return { denomination: d as Denomination | null, confidence: Math.min(1, Math.max(0, c)) };
  });

  const people: TriagePerson[] = peopleRaw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new Error(`triage.people[${i}] must be an object`);
    const rec = p as Record<string, unknown>;
    if (rec.position !== "left" && rec.position !== "centre" && rec.position !== "right") {
      throw new Error(`triage.people[${i}].position must be left|centre|right`);
    }
    if (rec.distance !== "near" && rec.distance !== "far") {
      throw new Error(`triage.people[${i}].distance must be near|far`);
    }
    const person: TriagePerson = { position: rec.position, distance: rec.distance };
    if (rec.gender !== undefined && rec.gender !== null) {
      if (rec.gender !== "man" && rec.gender !== "woman") {
        throw new Error(`triage.people[${i}].gender must be man|woman|null`);
      }
      person.gender = rec.gender;
    }
    if (rec.age_range !== undefined && rec.age_range !== null) {
      if (typeof rec.age_range !== "string") throw new Error(`triage.people[${i}].age_range must be a string`);
      person.age_range = rec.age_range;
    }
    if (rec.action !== undefined && rec.action !== null) {
      if (typeof rec.action !== "string") throw new Error(`triage.people[${i}].action must be a string`);
      person.action = rec.action;
    }
    return person;
  });

  return { notes, people };
}

export interface OpenAICompatOptions {
  baseURL: string;
  model: string;
  apiKey: string;
}

function toDataUrl(img: Buffer): string {
  return `data:image/jpeg;base64,${img.toString("base64")}`;
}

export class OpenAICompatTriage implements NamedTriage {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private lastUsage: { promptTokens: number; completionTokens: number } | undefined;

  constructor(opts: OpenAICompatOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.name = `openai-compat:${opts.model}`;
    this.lastUsage = undefined;
  }

  async triage(img: Buffer): Promise<TriageResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: TRIAGE_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRIAGE_SYSTEM_PROMPT },
            { type: "image_url", image_url: { url: toDataUrl(img) } },
          ],
        },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const u = res.usage;
    this.lastUsage = u ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens } : undefined;
    return parseTriageResult(text);
  }

  getLastUsage(): { promptTokens: number; completionTokens: number } | undefined {
    return this.lastUsage;
  }
}

export class OpenAICompatAnswer implements VisionAnswer {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAICompatOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
  }

  private async ask(img: Buffer, prompt: string, maxTokens: number): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: toDataUrl(img) } },
          ],
        },
      ],
    });
    return (res.choices[0]?.message?.content ?? "").trim();
  }

  async describe(img: Buffer, q: string): Promise<string> {
    return this.ask(
      img,
      `Describe this shop photo for a blind shopkeeper in under 15 words. Question: ${q}`,
      ANSWER_MAX_TOKENS
    );
  }

  async read(img: Buffer): Promise<string> {
    return this.ask(
      img,
      "Read the key text on this label: product name, price, expiry date first. Short answer.",
      ANSWER_MAX_TOKENS
    );
  }
}
