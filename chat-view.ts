import {
  App,
  ItemView,
  MarkdownView,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type CowriterPlugin from "./main";

export const COWRITER_CHAT_VIEW_TYPE = "cowriter-chat";

export interface ContextItem {
  id: string;
  type: "file" | "folder" | "active-note";
  path: string;
  label: string;
}

interface ChatPrompt {
  title: string;
  description: string;
  template: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSessionRecord {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  contextItems: ContextItem[];
}

const SUGGESTED_PROMPTS: ChatPrompt[] = [
  {
    title: "Active note insights",
    description: "Give me a quick recap of the active note in two sentences.",
    template: "Give me a quick recap of the active note in two sentences."
  },
  {
    title: "Connect the dots",
    description: "How does the active note relate to the other notes I attached?",
    template: "How does the active note relate to the other notes I attached? Surface themes and gaps."
  },
  {
    title: "Outline next steps",
    description: "Turn the attached context into a concise action plan.",
    template: "Turn the attached context into a concise action plan with bullet points."
  }
];

export class CowriterChatView extends ItemView {
  private activeSessionId = "";
  private contextItems: ContextItem[] = [];
  private messages: ChatMessage[] = [];
  private mentionQuery = "";
  private mentionStart = -1;
  private mentionMenuEl: HTMLElement | null = null;
  private mentionSearchEl: HTMLInputElement | null = null;
  private historyMenuEl: HTMLElement | null = null;

  private messagesEl!: HTMLElement;
  private contextRowEl!: HTMLElement;
  private tagsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private plugin: CowriterPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return COWRITER_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Cowriter";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("cowriter-chat-root");

    this.renderHeader(root);
    this.renderSuggestedPrompts(root);
    this.renderMessages(root);
    this.renderComposer(root);
    await this.loadActiveSession();
    await this.syncActiveNoteTag();
  }

  async onClose(): Promise<void> {
    this.closeMentionMenu();
    this.closeHistoryMenu();
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "cowriter-chat-header" });
    header.createDiv({ cls: "cowriter-chat-header-title", text: "Cowriter chat" });
    const actions = header.createDiv({ cls: "cowriter-chat-header-actions" });

    const settingsBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Open Cowriter settings" }
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      const appWithSetting = this.app as App & {
        setting?: { open(): void; openTabById(id: string): void };
      };
      appWithSetting.setting?.open();
      appWithSetting.setting?.openTabById(this.plugin.manifest.id);
    });

    const historyBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Chat history" }
    });
    setIcon(historyBtn, "history");
    historyBtn.addEventListener("click", (event) => {
      this.toggleHistoryMenu(event.currentTarget as HTMLElement);
    });

    const newBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New chat" }
    });
    setIcon(newBtn, "plus-circle");
    newBtn.addEventListener("click", () => {
      this.startNewSession();
    });

    const clearBtn = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Clear chat" }
    });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => {
      this.messages = [];
      this.renderMessageList();
      this.persistSession();
    });
  }

  private async loadActiveSession(): Promise<void> {
    let session = this.plugin.getActiveChatSession();
    if (!session) {
      session = this.plugin.createChatSession();
    }
    this.applySession(session);
  }

  private applySession(session: ChatSessionRecord): void {
    this.activeSessionId = session.id;
    this.messages = [...session.messages];
    this.contextItems = [...session.contextItems];
    this.renderMessageList();
    this.renderContextTags();
  }

  private startNewSession(): void {
    const session = this.plugin.createChatSession();
    this.applySession(session);
    void this.syncActiveNoteTag();
    this.inputEl?.focus();
  }

  private switchSession(sessionId: string): void {
    const session = this.plugin.getChatSession(sessionId);
    if (!session) {
      return;
    }
    this.plugin.setActiveChatSession(sessionId);
    this.applySession(session);
    void this.syncActiveNoteTag();
    this.closeHistoryMenu();
  }

  private deleteSession(sessionId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.plugin.deleteChatSession(sessionId);
    if (this.activeSessionId === sessionId) {
      const next = this.plugin.getActiveChatSession() ?? this.plugin.createChatSession();
      this.applySession(next);
      void this.syncActiveNoteTag();
    }
    this.renderHistoryMenu();
  }

  private getSessionTitle(): string {
    const firstUser = this.messages.find((message) => message.role === "user");
    if (firstUser) {
      const text = firstUser.content.trim();
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    }
    return "New chat";
  }

  private persistSession(): void {
    this.plugin.saveChatSession({
      id: this.activeSessionId,
      title: this.getSessionTitle(),
      updatedAt: Date.now(),
      messages: this.messages,
      contextItems: this.contextItems
    });
  }

  private toggleHistoryMenu(anchor: HTMLElement): void {
    if (this.historyMenuEl && !this.historyMenuEl.hidden) {
      this.closeHistoryMenu();
      return;
    }
    this.renderHistoryMenu(anchor);
  }

  private renderHistoryMenu(anchor?: HTMLElement): void {
    if (!this.historyMenuEl) {
      this.historyMenuEl = this.containerEl.createDiv({ cls: "cowriter-chat-history-menu" });
    }

    this.historyMenuEl.empty();
    const sessions = this.plugin.getChatSessions();

    if (sessions.length === 0) {
      this.historyMenuEl.createDiv({
        cls: "cowriter-chat-history-empty",
        text: "No previous chats yet."
      });
    } else {
      for (const session of sessions) {
        const row = this.historyMenuEl.createDiv({
          cls: `cowriter-chat-history-item${session.id === this.activeSessionId ? " is-active" : ""}`
        });
        row.createDiv({ cls: "cowriter-chat-history-title", text: session.title || "New chat" });
        row.createDiv({
          cls: "cowriter-chat-history-meta",
          text: formatSessionDate(session.updatedAt)
        });
        const deleteBtn = row.createEl("button", {
          cls: "clickable-icon cowriter-chat-history-delete",
          attr: { "aria-label": "Delete chat" }
        });
        setIcon(deleteBtn, "trash-2");
        deleteBtn.addEventListener("click", (event) => {
          this.deleteSession(session.id, event);
        });
        row.addEventListener("click", () => {
          this.switchSession(session.id);
        });
      }
    }

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const containerRect = this.containerEl.getBoundingClientRect();
      this.historyMenuEl.style.top = `${rect.bottom - containerRect.top + 6}px`;
      this.historyMenuEl.style.right = `${containerRect.right - rect.right}px`;
    }

    this.historyMenuEl.show();
  }

  private closeHistoryMenu(): void {
    if (this.historyMenuEl) {
      this.historyMenuEl.hide();
    }
  }

  private renderSuggestedPrompts(container: HTMLElement): void {
    const section = container.createDiv({ cls: "cowriter-chat-prompts" });
    section.createDiv({ cls: "cowriter-chat-section-title", text: "Suggested prompts" });

    for (const prompt of SUGGESTED_PROMPTS) {
      const card = section.createDiv({ cls: "cowriter-chat-prompt-card" });
      const top = card.createDiv({ cls: "cowriter-chat-prompt-top" });
      top.createDiv({ cls: "cowriter-chat-prompt-title", text: prompt.title });
      const addBtn = top.createEl("button", {
        cls: "clickable-icon cowriter-chat-prompt-add",
        attr: { "aria-label": "Use prompt" }
      });
      setIcon(addBtn, "plus");
      card.createDiv({ cls: "cowriter-chat-prompt-desc", text: prompt.description });
      addBtn.addEventListener("click", () => {
        this.inputEl.value = prompt.template;
        this.inputEl.focus();
        this.ensureActiveNoteContext();
      });
    }
  }

  private renderMessages(container: HTMLElement): void {
    this.messagesEl = container.createDiv({ cls: "cowriter-chat-messages" });
    this.renderMessageList();
  }

  private renderComposer(container: HTMLElement): void {
    const composer = container.createDiv({ cls: "cowriter-chat-composer" });

    this.contextRowEl = composer.createDiv({ cls: "cowriter-chat-context-row" });
    this.tagsEl = this.contextRowEl.createDiv({ cls: "cowriter-chat-tags" });
    this.renderContextTags();

    const inputWrap = composer.createDiv({ cls: "cowriter-chat-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "cowriter-chat-input",
      attr: {
        rows: "4",
        placeholder: "Your AI assistant for Obsidian • @ to add context • Enter to send, Shift+Enter for newline"
      }
    });

    this.inputEl.addEventListener("input", () => {
      this.handleInputChange();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.mentionMenuEl && !this.mentionMenuEl.hidden) {
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeMentionMenu();
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          this.pickFirstMentionResult();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey && !this.mentionMenuEl) {
        event.preventDefault();
        void this.sendMessage();
      }
    });

    const footer = composer.createDiv({ cls: "cowriter-chat-footer" });
    this.sendButton = footer.createEl("button", { cls: "mod-cta cowriter-chat-send", text: "Send" });
    this.sendButton.addEventListener("click", () => {
      void this.sendMessage();
    });
  }

  private renderMessageList(): void {
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.messagesEl.createDiv({
        cls: "cowriter-chat-empty",
        text: "Ask Cowriter anything about your notes. Use @ to attach files or folders."
      });
      return;
    }

    for (const message of this.messages) {
      const bubble = this.messagesEl.createDiv({
        cls: `cowriter-chat-message cowriter-chat-message-${message.role}`
      });
      bubble.createDiv({ cls: "cowriter-chat-message-role", text: message.role === "user" ? "You" : "Cowriter" });
      bubble.createDiv({ cls: "cowriter-chat-message-body", text: message.content });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderContextTags(): void {
    this.tagsEl.empty();
    if (this.contextItems.length === 0) {
      this.contextRowEl.hide();
      return;
    }
    this.contextRowEl.show();
    for (const item of this.contextItems) {
      const tag = this.tagsEl.createDiv({ cls: "cowriter-chat-tag" });
      const iconEl = tag.createSpan({ cls: "cowriter-chat-tag-icon" });
      setIcon(iconEl, item.type === "folder" ? "folder" : "file-text");
      tag.createSpan({ cls: "cowriter-chat-tag-label", text: item.label });
      const removeBtn = tag.createEl("button", {
        cls: "clickable-icon cowriter-chat-tag-remove",
        attr: { "aria-label": "Remove context" }
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        this.contextItems = this.contextItems.filter((entry) => entry.id !== item.id);
        this.renderContextTags();
        this.persistSession();
      });
    }
  }

  async syncActiveNoteTag(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const existing = this.contextItems.find((item) => item.type === "active-note");
    if (!activeFile) {
      if (existing) {
        this.contextItems = this.contextItems.filter((item) => item.type !== "active-note");
        this.renderContextTags();
        this.persistSession();
      }
      return;
    }
    if (!existing) {
      return;
    }
    if (existing && existing.path === activeFile.path) {
      return;
    }
    this.contextItems = this.contextItems.filter((item) => item.type !== "active-note");
    this.contextItems.unshift({
      id: "active-note",
      type: "active-note",
      path: activeFile.path,
      label: `${activeFile.basename} (active)`
    });
    this.renderContextTags();
    this.persistSession();
  }

  private ensureActiveNoteContext(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }
    if (!this.contextItems.some((item) => item.type === "active-note")) {
      this.contextItems.unshift({
        id: "active-note",
        type: "active-note",
        path: activeFile.path,
        label: `${activeFile.basename} (active)`
      });
      this.renderContextTags();
      this.persistSession();
    }
  }

  private handleInputChange(): void {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex === -1) {
      this.closeMentionMenu();
      return;
    }
    const afterAt = beforeCursor.slice(atIndex + 1);
    if (/\s/.test(afterAt)) {
      this.closeMentionMenu();
      return;
    }
    this.mentionStart = atIndex;
    this.mentionQuery = afterAt;
    this.openMentionMenu(afterAt);
  }

  private openMentionMenu(query: string): void {
    if (!this.mentionMenuEl) {
      this.mentionMenuEl = this.containerEl.createDiv({ cls: "cowriter-chat-mention-menu" });
      const categories = this.mentionMenuEl.createDiv({ cls: "cowriter-chat-mention-categories" });

      this.addMentionCategory(categories, "Active note", "file-clock", () => {
        this.addActiveNoteContext();
        this.finishMentionPick();
      });
      this.addMentionCategory(categories, "Notes", "file-text", () => {
        this.showMentionResults("files");
      });
      this.addMentionCategory(categories, "Folders", "folder", () => {
        this.showMentionResults("folders");
      });

      const searchWrap = this.mentionMenuEl.createDiv({ cls: "cowriter-chat-mention-search-wrap" });
      this.mentionSearchEl = searchWrap.createEl("input", {
        type: "text",
        cls: "cowriter-chat-mention-search",
        attr: { placeholder: "Search..." }
      });
      this.mentionSearchEl.addEventListener("input", () => {
        this.mentionQuery = this.mentionSearchEl?.value ?? "";
        const mode = this.mentionMenuEl?.dataset.mode === "folders" ? "folders" : "files";
        this.showMentionResults(mode);
      });

      this.mentionMenuEl.createDiv({ cls: "cowriter-chat-mention-results" });
    }

    this.mentionMenuEl.show();
    this.mentionMenuEl.dataset.mode = "files";
    if (this.mentionSearchEl) {
      this.mentionSearchEl.value = query;
    }
    this.showMentionResults("files");
  }

  private addMentionCategory(
    parent: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void
  ): void {
    const row = parent.createDiv({ cls: "cowriter-chat-mention-category" });
    const iconEl = row.createSpan({ cls: "cowriter-chat-mention-category-icon" });
    setIcon(iconEl, icon);
    row.createSpan({ text: label });
    row.createSpan({ cls: "cowriter-chat-mention-chevron", text: "›" });
    row.addEventListener("click", onClick);
  }

  private showMentionResults(mode: "files" | "folders"): void {
    if (!this.mentionMenuEl) {
      return;
    }
    this.mentionMenuEl.dataset.mode = mode;
    const resultsEl = this.mentionMenuEl.querySelector(".cowriter-chat-mention-results") as HTMLElement;
    resultsEl.empty();

    const query = (this.mentionSearchEl?.value ?? this.mentionQuery).trim().toLowerCase();
    const items =
      mode === "folders" ? this.getFolderCandidates(query) : this.getFileCandidates(query);

    if (items.length === 0) {
      resultsEl.createDiv({ cls: "cowriter-chat-mention-empty", text: "No matches" });
      return;
    }

    for (const item of items.slice(0, 40)) {
      const row = resultsEl.createDiv({ cls: "cowriter-chat-mention-result" });
      const iconEl = row.createSpan({ cls: "cowriter-chat-mention-result-icon" });
      setIcon(iconEl, mode === "folders" ? "folder" : "file-text");
      row.createSpan({ cls: "cowriter-chat-mention-result-label", text: item.label });
      row.createSpan({ cls: "cowriter-chat-mention-result-path", text: item.path });
      row.addEventListener("click", () => {
        this.addContextItem(item);
        this.finishMentionPick();
      });
    }
  }

  private getFileCandidates(query: string): ContextItem[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => !query || file.path.toLowerCase().includes(query) || file.basename.toLowerCase().includes(query))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({
        id: `file:${file.path}`,
        type: "file" as const,
        path: file.path,
        label: file.basename
      }));
  }

  private getFolderCandidates(query: string): ContextItem[] {
    const folders: ContextItem[] = [];
    const visit = (folder: TFolder) => {
      if (!query || folder.path.toLowerCase().includes(query) || folder.name.toLowerCase().includes(query)) {
        folders.push({
          id: `folder:${folder.path}`,
          type: "folder",
          path: folder.path || "/",
          label: folder.path ? folder.name : "Vault root"
        });
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          visit(child);
        }
      }
    };
    visit(this.app.vault.getRoot());
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  private addActiveNoteContext(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Open a note to attach the active note.");
      return;
    }
    this.addContextItem({
      id: "active-note",
      type: "active-note",
      path: activeFile.path,
      label: `${activeFile.basename} (active)`
    });
  }

  private addContextItem(item: ContextItem): void {
    if (this.contextItems.some((entry) => entry.id === item.id)) {
      return;
    }
    if (item.type === "active-note") {
      this.contextItems = this.contextItems.filter((entry) => entry.type !== "active-note");
    }
    this.contextItems.push(item);
    this.renderContextTags();
    this.persistSession();
  }

  private pickFirstMentionResult(): void {
    const first = this.mentionMenuEl?.querySelector(".cowriter-chat-mention-result") as HTMLElement | null;
    first?.click();
  }

  private finishMentionPick(): void {
    if (this.mentionStart >= 0) {
      const value = this.inputEl.value;
      const cursor = this.inputEl.selectionStart ?? value.length;
      this.inputEl.value = `${value.slice(0, this.mentionStart)}${value.slice(cursor)}`;
      this.inputEl.focus();
    }
    this.mentionStart = -1;
    this.mentionQuery = "";
    this.closeMentionMenu();
  }

  private closeMentionMenu(): void {
    if (this.mentionMenuEl) {
      this.mentionMenuEl.hide();
    }
  }

  private async sendMessage(): Promise<void> {
    const prompt = this.inputEl.value.trim();
    if (!prompt) {
      return;
    }

    if (!(await this.plugin.ensureConsent())) {
      return;
    }

    const hasActiveNoteContext = this.contextItems.some((item) => item.type === "active-note");
    if (hasActiveNoteContext) {
      await this.syncActiveNoteTag();
    }
    const history = [...this.messages];
    this.messages.push({ role: "user", content: prompt });
    this.renderMessageList();
    this.inputEl.value = "";
    this.sendButton.disabled = true;
    this.persistSession();

    try {
      const contextText = await this.buildContextPayload();
      const response = await this.plugin.generateChat(prompt, contextText, history);
      this.messages.push({ role: "assistant", content: response.trim() });
      this.renderMessageList();
      this.persistSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Cowriter chat failed: ${message}`);
      this.messages.pop();
      this.renderMessageList();
      this.persistSession();
    } finally {
      this.sendButton.disabled = false;
    }
  }

  private async buildContextPayload(): Promise<string> {
    const sections: string[] = [];
    const maxChars = 12000;
    let usedChars = 0;

    for (const item of this.contextItems) {
      if (usedChars >= maxChars) {
        break;
      }
      const section = await this.loadContextItem(item, maxChars - usedChars);
      if (section) {
        sections.push(section);
        usedChars += section.length;
      }
    }

    return sections.join("\n\n");
  }

  private async loadContextItem(item: ContextItem, maxChars: number): Promise<string> {
    if (item.type === "file" || item.type === "active-note") {
      const path = item.type === "active-note" ? this.app.workspace.getActiveFile()?.path ?? item.path : item.path;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        return "";
      }
      const content = await this.app.vault.cachedRead(file);
      return this.formatContextSection(`Note: ${file.path}`, content, maxChars);
    }

    if (item.type === "folder") {
      const folder = this.app.vault.getAbstractFileByPath(item.path === "/" ? "" : item.path);
      if (!(folder instanceof TFolder)) {
        return "";
      }
      const files = collectMarkdownFiles(folder).slice(0, 20);
      const chunks: string[] = [];
      let remaining = maxChars;
      for (const file of files) {
        if (remaining <= 0) {
          break;
        }
        const content = await this.app.vault.cachedRead(file);
        const section = this.formatContextSection(`Note: ${file.path}`, content, Math.min(2500, remaining));
        if (section) {
          chunks.push(section);
          remaining -= section.length;
        }
      }
      return [`Folder: ${item.path}`, ...chunks].join("\n\n");
    }

    return "";
  }

  private formatContextSection(title: string, content: string, maxChars: number): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }
    const body = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n...[truncated]` : trimmed;
    return `${title}\n${body}`;
  }
}

function formatSessionDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  const visit = (node: TAbstractFile) => {
    if (node instanceof TFile && node.extension === "md") {
      files.push(node);
      return;
    }
    if (node instanceof TFolder) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(folder);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function openCowriterChat(app: App): void {
  const leaf = app.workspace.getLeavesOfType(COWRITER_CHAT_VIEW_TYPE)[0];
  if (leaf) {
    void app.workspace.revealLeaf(leaf);
    return;
  }
  const rightLeaf = app.workspace.getRightLeaf(false);
  if (!rightLeaf) {
    new Notice("Could not open Cowriter chat.");
    return;
  }
  void rightLeaf.setViewState({ type: COWRITER_CHAT_VIEW_TYPE, active: true });
  app.workspace.revealLeaf(rightLeaf);
}
