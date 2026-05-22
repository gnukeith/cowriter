# Cowriter

Cowriter is a privacy-first AI writing plugin for Obsidian. It is designed for local models from the beginning, with built-in support for Ollama and LM Studio, plus opt-in connections to OpenRouter, Anthropic, OpenAI, and Gemini.

## Privacy stance

Cowriter does not contact any AI provider until the user explicitly enables that provider and acknowledges the privacy notice. Remote providers require an additional consent checkbox because selected note text may leave the vault.

Local models are recommended for privacy-first note taking:

- Ollama: `http://localhost:11434`
- LM Studio: `http://localhost:1234/v1`

Chat messages and attached context references are stored locally in Obsidian plugin data so chat history can be restored. Attached notes or folders are sent only when a chat message or writing action is run through an enabled, consented provider.

## Features

- System prompt control
- Rewrite shorter or longer
- Improve clarity
- Summarize
- Rewrite in a chosen style (customizable in settings)
- Custom writing instruction
- Built-in style presets, including voice-style options
- OpenRouter support with curated GPT-5.4, Gemini 3.5 Flash, and Claude Haiku 4.5 models
- Thinking effort controls for supported reasoning models
- Brave Search fact checking (right-click highlighted text)
- Cowriter chat with explicit note/folder context attachments
- Provider settings for local and remote models
- Explicit consent gates before any provider request

## Development

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<Your vault>/.obsidian/plugins/cowriter/
```

Then enable Cowriter in Obsidian's community plugins settings.
