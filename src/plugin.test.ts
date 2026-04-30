import { describe, expect, it, vi } from "vitest";
import { extractWikilinks, pushNote, type MemoryClient } from "../main.js";

vi.mock("@mnemo/memory", () => ({
  Mnemo: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
}));

vi.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
  },
  Notice: class {},
  TFile: class {},
  App: class {},
}));

describe("extractWikilinks", () => {
  it("returns unique link targets", () => {
    const links = extractWikilinks("See [[Alpha]] and [[Beta|nick]] and [[Alpha]] again.");
    expect(links.sort()).toEqual(["Alpha", "Beta"]);
  });

  it("strips heading anchors", () => {
    expect(extractWikilinks("[[Note#Heading]]")).toEqual(["Note"]);
  });

  it("returns empty array when no links", () => {
    expect(extractWikilinks("plain text")).toEqual([]);
  });
});

describe("pushNote", () => {
  it("calls add with obsidian metadata and relations", async () => {
    const add = vi.fn().mockResolvedValue({ id: "mem_1" });
    const client: MemoryClient = { add };

    await pushNote(client, { path: "Folder/Note.md", basename: "Note" }, "body with [[Other]]");

    expect(add).toHaveBeenCalledTimes(1);
    const [content, opts] = add.mock.calls[0];
    expect(content).toBe("body with [[Other]]");
    expect(opts.metadata.source).toBe("obsidian");
    expect(opts.metadata.sourceId).toBe("Note");
    expect(opts.metadata.path).toBe("Folder/Note.md");
    expect(opts.metadata.relations).toEqual(["Other"]);
    expect(typeof opts.metadata.syncedAt).toBe("string");
  });
});
