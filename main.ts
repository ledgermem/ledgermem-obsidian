import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { Mnemo } from "@mnemo/memory";

export type SyncMode = "manual" | "on-save" | "interval";

export interface MnemoSettings {
  apiKey: string;
  workspaceId: string;
  syncMode: SyncMode;
  intervalMinutes: number;
  /** Map of file path -> content hash, used to skip unchanged notes. */
  fileHashes: Record<string, string>;
}

export const DEFAULT_SETTINGS: MnemoSettings = {
  apiKey: "",
  workspaceId: "",
  syncMode: "on-save",
  intervalMinutes: 15,
  fileHashes: {},
};

// Lightweight non-cryptographic hash (FNV-1a) — adequate for change detection.
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// /g regex literal — must not be used with .exec() in a long-lived module
// because exec() mutates the regex's lastIndex. Obsidian fires vault.on
// "modify" while backfillVault may still be iterating, so two concurrent
// callers were racing on the shared lastIndex and producing missed +
// duplicated wikilinks. matchAll uses a per-iterator lastIndex and is safe
// to call concurrently against the same source RegExp.
const WIKILINK_REGEX = /\[\[([^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(WIKILINK_REGEX)) {
    const target = match[1].trim();
    if (target.length > 0) links.add(target);
  }
  return Array.from(links);
}

export interface MemoryClient {
  add(content: string, opts: { metadata: Record<string, unknown> }): Promise<unknown>;
}

export async function pushNote(
  client: MemoryClient,
  file: { path: string; basename: string },
  content: string,
): Promise<void> {
  const relations = extractWikilinks(content);
  await client.add(content, {
    metadata: {
      source: "obsidian",
      sourceId: file.basename,
      path: file.path,
      relations,
      syncedAt: new Date().toISOString(),
    },
  });
}

export default class MnemoPlugin extends Plugin {
  settings!: MnemoSettings;
  private client: Mnemo | null = null;
  private intervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildClient();

    this.addSettingTab(new MnemoSettingTab(this.app, this));

    this.addCommand({
      id: "getmnemo-backfill-vault",
      name: "Mnemo: backfill vault",
      callback: () => this.backfillVault(),
    });

    this.addCommand({
      id: "getmnemo-sync-current",
      name: "Mnemo: sync current note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.syncFile(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.settings.syncMode === "on-save" && file instanceof TFile && file.extension === "md") {
          void this.syncFile(file);
        }
      }),
    );

    this.registerInterval(
      window.setInterval(() => this.maybeRunInterval(), 60_000),
    );
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<MnemoSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.rebuildClient();
  }

  private rebuildClient(): void {
    if (this.settings.apiKey && this.settings.workspaceId) {
      this.client = new Mnemo({
        apiKey: this.settings.apiKey,
        workspaceId: this.settings.workspaceId,
      });
    } else {
      this.client = null;
    }
  }

  private maybeRunInterval(): void {
    if (this.settings.syncMode !== "interval") return;
    void this.backfillVault();
  }

  private getClient(): MemoryClient | null {
    return this.client;
  }

  async syncFile(file: TFile): Promise<void> {
    const client = this.getClient();
    if (!client) {
      new Notice("Mnemo: API key or workspace not configured.");
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      // Skip empty notes — saves API calls and keeps retrieval clean.
      if (content.trim().length === 0) return;
      const hash = hashContent(content);
      if (this.settings.fileHashes[file.path] === hash) return; // unchanged
      await pushNote(client, { path: file.path, basename: file.basename }, content);
      this.settings.fileHashes[file.path] = hash;
      await this.saveData(this.settings);
    } catch (err) {
      console.error("[getmnemo] sync failed", err);
      new Notice(`Mnemo sync failed: ${(err as Error).message}`);
    }
  }

  async backfillVault(): Promise<void> {
    const client = this.getClient();
    if (!client) {
      new Notice("Mnemo: API key or workspace not configured.");
      return;
    }
    const files = this.app.vault.getMarkdownFiles();
    // Garbage-collect hashes for notes that no longer exist in the vault.
    // Without this, fileHashes grows monotonically as users rename/delete
    // notes and the on-disk plugin data file balloons over time.
    const livePaths = new Set(files.map((f) => f.path));
    let prunedHashes = false;
    for (const knownPath of Object.keys(this.settings.fileHashes)) {
      if (!livePaths.has(knownPath)) {
        delete this.settings.fileHashes[knownPath];
        prunedHashes = true;
      }
    }
    if (prunedHashes) await this.saveData(this.settings);

    new Notice(`Mnemo: backfilling ${files.length} notes…`);
    let ok = 0;
    let fail = 0;
    let skipped = 0;
    // Persist hashes every PERSIST_EVERY notes so a crash mid-backfill doesn't
    // throw away progress for the entire vault.
    const PERSIST_EVERY = 25;
    let sinceLastPersist = 0;
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        // Skip empty notes — they pollute retrieval with no signal.
        if (content.trim().length === 0) {
          skipped += 1;
          continue;
        }
        const hash = hashContent(content);
        if (this.settings.fileHashes[file.path] === hash) {
          skipped += 1;
          continue;
        }
        await pushNote(client, { path: file.path, basename: file.basename }, content);
        this.settings.fileHashes[file.path] = hash;
        ok += 1;
        sinceLastPersist += 1;
        if (sinceLastPersist >= PERSIST_EVERY) {
          await this.saveData(this.settings);
          sinceLastPersist = 0;
        }
      } catch (err) {
        fail += 1;
        console.error("[getmnemo] backfill error", file.path, err);
      }
    }
    await this.saveData(this.settings);
    new Notice(`Mnemo backfill: ${ok} pushed, ${skipped} unchanged, ${fail} failed.`);
  }
}

class MnemoSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MnemoPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Mnemo" });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Your Mnemo API key.")
      .addText((t) =>
        t
          .setPlaceholder("lm_live_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Workspace ID")
      .setDesc("Target workspace for synced memories.")
      .addText((t) =>
        t
          .setPlaceholder("ws_…")
          .setValue(this.plugin.settings.workspaceId)
          .onChange(async (v) => {
            this.plugin.settings.workspaceId = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("How notes are pushed to Mnemo.")
      .addDropdown((d) =>
        d
          .addOption("manual", "Manual (commands only)")
          .addOption("on-save", "On note save")
          .addOption("interval", "Interval backfill")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (v) => {
            this.plugin.settings.syncMode = v as SyncMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Interval (minutes)")
      .setDesc("Used when sync mode is 'interval'.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.intervalMinutes = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
