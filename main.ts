import {
  App,
  Editor,
  Menu,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  setIcon
} from "obsidian";
import { CowriterChatView, COWRITER_CHAT_VIEW_TYPE, openCowriterChat, type ChatSessionRecord } from "./chat-view";

type ProviderId = "ollama" | "lmstudio" | "openrouter" | "anthropic" | "openai" | "gemini";
type ActiveProviderId = ProviderId | "";
type InsertMode = "replace" | "append";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

interface ProviderSettings {
  enabled: boolean;
  consentToSend: boolean;
  endpoint: string;
  model: string;
  apiKey: string;
  discoveredModels: string[];
  modelSupportsReasoning: Record<string, boolean>;
}

interface BraveSearchSettings {
  enabled: boolean;
  consentToSend: boolean;
  apiKey: string;
  resultCount: number;
}

interface ChatApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CowriterSettings {
  privacyNoticeAccepted: boolean;
  activeProvider: ActiveProviderId;
  systemPrompt: string;
  temperature: number;
  insertMode: InsertMode;
  reasoningEffort: ReasoningEffort;
  styles: string[];
  skills: string[];
  braveSearch: BraveSearchSettings;
  providers: Record<ProviderId, ProviderSettings>;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface CuratedModel {
  id: string;
  label: string;
}

interface ActionDefinition {
  id: string;
  name: string;
  instruction: string;
}

interface ProviderDefinition {
  id: ProviderId;
  name: string;
  remote: boolean;
  privacyLabel: string;
  defaultEndpoint: string;
  defaultModel: string;
  endpointDescription: string;
}

const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  ollama: {
    id: "ollama",
    name: "Ollama",
    remote: false,
    privacyLabel: "Local model server",
    defaultEndpoint: "http://localhost:11434",
    defaultModel: "llama3.1",
    endpointDescription: "Base URL, usually http://localhost:11434"
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    remote: false,
    privacyLabel: "Local OpenAI-compatible server",
    defaultEndpoint: "http://localhost:1234/v1",
    defaultModel: "local-model",
    endpointDescription: "OpenAI-compatible base URL, usually http://localhost:1234/v1"
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    remote: true,
    privacyLabel: "Remote provider",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.4",
    endpointDescription: "OpenAI-compatible base URL. Recommended for GPT-5.4, Gemini 3.5 Flash, and Claude Haiku 4.5."
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    remote: true,
    privacyLabel: "Remote provider",
    defaultEndpoint: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5",
    endpointDescription: "Anthropic API base URL"
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    remote: true,
    privacyLabel: "Remote provider",
    defaultEndpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    endpointDescription: "OpenAI API base URL"
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    remote: true,
    privacyLabel: "Remote provider",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.5-flash",
    endpointDescription: "Gemini API base URL"
  }
};

const OPENROUTER_CURATED_MODELS: CuratedModel[] = [
  { id: "openai/gpt-5.4", label: "GPT-5.4" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" }
];

const OPENROUTER_BLOCKED_MODEL_PATTERNS = [/gpt-5\.5/i, /gpt-5-5/i];

const REASONING_EFFORT_OPTIONS: Array<{ id: ReasoningEffort; label: string }> = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" }
];

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const FACT_CHECK_INSTRUCTION = [
  "You are fact-checking selected note text.",
  "Web search results were gathered specifically to verify factual claims in that text.",
  "",
  "For each substantive factual claim:",
  "- Label it Supported, Contradicted, Unclear, or Unverifiable",
  "- Briefly explain why",
  "- Cite only the provided search results using title and URL",
  "",
  "Return concise Markdown bullet points. Do not invent sources."
].join("\n");

function createDefaultProviderSettings(id: ProviderId): ProviderSettings {
  return {
    enabled: false,
    consentToSend: false,
    endpoint: PROVIDERS[id].defaultEndpoint,
    model: PROVIDERS[id].defaultModel,
    apiKey: "",
    discoveredModels: [],
    modelSupportsReasoning: {}
  };
}

const DEFAULT_ACTIONS: ActionDefinition[] = [
  {
    id: "improve",
    name: "Improve writing",
    instruction: "Improve the selected text while preserving meaning, Markdown structure, links, and the author's intent."
  },
  {
    id: "shorter",
    name: "Make shorter",
    instruction: "Rewrite the selected text to be more concise. Keep the important facts and preserve Markdown."
  },
  {
    id: "longer",
    name: "Make longer",
    instruction: "Expand the selected text with useful detail, smoother transitions, and clearer context. Preserve Markdown."
  },
  {
    id: "clearer",
    name: "Make clearer",
    instruction: "Rewrite the selected text for clarity, flow, and plain-language readability. Preserve Markdown."
  },
  {
    id: "summarize",
    name: "Summarize",
    instruction: "Summarize the selected text into a compact Markdown summary with the key points."
  }
];

const DEFAULT_SETTINGS: CowriterSettings = {
  privacyNoticeAccepted: false,
  activeProvider: "",
  systemPrompt:
    "You are Cowriter, a careful writing assistant inside Obsidian. Respect the user's notes, preserve Markdown when possible, avoid inventing facts, and return only the requested text without prefacing it.",
  temperature: 0.4,
  insertMode: "replace",
  reasoningEffort: "low",
  styles: [
    "clear and practical",
    "warm and conversational",
    "academic",
    "spare literary prose",
    "technical documentation",
    "journalistic",
    "a precise senior editor",
    "a kind writing coach",
    "a skeptical researcher",
    "a concise product strategist",
    "a thoughtful novelist"
  ],
  skills: [
    "copyedit for grammar, punctuation, and flow",
    "extract action items",
    "turn into a structured outline",
    "convert into concise meeting notes",
    "find weak claims and suggest stronger wording"
  ],
  braveSearch: {
    enabled: false,
    consentToSend: false,
    apiKey: "",
    resultCount: 5
  },
  providers: {
    ollama: createDefaultProviderSettings("ollama"),
    lmstudio: createDefaultProviderSettings("lmstudio"),
    openrouter: createDefaultProviderSettings("openrouter"),
    anthropic: createDefaultProviderSettings("anthropic"),
    openai: createDefaultProviderSettings("openai"),
    gemini: createDefaultProviderSettings("gemini")
  }
};

export default class CowriterPlugin extends Plugin {
  settings!: CowriterSettings;
  chatSessions: ChatSessionRecord[] = [];
  activeChatSessionId = "";

  async onload() {
    await this.loadSettings();

    this.registerView(COWRITER_CHAT_VIEW_TYPE, (leaf) => new CowriterChatView(leaf, this));

    this.addRibbonIcon("sparkles", "Cowriter chat", () => {
      openCowriterChat(this.app);
    });

    this.addCommand({
      id: "open-cowriter-chat",
      name: "Open Cowriter chat",
      callback: () => {
        openCowriterChat(this.app);
      }
    });

    this.addCommand({
      id: "open-cowriter-settings",
      name: "Open Cowriter settings",
      callback: () => {
        const appWithSetting = this.app as App & {
          setting?: { open(): void; openTabById(id: string): void };
        };
        appWithSetting.setting?.open();
        appWithSetting.setting?.openTabById(this.manifest.id);
      }
    });

    for (const action of DEFAULT_ACTIONS) {
      this.addCommand({
        id: `cowriter-${action.id}`,
        name: action.name,
        editorCallback: (editor) => {
          void this.runAction(editor, action);
        }
      });
    }

    this.addCommand({
      id: "cowriter-style",
      name: "Rewrite in style...",
      editorCallback: (editor) => {
        this.openStylePrompt(editor);
      }
    });

    this.addCommand({
      id: "cowriter-skill",
      name: "Use skill...",
      editorCallback: (editor) => {
        this.openSkillPrompt(editor);
      }
    });

    this.addCommand({
      id: "cowriter-custom-instruction",
      name: "Custom writing instruction...",
      editorCallback: (editor) => {
        this.openCustomInstructionPrompt(editor);
      }
    });

    this.addCommand({
      id: "cowriter-fact-check",
      name: "Fact check selection",
      editorCheckCallback: (checking, editor) => {
        if (checking) {
          return Boolean(editor.getSelection().trim());
        }
        void this.runFactCheck(editor);
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        this.addEditorMenuItems(menu, editor);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        for (const leaf of this.app.workspace.getLeavesOfType(COWRITER_CHAT_VIEW_TYPE)) {
          const view = leaf.view;
          if (view instanceof CowriterChatView) {
            void view.syncActiveNoteTag();
          }
        }
      })
    );

    this.addSettingTab(new CowriterSettingTab(this.app, this));

    if (!this.settings.privacyNoticeAccepted) {
      new Notice("Cowriter is local-first. Open Cowriter settings to review privacy and provider consent.", 8000);
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = normalizeSettings(loaded);
    const raw = (loaded ?? {}) as {
      chatSessions?: ChatSessionRecord[];
      activeChatSessionId?: string;
    };
    this.chatSessions = Array.isArray(raw.chatSessions) ? raw.chatSessions : [];
    this.activeChatSessionId = typeof raw.activeChatSessionId === "string" ? raw.activeChatSessionId : "";
  }

  async saveSettings() {
    await this.savePluginData();
  }

  async savePluginData() {
    await this.saveData({
      ...this.settings,
      chatSessions: this.chatSessions,
      activeChatSessionId: this.activeChatSessionId
    });
  }

  getChatSessions(): ChatSessionRecord[] {
    return [...this.chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getActiveChatSession(): ChatSessionRecord | null {
    return this.chatSessions.find((session) => session.id === this.activeChatSessionId) ?? null;
  }

  getChatSession(sessionId: string): ChatSessionRecord | null {
    return this.chatSessions.find((session) => session.id === sessionId) ?? null;
  }

  setActiveChatSession(sessionId: string): void {
    this.activeChatSessionId = sessionId;
    void this.savePluginData();
  }

  createChatSession(): ChatSessionRecord {
    const session: ChatSessionRecord = {
      id: crypto.randomUUID(),
      title: "New chat",
      updatedAt: Date.now(),
      messages: [],
      contextItems: []
    };
    this.chatSessions.unshift(session);
    this.activeChatSessionId = session.id;
    void this.savePluginData();
    return session;
  }

  saveChatSession(session: ChatSessionRecord): void {
    const normalizedSession: ChatSessionRecord = {
      ...session,
      messages: session.messages.slice(-100),
      contextItems: session.contextItems.slice(0, 25)
    };
    const index = this.chatSessions.findIndex((entry) => entry.id === normalizedSession.id);
    if (index >= 0) {
      this.chatSessions[index] = normalizedSession;
    } else {
      this.chatSessions.unshift(normalizedSession);
    }
    this.activeChatSessionId = normalizedSession.id;
    if (this.chatSessions.length > 50) {
      this.chatSessions = this.chatSessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    }
    void this.savePluginData();
  }

  deleteChatSession(sessionId: string): void {
    this.chatSessions = this.chatSessions.filter((session) => session.id !== sessionId);
    if (this.activeChatSessionId === sessionId) {
      this.activeChatSessionId = this.chatSessions[0]?.id ?? "";
    }
    void this.savePluginData();
  }

  async runAction(editor: Editor, action: ActionDefinition) {
    const insertMode: InsertMode | undefined = action.id === "summarize" ? "append" : undefined;
    await this.runCustomInstruction(editor, action.instruction, insertMode);
  }

  addEditorMenuItems(menu: Menu, editor: Editor) {
    const selection = editor.getSelection();
    const hasSelection = Boolean(selection.trim());

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Cowriter").setIcon("sparkles").setDisabled(true));

    for (const action of DEFAULT_ACTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(action.name)
          .setIcon(actionIcon(action.id))
          .onClick(() => {
            void this.runAction(editor, action);
          })
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Rewrite in style...")
        .setIcon("palette")
        .onClick(() => {
          this.openStylePrompt(editor);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Use skill...")
        .setIcon("badge-check")
        .onClick(() => {
          this.openSkillPrompt(editor);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Custom instruction...")
        .setIcon("message-square-text")
        .onClick(() => {
          this.openCustomInstructionPrompt(editor);
        })
    );

    if (hasSelection) {
      menu.addItem((item) =>
        item
          .setTitle("Fact check")
          .setIcon("shield-check")
          .onClick(() => {
            void this.runFactCheck(editor);
          })
      );
    }
  }

  openStylePrompt(editor: Editor) {
    new ChoicePromptModal(this.app, "Rewrite in style", "Style", this.settings.styles, async (choice) => {
      await this.runCustomInstruction(
        editor,
        `Rewrite the selected text in this style: ${choice}. Preserve meaning and Markdown.`
      );
    }).open();
  }

  openSkillPrompt(editor: Editor) {
    new ChoicePromptModal(this.app, "Use skill", "Skill", this.settings.skills, async (choice) => {
      await this.runCustomInstruction(editor, `Apply this writing skill to the selected text: ${choice}. Preserve Markdown.`);
    }).open();
  }

  openCustomInstructionPrompt(editor: Editor) {
    new TextPromptModal(this.app, "Custom writing instruction", "Instruction", "", async (instruction) => {
      await this.runCustomInstruction(editor, instruction);
    }).open();
  }

  async runFactCheck(editor: Editor) {
    const text = editor.getSelection();
    if (!text.trim()) {
      new Notice("Select text to fact check.");
      return;
    }

    if (!this.settings.braveSearch.enabled) {
      new Notice("Enable Brave Search in Cowriter settings first.");
      return;
    }

    if (!this.settings.braveSearch.consentToSend) {
      new Notice("Grant Brave Search consent in Cowriter settings before fact checking.");
      return;
    }

    if (!this.settings.braveSearch.apiKey.trim()) {
      new Notice("Add a Brave Search API key in Cowriter settings.");
      return;
    }

    if (!(await this.ensureConsent())) {
      return;
    }

    const providerId = this.settings.activeProvider;
    const providerInfo = providerId ? PROVIDERS[providerId] : null;

    try {
      new Notice("Cowriter is searching the web with Brave...");
      const queries = extractFactCheckQueries(text);
      const searchResults = await Promise.all(
        queries.map(async (query) => ({
          query,
          results: await searchBrave(
            this.settings.braveSearch.apiKey,
            query,
            this.settings.braveSearch.resultCount
          )
        }))
      );

      const searchContext = formatBraveResultsForPrompt(searchResults);
      const instruction = [FACT_CHECK_INSTRUCTION, "", "Web search results:", searchContext].join("\n");

      new Notice(`Cowriter is fact checking with ${providerInfo?.name ?? "your provider"}...`);
      const output = await this.generate(instruction, text);
      applyEditorOutput(editor, output.trim(), "append");
      new Notice("Cowriter fact check finished.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Cowriter fact check failed: ${message}`);
      console.error("Cowriter fact check failed", error);
    }
  }

  async runCustomInstruction(editor: Editor, instruction: string, insertMode?: InsertMode) {
    const text = getEditorInput(editor);
    if (!text.trim()) {
      new Notice("Select text or place the cursor on a line for Cowriter to edit.");
      return;
    }

    if (!instruction.trim()) {
      new Notice("Cowriter needs an instruction.");
      return;
    }

    if (!(await this.ensureConsent())) {
      return;
    }

    const providerId = this.settings.activeProvider;
    if (!providerId) {
      new Notice("Choose and enable a Cowriter provider in settings first.");
      return;
    }

    const provider = this.settings.providers[providerId];
    const providerInfo = PROVIDERS[providerId];

    try {
      new Notice(`Cowriter is sending text to ${providerInfo.name}...`);
      const output = await this.generate(instruction, text);
      applyEditorOutput(editor, output.trim(), insertMode ?? this.settings.insertMode);
      new Notice("Cowriter finished.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Cowriter failed: ${message}`);
      console.error("Cowriter request failed", { provider: providerInfo.id, model: provider.model, error });
    }
  }

  async ensureConsent(): Promise<boolean> {
    if (!this.settings.privacyNoticeAccepted) {
      const accepted = await new PrivacyConsentModal(this.app).request();
      if (!accepted) {
        new Notice("Cowriter will not connect to any provider until privacy consent is accepted.");
        return false;
      }
      this.settings.privacyNoticeAccepted = true;
      await this.saveSettings();
    }

    const providerId = this.settings.activeProvider;
    if (!providerId) {
      new Notice("Choose a Cowriter provider in settings first.");
      return false;
    }

    const provider = this.settings.providers[providerId];
    const providerInfo = PROVIDERS[providerId];

    if (!provider.enabled) {
      new Notice(`${providerInfo.name} is not enabled. Enable it in Cowriter settings first.`);
      return false;
    }

    if (!provider.consentToSend) {
      new Notice(`Explicit consent is required before Cowriter can send text to ${providerInfo.name}.`);
      return false;
    }

    if (providerInfo.remote && !provider.apiKey.trim()) {
      new Notice(`${providerInfo.name} needs an API key before it can be used.`);
      return false;
    }

    return true;
  }

  async generate(instruction: string, selectedText: string): Promise<string> {
    const providerId = this.settings.activeProvider;
    if (!providerId) {
      throw new Error("No provider selected.");
    }

    const provider = this.settings.providers[providerId];
    const system = this.settings.systemPrompt.trim();
    const user = [
      "Instruction:",
      instruction.trim(),
      "",
      "Selected note text:",
      selectedText.trim()
    ].join("\n");
    const reasoningEffort = getActiveReasoningEffort(this.settings);
    const messages = buildSingleTurnMessages(system, user);

    if (providerId === "ollama") {
      return requestOllama(provider, messages, this.settings.temperature);
    }

    if (providerId === "anthropic") {
      return requestAnthropic(provider, messages, this.settings.temperature, reasoningEffort);
    }

    if (providerId === "gemini") {
      return requestGemini(provider, messages, this.settings.temperature, reasoningEffort);
    }

    return requestOpenAiCompatible(
      providerId,
      provider,
      messages,
      this.settings.temperature,
      reasoningEffort
    );
  }

  async generateChat(
    userMessage: string,
    vaultContext: string,
    history: Array<{ role: "user" | "assistant"; content: string }> = []
  ): Promise<string> {
    const providerId = this.settings.activeProvider;
    if (!providerId) {
      throw new Error("No provider selected.");
    }

    const provider = this.settings.providers[providerId];
    const system = [
      this.settings.systemPrompt.trim(),
      "",
      "You are Cowriter chat inside Obsidian.",
      "Use the provided vault context when it is relevant.",
      "If context is insufficient, say so clearly.",
      "Respond in Markdown when helpful."
    ].join("\n");
    const user = [
      userMessage.trim(),
      "",
      "Vault context:",
      vaultContext.trim() || "(none attached)"
    ].join("\n");
    const recentHistory = history.slice(-12);
    const messages: ChatApiMessage[] = [
      { role: "system", content: system },
      ...recentHistory,
      { role: "user", content: user }
    ];
    const reasoningEffort = getActiveReasoningEffort(this.settings);

    if (providerId === "ollama") {
      return requestOllama(provider, messages, this.settings.temperature);
    }

    if (providerId === "anthropic") {
      return requestAnthropic(provider, messages, this.settings.temperature, reasoningEffort);
    }

    if (providerId === "gemini") {
      return requestGemini(provider, messages, this.settings.temperature, reasoningEffort);
    }

    return requestOpenAiCompatible(
      providerId,
      provider,
      messages,
      this.settings.temperature,
      reasoningEffort
    );
  }
}

function normalizeSettings(raw: unknown): CowriterSettings {
  const saved = (raw ?? {}) as Partial<CowriterSettings> & { characters?: string[] };
  const legacyCharacters = Array.isArray(saved.characters) ? saved.characters : [];
  const settings: CowriterSettings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    providers: { ...DEFAULT_SETTINGS.providers },
    braveSearch: {
      ...DEFAULT_SETTINGS.braveSearch,
      ...(saved.braveSearch ?? {})
    },
    styles: mergePresetLists(
      Array.isArray(saved.styles) ? saved.styles : DEFAULT_SETTINGS.styles,
      legacyCharacters
    ),
    skills: Array.isArray(saved.skills) ? saved.skills : DEFAULT_SETTINGS.skills
  };

  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const savedProvider = (saved.providers?.[id] ?? {}) as Partial<ProviderSettings>;
    settings.providers[id] = {
      ...createDefaultProviderSettings(id),
      ...savedProvider,
      modelSupportsReasoning: {
        ...createDefaultProviderSettings(id).modelSupportsReasoning,
        ...(savedProvider.modelSupportsReasoning ?? {})
      }
    };
  }

  if (settings.activeProvider && !PROVIDERS[settings.activeProvider]) {
    settings.activeProvider = "";
  }

  if (settings.activeProvider && !settings.providers[settings.activeProvider].enabled) {
    settings.activeProvider = "";
  }

  settings.temperature = clampNumber(settings.temperature, 0, 2, DEFAULT_SETTINGS.temperature);
  settings.insertMode = settings.insertMode === "append" ? "append" : "replace";
  settings.reasoningEffort = normalizeReasoningEffort(settings.reasoningEffort);
  settings.braveSearch.resultCount = clampNumber(settings.braveSearch.resultCount, 1, 10, DEFAULT_SETTINGS.braveSearch.resultCount);

  for (const curated of OPENROUTER_CURATED_MODELS) {
    settings.providers.openrouter.modelSupportsReasoning[curated.id] = true;
  }

  return settings;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return DEFAULT_SETTINGS.reasoningEffort;
}

function getActiveModel(settings: CowriterSettings): { providerId: ProviderId; model: string } | null {
  if (!settings.activeProvider) {
    return null;
  }
  return {
    providerId: settings.activeProvider,
    model: settings.providers[settings.activeProvider].model
  };
}

function inferReasoningSupport(providerId: ProviderId, model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized || OPENROUTER_BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (providerId === "openrouter" || providerId === "openai") {
    return (
      /gpt-5(\.|\/|$|-)/.test(normalized) ||
      /\/gpt-5(\.|\/|$|-)/.test(normalized) ||
      /\bo[134](-|\b|\/)/.test(normalized) ||
      /gemini-[23]\./.test(normalized) ||
      /gemini-3/.test(normalized) ||
      /claude-(opus|sonnet|haiku)-4[.\-]/.test(normalized) ||
      /deepseek-r1/.test(normalized)
    );
  }

  if (providerId === "anthropic") {
    return /claude-(opus|sonnet|haiku)-4[.\-]/.test(normalized);
  }

  if (providerId === "gemini") {
    return /gemini-[23]\./.test(normalized) || /gemini-3/.test(normalized);
  }

  return false;
}

function activeModelSupportsReasoning(settings: CowriterSettings): boolean {
  const active = getActiveModel(settings);
  if (!active) {
    return false;
  }

  const provider = settings.providers[active.providerId];
  if (provider.modelSupportsReasoning[active.model] !== undefined) {
    return provider.modelSupportsReasoning[active.model];
  }

  return inferReasoningSupport(active.providerId, active.model);
}

function getActiveReasoningEffort(settings: CowriterSettings): ReasoningEffort | undefined {
  if (!activeModelSupportsReasoning(settings) || settings.reasoningEffort === "none") {
    return undefined;
  }
  return settings.reasoningEffort;
}

function reasoningBudgetForAnthropic(effort: ReasoningEffort): number {
  if (effort === "minimal") return 1024;
  if (effort === "low") return 2048;
  if (effort === "medium") return 8192;
  if (effort === "high") return 16384;
  return 2048;
}

function extractFactCheckQueries(text: string): string[] {
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);

  const candidates = sentences.length > 0 ? sentences.slice(0, 3) : [text.trim()];
  return candidates.map((sentence) => `fact check verify: ${sentence.slice(0, 280)}`);
}

function formatBraveResultsForPrompt(
  resultsByQuery: Array<{ query: string; results: BraveSearchResult[] }>
): string {
  return resultsByQuery
    .map(({ query, results }) => {
      if (results.length === 0) {
        return `Search query: ${query}\nNo results.`;
      }

      const lines = results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   URL: ${result.url}\n   Snippet: ${result.description}`
        )
        .join("\n");
      return `Search query: ${query}\n${lines}`;
    })
    .join("\n\n");
}

async function searchBrave(apiKey: string, query: string, count: number): Promise<BraveSearchResult[]> {
  const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(count, 1), 10)}&result_filter=web`;
  const data = await requestGetJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>(
    url,
    {
      "X-Subscription-Token": apiKey.trim(),
      Accept: "application/json"
    }
  );

  return (data.web?.results ?? [])
    .map((result) => ({
      title: result.title?.trim() || "Untitled",
      url: result.url?.trim() || "",
      description: result.description?.trim() || ""
    }))
    .filter((result) => result.url.length > 0);
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (Number.isFinite(value)) {
    return Math.min(max, Math.max(min, value));
  }
  return fallback;
}

function actionIcon(actionId: string): string {
  if (actionId === "shorter") return "minimize-2";
  if (actionId === "longer") return "maximize-2";
  if (actionId === "clearer") return "wand-sparkles";
  if (actionId === "summarize") return "list-collapse";
  return "sparkles";
}

function getEditorInput(editor: Editor): string {
  const selection = editor.getSelection();
  if (selection.trim()) {
    return selection;
  }

  const cursor = editor.getCursor();
  return editor.getLine(cursor.line);
}

function applyEditorOutput(editor: Editor, output: string, insertMode: InsertMode) {
  const selection = editor.getSelection();
  if (selection.length > 0) {
    if (insertMode === "append") {
      editor.replaceSelection(`${selection}\n\n${output}`);
    } else {
      editor.replaceSelection(output);
    }
    return;
  }

  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  if (insertMode === "append") {
    editor.replaceRange(`${line}\n\n${output}`, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
  } else {
    editor.replaceRange(output, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
  }
}

function buildUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function assertProviderEndpointAllowed(providerId: ProviderId, endpoint: string): void {
  const providerInfo = PROVIDERS[providerId];
  let parsed: URL;

  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${providerInfo.name} endpoint must be a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${providerInfo.name} endpoint must use HTTP or HTTPS.`);
  }

  if (providerInfo.remote && parsed.protocol !== "https:") {
    throw new Error(`${providerInfo.name} is a remote provider and must use an HTTPS endpoint.`);
  }

  if (!providerInfo.remote && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `${providerInfo.name} is configured as a local provider, so its endpoint must be localhost, 127.0.0.1, or ::1.`
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

async function requestJson<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body),
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    const text = response.text?.slice(0, 500) ?? "No response body";
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json as T;
}

async function requestGetJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await requestUrl({
    url,
    method: "GET",
    headers,
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    const text = response.text?.slice(0, 500) ?? "No response body";
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json as T;
}

async function discoverModels(providerId: ProviderId, provider: ProviderSettings): Promise<string[]> {
  if (!provider.enabled) {
    throw new Error(`${PROVIDERS[providerId].name} must be enabled before Cowriter can check its models.`);
  }

  assertProviderEndpointAllowed(providerId, provider.endpoint);

  if (PROVIDERS[providerId].remote && !provider.apiKey.trim()) {
    throw new Error(`${PROVIDERS[providerId].name} needs an API key before Cowriter can check its models.`);
  }

  if (providerId === "ollama") {
    const data = await requestGetJson<{ models?: Array<{ name?: string; model?: string }> }>(
      buildUrl(provider.endpoint, "/api/tags")
    );
    return uniqueModels(data.models?.map((model) => model.name ?? model.model) ?? []);
  }

  if (providerId === "anthropic") {
    const data = await requestGetJson<{ data?: Array<{ id?: string }> }>(buildUrl(provider.endpoint, "/v1/models"), {
      "x-api-key": provider.apiKey.trim(),
      "anthropic-version": "2023-06-01"
    });
    const models = uniqueModels(data.data?.map((model) => model.id) ?? []);
    for (const model of models) {
      provider.modelSupportsReasoning[model] = inferReasoningSupport("anthropic", model);
    }
    return models;
  }

  if (providerId === "gemini") {
    const data = await requestGetJson<{ models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> }>(
      buildUrl(provider.endpoint, "/models"),
      { "x-goog-api-key": provider.apiKey.trim() }
    );
    const models = uniqueModels(
      data.models
        ?.filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => model.name?.replace(/^models\//, "")) ?? []
    );
    for (const model of models) {
      provider.modelSupportsReasoning[model] = inferReasoningSupport("gemini", model);
    }
    return models;
  }

  if (providerId === "openrouter") {
    const data = await requestGetJson<{ data?: Array<{ id?: string; supported_parameters?: string[] }> }>(
      buildUrl(provider.endpoint, "/models"),
      { Authorization: `Bearer ${provider.apiKey.trim()}` }
    );
    const models: string[] = [];
    for (const item of data.data ?? []) {
      if (!item.id || isBlockedOpenRouterModel(item.id)) {
        continue;
      }
      models.push(item.id);
      provider.modelSupportsReasoning[item.id] =
        item.supported_parameters?.includes("reasoning") ?? inferReasoningSupport("openrouter", item.id);
    }
    return uniqueModels(models);
  }

  const headers: Record<string, string> = provider.apiKey.trim()
    ? { Authorization: `Bearer ${provider.apiKey.trim()}` }
    : {};
  const data = await requestGetJson<{ data?: Array<{ id?: string }> }>(buildUrl(provider.endpoint, "/models"), headers);
  const models = uniqueModels(data.data?.map((model) => model.id) ?? []);
  for (const model of models) {
    provider.modelSupportsReasoning[model] = inferReasoningSupport(providerId, model);
  }
  return models;
}

function isBlockedOpenRouterModel(model: string): boolean {
  return OPENROUTER_BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function uniqueModels(models: Array<string | undefined>): string[] {
  return Array.from(new Set(models.map((model) => model?.trim()).filter((model): model is string => Boolean(model)))).sort();
}

function mergePresetLists(primary: string[], legacy: string[]): string[] {
  return Array.from(
    new Set([...primary, ...legacy].map((item) => item.trim()).filter((item): item is string => Boolean(item)))
  );
}

function buildSingleTurnMessages(system: string, user: string): ChatApiMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

async function requestOllama(
  provider: ProviderSettings,
  messages: ChatApiMessage[],
  temperature: number
): Promise<string> {
  assertProviderEndpointAllowed("ollama", provider.endpoint);

  const data = await requestJson<{ message?: { content?: string }; response?: string }>(
    buildUrl(provider.endpoint, "/api/chat"),
    {},
    {
      model: provider.model,
      stream: false,
      messages,
      options: { temperature }
    }
  );

  const content = data.message?.content ?? data.response;
  if (!content) {
    throw new Error("Ollama returned no content.");
  }
  return content;
}

async function requestOpenAiCompatible(
  providerId: ProviderId,
  provider: ProviderSettings,
  messages: ChatApiMessage[],
  temperature: number,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  assertProviderEndpointAllowed(providerId, provider.endpoint);

  const headers: Record<string, string> = provider.apiKey.trim()
    ? { Authorization: `Bearer ${provider.apiKey.trim()}` }
    : {};

  if (providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://obsidian.md";
    headers["X-Title"] = "Cowriter for Obsidian";
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    temperature,
    messages
  };

  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort, exclude: true };
  }

  const data = await requestJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    buildUrl(provider.endpoint, "/chat/completions"),
    headers,
    body
  );

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider returned no content.");
  }
  return content;
}

async function requestAnthropic(
  provider: ProviderSettings,
  messages: ChatApiMessage[],
  temperature: number,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  assertProviderEndpointAllowed("anthropic", provider.endpoint);

  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const chatMessages = messages.filter((message) => message.role !== "system");

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: 4096,
    temperature,
    system,
    messages: chatMessages
  };

  if (reasoningEffort && inferReasoningSupport("anthropic", provider.model)) {
    body.thinking = {
      type: "enabled",
      budget_tokens: reasoningBudgetForAnthropic(reasoningEffort)
    };
  }

  const data = await requestJson<{ content?: Array<{ type: string; text?: string }> }>(
    buildUrl(provider.endpoint, "/v1/messages"),
    {
      "x-api-key": provider.apiKey.trim(),
      "anthropic-version": "2023-06-01"
    },
    body
  );

  const content = data.content?.find((item) => item.type === "text")?.text;
  if (!content) {
    throw new Error("Anthropic returned no content.");
  }
  return content;
}

async function requestGemini(
  provider: ProviderSettings,
  messages: ChatApiMessage[],
  temperature: number,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  assertProviderEndpointAllowed("gemini", provider.endpoint);

  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    }));

  const generationConfig: Record<string, unknown> = { temperature };
  if (reasoningEffort && inferReasoningSupport("gemini", provider.model)) {
    generationConfig.thinkingConfig = { thinkingLevel: reasoningEffort };
  }

  const data = await requestJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(
    buildUrl(provider.endpoint, `/models/${encodeURIComponent(provider.model)}:generateContent`),
    { "x-goog-api-key": provider.apiKey.trim() },
    {
      generationConfig,
      system_instruction: {
        parts: [{ text: system }]
      },
      contents
    }
  );

  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!content) {
    throw new Error("Gemini returned no content.");
  }
  return content;
}

class PrivacyConsentModal extends Modal {
  private resolver: ((accepted: boolean) => void) | null = null;

  constructor(app: App) {
    super(app);
  }

  request(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Cowriter privacy notice" });
    const note = contentEl.createDiv({ cls: "cowriter-privacy-note" });
    note.createEl("p", {
      text: "Cowriter is built for privacy-first note taking. Local models are recommended with Ollama or LM Studio."
    });
    note.createEl("p", {
      text: "No AI provider is contacted unless you enable it and grant consent in settings. Remote providers can receive selected note text, prompts, and surrounding writing context."
    });
    note.createEl("p", {
      text: "You can revoke provider consent at any time by disabling the provider or clearing its consent checkbox."
    });

    const actions = contentEl.createDiv({ cls: "cowriter-modal-actions" });
    new Setting(actions)
      .addButton((button) =>
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.resolve(false);
          })
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("I understand")
          .onClick(() => {
            this.resolve(true);
          })
      );
  }

  onClose() {
    this.resolve(false);
  }

  private resolve(value: boolean) {
    if (this.resolver) {
      this.resolver(value);
      this.resolver = null;
    }
    this.close();
  }
}

class TextPromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private label: string,
    private placeholder: string,
    private onSubmit: (value: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("label", { text: this.label });
    const textarea = contentEl.createEl("textarea", {
      cls: "cowriter-textarea",
      attr: { placeholder: this.placeholder }
    });

    const actions = contentEl.createDiv({ cls: "cowriter-modal-actions" });
    new Setting(actions)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Run")
          .onClick(async () => {
            const value = textarea.value.trim();
            this.close();
            await this.onSubmit(value);
          })
      );
    textarea.focus();
  }
}

class ChoicePromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private label: string,
    private choices: string[],
    private onSubmit: (value: string) => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });

    const select = contentEl.createEl("select", { cls: "cowriter-select", attr: { "aria-label": this.label } });
    for (const choice of this.choices) {
      select.createEl("option", { text: choice, value: choice });
    }
    select.createEl("option", { text: "Custom...", value: "__custom__" });

    const custom = contentEl.createEl("input", {
      attr: { type: "text", placeholder: `Custom ${this.label.toLowerCase()}` }
    });
    custom.style.width = "100%";
    custom.style.marginTop = "8px";
    custom.hide();

    select.addEventListener("change", () => {
      if (select.value === "__custom__") {
        custom.show();
        custom.focus();
      } else {
        custom.hide();
      }
    });

    const actions = contentEl.createDiv({ cls: "cowriter-modal-actions" });
    new Setting(actions)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Run")
          .onClick(async () => {
            const value = select.value === "__custom__" ? custom.value.trim() : select.value;
            this.close();
            await this.onSubmit(value);
          })
      );
  }
}

class CowriterSettingTab extends PluginSettingTab {
  private expandedProviders = new Set<ProviderId>();

  constructor(app: App, private plugin: CowriterPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cw-settings");

    if (this.expandedProviders.size === 0 && this.plugin.settings.activeProvider) {
      this.expandedProviders.add(this.plugin.settings.activeProvider);
    }

    this.renderPageHeader(containerEl);

    const aiSection = this.createSection(
      containerEl,
      "AI Provider",
      "Choose your model provider and configure connection details."
    );
    this.renderAiProviderSettings(aiSection);

    const searchSection = this.createSection(
      containerEl,
      "Search",
      "Web search is only used for fact checking. It is not called for other Cowriter actions."
    );
    this.renderSearchSettings(searchSection);

    const advancedSection = this.createSection(
      containerEl,
      "Advanced",
      "Optional tuning for model behavior, prompts, and menu presets."
    );
    this.renderAdvancedSettings(advancedSection);
    this.renderStylePresets(advancedSection);
    this.renderSkillsSettings(advancedSection);
  }

  private renderPageHeader(containerEl: HTMLElement): void {
    const header = containerEl.createDiv({ cls: "cw-page-header" });
    header.createEl("h1", { cls: "cw-page-title", text: "Cowriter" });
    header.createEl("p", {
      cls: "cw-page-lead",
      text: "Privacy-first AI writing tools for Obsidian. Local providers are recommended."
    });
  }

  private createSection(containerEl: HTMLElement, title: string, intro: string): HTMLElement {
    const section = containerEl.createDiv({ cls: "cw-section" });
    const head = section.createDiv({ cls: "cw-section-head" });
    head.createEl("h2", { cls: "cw-section-title", text: title });
    head.createEl("p", { cls: "cw-section-intro", text: intro });
    return section.createDiv({ cls: "cw-section-body" });
  }

  private createSubsection(parent: HTMLElement, title: string): HTMLElement {
    const subsection = parent.createDiv({ cls: "cw-subsection" });
    subsection.createEl("h3", { cls: "cw-subsection-title", text: title });
    return subsection.createDiv({ cls: "cw-fields" });
  }

  private createFields(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "cw-fields" });
  }

  private addField(parent: HTMLElement, label: string, description?: string): HTMLElement {
    const field = parent.createDiv({ cls: "cw-field" });
    field.createDiv({ cls: "cw-field-label", text: label });
    if (description) {
      field.createDiv({ cls: "cw-field-desc", text: description });
    }
    return field.createDiv({ cls: "cw-field-control" });
  }

  private addToggleField(
    parent: HTMLElement,
    label: string,
    description: string,
    value: boolean,
    onChange: (value: boolean) => Promise<void> | void
  ): void {
    const field = parent.createDiv({ cls: "cw-field cw-field-toggle" });
    const copy = field.createDiv({ cls: "cw-field-copy" });
    copy.createDiv({ cls: "cw-field-label", text: label });
    copy.createDiv({ cls: "cw-field-desc", text: description });
    const control = field.createDiv({ cls: "cw-toggle-wrap" });
    const toggle = control.createDiv({ cls: "checkbox-container" });
    if (value) {
      toggle.addClass("is-enabled");
    }
    const input = toggle.createEl("input", { type: "checkbox" });
    input.checked = value;

    const setChecked = (checked: boolean) => {
      input.checked = checked;
      toggle.toggleClass("is-enabled", checked);
    };

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      const next = !input.checked;
      setChecked(next);
      void onChange(next);
    });
  }

  private addDropdownField(
    parent: HTMLElement,
    label: string,
    description: string,
    value: string,
    choices: Array<{ value: string; label: string }>,
    onChange: (value: string) => Promise<void> | void,
    placeholder?: string
  ): void {
    const control = this.addField(parent, label, description);
    const select = control.createEl("select", { cls: "cw-input cw-select" });
    if (placeholder) {
      select.createEl("option", { value: "", text: placeholder });
    }
    for (const choice of choices) {
      const option = select.createEl("option", { value: choice.value, text: choice.label });
      option.selected = choice.value === value;
    }
    select.addEventListener("change", () => {
      void onChange(select.value);
    });
  }

  private addTextField(
    parent: HTMLElement,
    label: string,
    description: string,
    value: string,
    onChange: (value: string) => Promise<void> | void,
    options: { password?: boolean; placeholder?: string } = {}
  ): void {
    const control = this.addField(parent, label, description);
    const input = control.createEl("input", {
      cls: "cw-input",
      type: options.password ? "password" : "text",
      attr: options.placeholder ? { placeholder: options.placeholder } : {}
    });
    input.value = value;
    input.addEventListener("change", () => {
      void onChange(input.value);
    });
  }

  private addTextareaField(
    parent: HTMLElement,
    label: string,
    description: string,
    value: string,
    onChange: (value: string) => Promise<void> | void,
    rows = 6
  ): void {
    const control = this.addField(parent, label, description);
    const textarea = control.createEl("textarea", {
      cls: "cw-input cw-textarea",
      attr: { rows: String(rows) }
    });
    textarea.value = value;
    textarea.addEventListener("change", () => {
      void onChange(textarea.value);
    });
  }

  private addSliderField(
    parent: HTMLElement,
    label: string,
    description: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => Promise<void> | void
  ): void {
    const control = this.addField(parent, label, description);
    const row = control.createDiv({ cls: "cw-slider-row" });
    const slider = row.createEl("input", {
      cls: "cw-slider",
      type: "range",
      attr: {
        min: String(min),
        max: String(max),
        step: String(step)
      }
    });
    slider.value = String(value);
    const numberInput = row.createEl("input", {
      cls: "cw-input cw-number-input",
      type: "number",
      attr: {
        min: String(min),
        max: String(max),
        step: String(step)
      }
    });
    numberInput.value = String(value);

    const sync = (next: number) => {
      const clamped = clampNumber(next, min, max, value);
      slider.value = String(clamped);
      numberInput.value = String(clamped);
      void onChange(clamped);
    };

    slider.addEventListener("input", () => {
      sync(Number(slider.value));
    });
    numberInput.addEventListener("change", () => {
      sync(Number(numberInput.value));
    });
  }

  private renderAiProviderSettings(sectionBody: HTMLElement): void {
    const fields = this.createFields(sectionBody);

    this.addToggleField(
      fields,
      "Privacy notice",
      "Required before Cowriter can send text to any enabled provider.",
      this.plugin.settings.privacyNoticeAccepted,
      async (value) => {
        this.plugin.settings.privacyNoticeAccepted = value;
        await this.plugin.saveSettings();
      }
    );

    this.addDropdownField(
      fields,
      "Active provider",
      "Choose a provider you enabled yourself. Local providers are recommended.",
      this.plugin.settings.activeProvider,
      (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
        const provider = this.plugin.settings.providers[id];
        const enabled = provider.enabled ? "enabled" : "disabled";
        return {
          value: id,
          label: `${PROVIDERS[id].name} (${enabled}, ${PROVIDERS[id].privacyLabel})`
        };
      }),
      async (value) => {
        this.plugin.settings.activeProvider = value as ActiveProviderId;
        if (value) {
          this.expandedProviders.add(value as ProviderId);
        }
        await this.plugin.saveSettings();
        this.display();
      },
      "Choose a provider..."
    );

    if (activeModelSupportsReasoning(this.plugin.settings)) {
      this.addDropdownField(
        fields,
        "Thinking effort",
        "Controls extended reasoning for models that support it.",
        this.plugin.settings.reasoningEffort,
        REASONING_EFFORT_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
        async (value) => {
          this.plugin.settings.reasoningEffort = normalizeReasoningEffort(value);
          await this.plugin.saveSettings();
        }
      );
    }

    const providersWrap = sectionBody.createDiv({ cls: "cw-providers" });
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
      this.renderProvider(providersWrap, id);
    }
  }

  private renderSearchSettings(sectionBody: HTMLElement): void {
    const fields = this.createFields(sectionBody);

    this.addToggleField(
      fields,
      "Enable Brave Search",
      "Allow Cowriter to call Brave Search for the Fact check action.",
      this.plugin.settings.braveSearch.enabled,
      async (value) => {
        this.plugin.settings.braveSearch.enabled = value;
        await this.plugin.saveSettings();
      }
    );

    this.addToggleField(
      fields,
      "Brave Search consent",
      "I understand selected text may be sent to Brave as search queries during fact checking.",
      this.plugin.settings.braveSearch.consentToSend,
      async (value) => {
        this.plugin.settings.braveSearch.consentToSend = value;
        await this.plugin.saveSettings();
      }
    );

    this.addTextField(
      fields,
      "Brave Search API key",
      "Get a key at api.search.brave.com. Stored locally in plugin data.",
      this.plugin.settings.braveSearch.apiKey,
      async (value) => {
        this.plugin.settings.braveSearch.apiKey = value.trim();
        await this.plugin.saveSettings();
      },
      { password: true, placeholder: "your Brave Search API key" }
    );

    this.addSliderField(
      fields,
      "Results per query",
      "How many web results Brave returns for each fact-check search query (1-10).",
      this.plugin.settings.braveSearch.resultCount,
      1,
      10,
      1,
      async (value) => {
        this.plugin.settings.braveSearch.resultCount = value;
        await this.plugin.saveSettings();
      }
    );
  }

  private renderAdvancedSettings(sectionBody: HTMLElement): void {
    const fields = this.createSubsection(sectionBody, "Model behavior");

    this.addDropdownField(
      fields,
      "Insert mode",
      "Replace the selection or append Cowriter's response below it.",
      this.plugin.settings.insertMode,
      [
        { value: "replace", label: "Replace selection" },
        { value: "append", label: "Append below" }
      ],
      async (value) => {
        this.plugin.settings.insertMode = value as InsertMode;
        await this.plugin.saveSettings();
      }
    );

    this.addSliderField(
      fields,
      "Temperature",
      "Lower values are more focused; higher values are more varied.",
      this.plugin.settings.temperature,
      0,
      2,
      0.01,
      async (value) => {
        this.plugin.settings.temperature = Number(value.toFixed(2));
        await this.plugin.saveSettings();
      }
    );

    this.addTextareaField(
      fields,
      "System prompt",
      "The baseline behavior Cowriter sends with each request.",
      this.plugin.settings.systemPrompt,
      async (value) => {
        this.plugin.settings.systemPrompt = value;
        await this.plugin.saveSettings();
      },
      7
    );
  }

  private renderStylePresets(sectionBody: HTMLElement): void {
    const fields = this.createSubsection(sectionBody, "Rewrite in style");
    const panel = fields.createDiv({ cls: "cw-panel" });
    panel.createDiv({
      cls: "cw-field-label",
      text: "Style presets"
    });
    panel.createDiv({
      cls: "cw-field-desc",
      text: "Styles appear in the Rewrite in style menu. Add tones, formats, or voices."
    });

    const listEl = panel.createDiv({ cls: "cw-preset-list" });
    const renderList = () => {
      listEl.empty();
      if (this.plugin.settings.styles.length === 0) {
        listEl.createDiv({
          cls: "cw-preset-empty",
          text: "No styles yet. Add one below."
        });
        return;
      }

      for (const style of this.plugin.settings.styles) {
        const row = listEl.createDiv({ cls: "cw-preset-row" });
        row.createSpan({ cls: "cw-preset-label", text: style });
        const deleteButton = row.createEl("button", {
          cls: "clickable-icon cw-preset-delete",
          attr: { "aria-label": "Remove style" }
        });
        setIcon(deleteButton, "trash-2");
        deleteButton.addEventListener("click", async () => {
          this.plugin.settings.styles = this.plugin.settings.styles.filter((item) => item !== style);
          await this.plugin.saveSettings();
          renderList();
        });
      }
    };

    renderList();

    const addRow = panel.createDiv({ cls: "cw-inline-row" });
    const styleInput = addRow.createEl("input", {
      type: "text",
      cls: "cw-input",
      attr: { placeholder: "Style or voice description" }
    });
    const addButton = addRow.createEl("button", { cls: "mod-cta", text: "Add style" });

    const addStyle = async () => {
      const value = styleInput.value.trim();
      if (!value) {
        new Notice("Enter a style name or description.");
        return;
      }
      if (this.plugin.settings.styles.includes(value)) {
        new Notice("That style already exists.");
        return;
      }
      this.plugin.settings.styles = [...this.plugin.settings.styles, value];
      await this.plugin.saveSettings();
      styleInput.value = "";
      renderList();
    };

    addButton.addEventListener("click", () => {
      void addStyle();
    });
    styleInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void addStyle();
    });
  }

  private renderSkillsSettings(sectionBody: HTMLElement): void {
    const fields = this.createSubsection(sectionBody, "Skills");
    this.addTextareaField(
      fields,
      "Skill presets",
      "One skill per line. Appears in the Use skill menu.",
      this.plugin.settings.skills.join("\n"),
      async (value) => {
        this.plugin.settings.skills = value
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean);
        await this.plugin.saveSettings();
      },
      7
    );
  }

  private renderProvider(parent: HTMLElement, id: ProviderId): void {
    const providerInfo = PROVIDERS[id];
    const provider = this.plugin.settings.providers[id];
    const expanded = this.expandedProviders.has(id);

    const accordion = parent.createDiv({
      cls: `cw-accordion${expanded ? " is-expanded" : ""}`
    });
    const header = accordion.createDiv({ cls: "cw-accordion-header" });
    header.createSpan({ cls: "cw-accordion-caret" });
    header.createSpan({ cls: "cw-accordion-title", text: providerInfo.name });
    header.createSpan({
      cls: `cw-accordion-badge${providerInfo.remote ? " is-remote" : ""}`,
      text: providerInfo.remote ? "Remote" : "Local"
    });

    const body = accordion.createDiv({ cls: "cw-accordion-body" });
    if (!expanded) {
      body.hide();
    }

    header.addEventListener("click", () => {
      const willExpand = body.hidden;
      if (willExpand) {
        this.expandedProviders.add(id);
        body.show();
        accordion.addClass("is-expanded");
      } else {
        this.expandedProviders.delete(id);
        body.hide();
        accordion.removeClass("is-expanded");
      }
    });

    if (providerInfo.remote) {
      body.createDiv({
        cls: "cw-callout",
        text: "Remote provider: selected note text may leave your vault when you run Cowriter."
      });
    }

    const fields = this.createFields(body);

    this.addToggleField(
      fields,
      `Enable ${providerInfo.name}`,
      providerInfo.remote
        ? "Remote providers remain disconnected until enabled and consented."
        : "Local provider connection.",
      provider.enabled,
      async (value) => {
        provider.enabled = value;
        if (!value && this.plugin.settings.activeProvider === id) {
          this.plugin.settings.activeProvider = "";
        }
        if (value && !this.plugin.settings.activeProvider) {
          this.plugin.settings.activeProvider = id;
        }
        await this.plugin.saveSettings();
        this.display();
      }
    );

    this.addToggleField(
      fields,
      `Consent for ${providerInfo.name}`,
      providerInfo.remote
        ? `I understand Cowriter may send selected note text to ${providerInfo.name}.`
        : `I allow Cowriter to send selected note text to my local ${providerInfo.name} server.`,
      provider.consentToSend,
      async (value) => {
        provider.consentToSend = value;
        await this.plugin.saveSettings();
      }
    );

    this.addTextField(fields, "Endpoint", providerInfo.endpointDescription, provider.endpoint, async (value) => {
      provider.endpoint = value.trim() || providerInfo.defaultEndpoint;
      await this.plugin.saveSettings();
    });

    this.addTextField(
      fields,
      "Model",
      provider.discoveredModels.length > 0
        ? "Choose a detected model or type a model name manually."
        : "Type a model name manually, or refresh models after enabling this provider.",
      provider.model,
      async (value) => {
        provider.model = value.trim() || providerInfo.defaultModel;
        await this.plugin.saveSettings();
        this.display();
      }
    );

    if (id === "openrouter") {
      this.addDropdownField(
        fields,
        "Recommended models",
        "Latest curated OpenRouter models. GPT-5.5 is intentionally excluded.",
        OPENROUTER_CURATED_MODELS.some((model) => model.id === provider.model) ? provider.model : "",
        OPENROUTER_CURATED_MODELS.map((model) => ({ value: model.id, label: model.label })),
        async (value) => {
          if (!value) {
            return;
          }
          provider.model = value;
          provider.modelSupportsReasoning[value] = true;
          await this.plugin.saveSettings();
          this.display();
        },
        "Choose a recommended model..."
      );
    }

    const modelsField = this.addField(
      fields,
      "Detected models",
      "Refresh and choose from models exposed by this enabled provider."
    );
    const modelsRow = modelsField.createDiv({ cls: "cw-inline-row" });
    const modelsSelect = modelsRow.createEl("select", { cls: "cw-input cw-select" });
    modelsSelect.createEl("option", { value: "", text: "Detected models..." });
    for (const model of provider.discoveredModels) {
      const option = modelsSelect.createEl("option", { value: model, text: model });
      option.selected = model === provider.model;
    }
    modelsSelect.addEventListener("change", async () => {
      if (!modelsSelect.value) {
        return;
      }
      provider.model = modelsSelect.value;
      await this.plugin.saveSettings();
      this.display();
    });

    const refreshButton = modelsRow.createEl("button", { cls: "mod-cta", text: "Refresh" });
    refreshButton.addEventListener("click", async () => {
      try {
        new Notice(`Checking ${providerInfo.name} models...`);
        provider.discoveredModels = await discoverModels(id, provider);
        if (!provider.model && provider.discoveredModels[0]) {
          provider.model = provider.discoveredModels[0];
        }
        await this.plugin.saveSettings();
        new Notice(
          provider.discoveredModels.length > 0
            ? `Found ${provider.discoveredModels.length} ${providerInfo.name} models.`
            : `${providerInfo.name} returned no models.`
        );
        this.display();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not refresh ${providerInfo.name} models: ${message}`);
      }
    });

    if (providerInfo.remote || id === "lmstudio") {
      this.addTextField(
        fields,
        "API key",
        id === "lmstudio" ? "Optional for most LM Studio setups." : "Stored locally in Obsidian plugin data.",
        provider.apiKey,
        async (value) => {
          provider.apiKey = value.trim();
          await this.plugin.saveSettings();
        },
        { password: true, placeholder: `your ${providerInfo.name} API key` }
      );
    }
  }
}
