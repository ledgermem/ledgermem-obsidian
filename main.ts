import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { LedgerMem } from "@ledgermem/memory";

export type SyncMode = "manual" | "on-save" | "interval";

export interface LedgerMemSettings {
  apiKey: string;
  workspaceId: string;
  syncMode: SyncMode;
  intervalMinutes: number;
}

export const DEFAULT_SETTINGS: LedgerMemSettings = {
  apiKey: "",
  workspaceId: "",
  syncMode: "on-save",
  intervalMinutes: 15,
};

const WIKILINK_REGEX = /\[\[([^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
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

export default class LedgerMemPlugin extends Plugin {
  settings!: LedgerMemSettings;
  private client: LedgerMem | null = null;
  private intervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildClient();

    this.addSettingTab(new LedgerMemSettingTab(this.app, this));

    this.addCommand({
      id: "ledgermem-backfill-vault",
      name: "LedgerMem: backfill vault",
      callback: () => this.backfillVault(),
    });

    this.addCommand({
      id: "ledgermem-sync-current",
      name: "LedgerMem: sync current note",
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
    const stored = (await this.loadData()) as Partial<LedgerMemSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.rebuildClient();
  }

  private rebuildClient(): void {
    if (this.settings.apiKey && this.settings.workspaceId) {
      this.client = new LedgerMem({
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
      new Notice("LedgerMem: API key or workspace not configured.");
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      await pushNote(client, { path: file.path, basename: file.basename }, content);
    } catch (err) {
      console.error("[ledgermem] sync failed", err);
      new Notice(`LedgerMem sync failed: ${(err as Error).message}`);
    }
  }

  async backfillVault(): Promise<void> {
    const client = this.getClient();
    if (!client) {
      new Notice("LedgerMem: API key or workspace not configured.");
      return;
    }
    const files = this.app.vault.getMarkdownFiles();
    new Notice(`LedgerMem: backfilling ${files.length} notes…`);
    let ok = 0;
    let fail = 0;
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        await pushNote(client, { path: file.path, basename: file.basename }, content);
        ok += 1;
      } catch (err) {
        fail += 1;
        console.error("[ledgermem] backfill error", file.path, err);
      }
    }
    new Notice(`LedgerMem backfill complete: ${ok} ok, ${fail} failed.`);
  }
}

class LedgerMemSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LedgerMemPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "LedgerMem" });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Your LedgerMem API key.")
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
      .setDesc("How notes are pushed to LedgerMem.")
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
