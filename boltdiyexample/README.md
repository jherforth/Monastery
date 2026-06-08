# bolt.diy

[![bolt.diy: AI-Powered Full-Stack Web Development in the Browser](./public/social_preview_index.jpg)](https://bolt.diy)

Welcome to bolt.diy, the official open source version of Bolt.new, which allows you to choose the LLM that you use for each prompt! Currently, you can use OpenAI, Anthropic, Ollama, OpenRouter, Gemini, LMStudio, Mistral, xAI, HuggingFace, DeepSeek, Groq, Cohere, Together, Perplexity, Moonshot (Kimi), Hyperbolic, GitHub Models, Amazon Bedrock, and OpenAI-like providers - and it is easily extended to use any other model supported by the Vercel AI SDK! See the instructions below for running this locally and extending it to include more models.

-----
Check the [bolt.diy Docs](https://stackblitz-labs.github.io/bolt.diy/) for more official installation instructions and additional information.

-----
Also [this pinned post in our community](https://thinktank.ottomator.ai/t/videos-tutorial-helpful-content/3243) has a bunch of incredible resources for running and deploying bolt.diy yourself!

We have also launched an experimental agent called the "bolt.diy Expert" that can answer common questions about bolt.diy. Find it here on the [oTTomator Live Agent Studio](https://studio.ottomator.ai/).

bolt.diy was originally started by [Cole Medin](https://www.youtube.com/@ColeMedin) but has quickly grown into a massive community effort to build the BEST open source AI coding assistant!

## Table of Contents

- [Join the Community](#join-the-community)
- [Recent Major Additions](#recent-major-additions)
- [Features](#features)
- [Setup](#setup)
- [Quick Installation](#quick-installation)
- [Manual Installation](#manual-installation)
- [Configuring API Keys and Providers](#configuring-api-keys-and-providers)
- [Setup Using Git (For Developers only)](#setup-using-git-for-developers-only)
- [Available Scripts](#available-scripts)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [FAQ](#faq)

## Join the community

[Join the bolt.diy community here, in the oTTomator Think Tank!](https://thinktank.ottomator.ai)

## Project management

Bolt.diy is a community effort! Still, the core team of contributors aims at organizing the project in way that allows
you to understand where the current areas of focus are.

If you want to know what we are working on, what we are planning to work on, or if you want to contribute to the
project, please check the [project management guide](./PROJECT.md) to get started easily.

## Recent Major Additions

### ✅ Completed Features
- **19+ AI Provider Integrations** - OpenAI, Anthropic, Google, Groq, xAI, DeepSeek, Mistral, Cohere, Together, Perplexity, HuggingFace, Ollama, LM Studio, OpenRouter, Moonshot, Hyperbolic, GitHub Models, Amazon Bedrock, OpenAI-like
- **Electron Desktop App** - Native desktop experience with full functionality
- **Advanced Deployment Options** - Netlify, Vercel, and GitHub Pages deployment
- **Supabase Integration** - Database management and query capabilities
- **Data Visualization & Analysis** - Charts, graphs, and data analysis tools
- **MCP (Model Context Protocol)** - Enhanced AI tool integration
- **Search Functionality** - Codebase search and navigation
- **File Locking System** - Prevents conflicts during AI code generation
- **Diff View** - Visual representation of AI-made changes
- **Git Integration** - Clone, import, and deployment capabilities
- **Expo App Creation** - React Native development support
- **Voice Prompting** - Audio input for prompts
- **Bulk Chat Operations** - Delete multiple chats at once
- **Project Snapshot Restoration** - Restore projects from snapshots on reload

### 🔄 In Progress / Planned
- **File Locking & Diff Improvements** - Enhanced conflict prevention
- **Backend Agent Architecture** - Move from single model calls to agent-based system
- **LLM Prompt Optimization** - Better performance for smaller models
- **Project Planning Documentation** - LLM-generated project plans in markdown
- **VSCode Integration** - Git-like confirmations and workflows
- **Document Upload for Knowledge** - Reference materials and coding style guides
- **Additional Provider Integrations** - Azure OpenAI, Vertex AI, Granite

## Features

- **AI-powered full-stack web development** for **NodeJS based applications** directly in your browser.
- **Support for 19+ LLMs** with an extensible architecture to integrate additional models.
- **Attach images to prompts** for better contextual understanding.
- **Integrated terminal** to view output of LLM-run commands.
- **Revert code to earlier versions** for easier debugging and quicker changes.
- **Download projects as ZIP** for easy portability and sync to a folder on the host.
- **Integration-ready Docker support** for a hassle-free setup.
- **Deploy directly** to **Netlify**, **Vercel**, or **GitHub Pages**.
- **Electron desktop app** for native desktop experience.
- **Data visualization and analysis** with integrated charts and graphs.
- **Git integration** with clone, import, and deployment capabilities.
- **MCP (Model Context Protocol)** support for enhanced AI tool integration.
- **Search functionality** to search through your codebase.
- **File locking system** to prevent conflicts during AI code generation.
- **Diff view** to see changes made by the AI.
- **Supabase integration** for database management and queries.
- **Expo app creation** for React Native development.
