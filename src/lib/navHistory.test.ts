import { describe, expect, it } from "vitest";
import { dropPlaces, emptyHistory, MAX_PLACES, recordPlace, renamePlaces, stepPlace, type History, type Place } from "./navHistory";

const at = (path: string, line: number, column = 1): Place => ({ path, line, column });
const record = (...ps: Place[]) => ps.reduce(recordPlace, emptyHistory());

describe("recordPlace", () => {
  it("updates the current place for a move nearby in the same file", () => {
    const h = record(at("a", 5), at("a", 9, 3));
    expect(h.places).toEqual([at("a", 9, 3)]);
    expect(h.index).toBe(0);
  });

  it("follows a caret moved line by line, however far it ends up", () => {
    let h = emptyHistory();
    for (let line = 1; line <= 100; line++) h = recordPlace(h, at("a", line));
    expect(h.places).toEqual([at("a", 100)]);
  });

  it("adds a place for a jump in the same file or to another file", () => {
    const h = record(at("a", 5), at("a", 200), at("b", 3));
    expect(h.places).toEqual([at("a", 5), at("a", 200), at("b", 3)]);
    expect(h.index).toBe(2);
  });

  it("returns the same history when nothing moved", () => {
    const h = record(at("a", 5));
    expect(recordPlace(h, at("a", 5))).toBe(h);
  });

  it("drops the places ahead when a new one is added after going back", () => {
    const back = stepPlace(record(at("a", 5), at("b", 1), at("c", 1)), -1)!.history;
    const h = recordPlace(back, at("d", 1));
    expect(h.places).toEqual([at("a", 5), at("b", 1), at("d", 1)]);
    expect(h.index).toBe(2);
  });

  it("keeps the places ahead for a move nearby after going back", () => {
    const back = stepPlace(record(at("a", 5), at("b", 1)), -1)!.history;
    const h = recordPlace(back, at("a", 7));
    expect(h.places).toEqual([at("a", 7), at("b", 1)]);
    expect(h.index).toBe(0);
  });

  it("keeps the latest places", () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_PLACES + 5; i++) h = recordPlace(h, at(`f${i}`, 1));
    expect(h.places.length).toBe(MAX_PLACES);
    expect(h.places[0].path).toBe("f5");
    expect(h.index).toBe(MAX_PLACES - 1);
  });
});

describe("stepPlace", () => {
  const h = record(at("a", 1), at("b", 1), at("c", 1));

  it("goes back and forward", () => {
    const b = stepPlace(h, -1)!;
    expect(b.place).toEqual(at("b", 1));
    const a = stepPlace(b.history, -1)!;
    expect(a.place).toEqual(at("a", 1));
    expect(stepPlace(a.history, -1)).toBeNull();
    expect(stepPlace(a.history, 1)!.place).toEqual(at("b", 1));
    expect(stepPlace(h, 1)).toBeNull();
  });

  it("skips places it cannot use", () => {
    expect(stepPlace(h, -1, (p) => p.path !== "b")!.place).toEqual(at("a", 1));
    expect(stepPlace(h, -1, () => false)).toBeNull();
  });

  it("has nowhere to go in an empty history", () => {
    expect(stepPlace(emptyHistory(), -1)).toBeNull();
    expect(stepPlace(emptyHistory(), 1)).toBeNull();
  });
});

describe("dropPlaces", () => {
  it("removes the places of deleted files and keeps the current one", () => {
    const h: History = { places: [at("a", 1), at("b", 1), at("c", 1)], index: 2 };
    expect(dropPlaces(h, (p) => p === "b")).toEqual({ places: [at("a", 1), at("c", 1)], index: 1 });
  });

  it("moves back when the current place goes", () => {
    const h: History = { places: [at("a", 1), at("b", 1), at("c", 1)], index: 1 };
    expect(dropPlaces(h, (p) => p === "b")).toEqual({ places: [at("a", 1), at("c", 1)], index: 0 });
  });

  it("merges neighbours that became the same place", () => {
    const h: History = { places: [at("a", 1), at("b", 1), at("a", 1)], index: 2 };
    expect(dropPlaces(h, (p) => p === "b")).toEqual({ places: [at("a", 1)], index: 0 });
  });

  it("empties", () => {
    expect(dropPlaces(record(at("a", 1)), () => true)).toEqual({ places: [], index: -1 });
  });
});

describe("renamePlaces", () => {
  it("rewrites paths", () => {
    const h = record(at("/p/a.cs", 1), at("/p/b.cs", 1));
    expect(renamePlaces(h, (p) => (p === "/p/a.cs" ? "/p/c.cs" : p)).places).toEqual([at("/p/c.cs", 1), at("/p/b.cs", 1)]);
    expect(renamePlaces(h, (p) => p)).toBe(h);
  });
});
