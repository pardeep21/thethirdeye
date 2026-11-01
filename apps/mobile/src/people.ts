// Enrolled-people list over REST: shared by PeopleScreen and EnrollScreen.
import { useCallback, useEffect, useState } from "react";
import { httpJson, wsToHttp } from "./http";

export interface Person {
  id: number;
  name: string;
  faces: number;
}

function asPeople(v: unknown): Person[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    if (typeof p !== "object" || p === null) return [];
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.faces !== "number") return [];
    return [{ id: r.id, name: r.name, faces: r.faces }];
  });
}

export function usePeople(serverUrl: string): {
  people: Person[];
  refresh(): Promise<void>;
  removePerson(id: number): Promise<void>;
} {
  const [people, setPeople] = useState<Person[]>([]);
  const base = (() => {
    try {
      return wsToHttp(serverUrl);
    } catch {
      return "";
    }
  })();

  const refresh = useCallback(async () => {
    if (!base) return;
    try {
      const res = await httpJson(`${base}/people`);
      if (res.status === 200) setPeople(asPeople(res.json));
    } catch {
      // List is best-effort.
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removePerson = useCallback(
    async (id: number) => {
      if (!base) return;
      try {
        await httpJson(`${base}/people/${id}`, { method: "DELETE" });
      } finally {
        await refresh();
      }
    },
    [base, refresh]
  );

  return { people, refresh, removePerson };
}
