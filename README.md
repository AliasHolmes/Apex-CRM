<div align="center">
  <h1>🚀 Apex CRM</h1>
  <p><strong>Next-Generation AI-Powered Sales, Lead Mining & Prospecting Platform</strong></p>

  <p>
    <img src="https://img.shields.io/badge/React-19.0-61DAFB?logo=react&logoColor=black" alt="React" />
    <img src="https://img.shields.io/badge/Vite-6.2-646CFF?logo=vite&logoColor=white" alt="Vite" />
    <img src="https://img.shields.io/badge/TailwindCSS-4.0-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind" />
    <img src="https://img.shields.io/badge/SQLite-Local_First-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
    <img src="https://img.shields.io/badge/LiteLLM-Proxy_Gateway-007ACC?logo=python&logoColor=white" alt="LiteLLM" />
    <img src="https://img.shields.io/badge/AI-OpenAI_Compatible-FFD54F?logo=openai&logoColor=black" alt="OpenAI" />
  </p>
</div>

---

## ✨ Overview

**Apex CRM** is a cutting-edge, local-first Customer Relationship Management tool designed for modern sales teams. It seamlessly integrates AI-driven prospecting, intelligent lead enrichment, and automated outreach drafting into a single, lightning-fast workspace.

By combining the power of a **local LiteLLM gateway** with automatic **OpenRouter fallback routing**, **Bright Data** for deep profile enrichment, **Tavily** for real-time web scraping, and a **Local SQLite** backend, Apex CRM provides a highly resilient and cost-effective sales intelligence pipeline.

---

## 🛠️ Architecture & Tech Stack

```mermaid
graph TD
    Client[🖥️ React Frontend :3000] -->|REST API| Server[⚙️ Express Server Node v24]
    Server -->|Sync Persistence| DB[(🗄️ Local SQLite)]
    Server -->|Auth| OAuth[🔐 Google OAuth]
    
    %% LLM Pathway
    Server -->|AI Prompts| LLM[🧠 LiteLLM Gateway :4000]
    LLM -->|Primary| Byesu[🌐 Byesu API]
    LLM -->|Fallback| OpenRouter[🌐 OpenRouter API]

    %% Search & Enrichment
    Server -->|Lead Discovery| Tavily[🔍 Tavily Search]
    Server -->|Profile Enrichment| BrightData[🕷️ Bright Data Scraping]

    classDef tech fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4;
    class Client,Server,DB,OAuth,LLM,Byesu,OpenRouter,Tavily,BrightData tech;
```

### Core Technologies

- **Frontend**: React 19, TailwindCSS 4, Framer Motion (UI Animations), Lucide React (Icons)
- **Backend**: Express.js, TypeScript, Node.js v24
- **Database**: `node:sqlite` (Built-in Local-first DB with WAL mode and Enrichment Caching)
- **AI Gateway**: LiteLLM (Local python-based routing proxy)
- **Integrations**: Byesu (Primary LLM), OpenRouter (Secondary Fallback LLM), Tavily (Search), Bright Data (Headless LinkedIn Scraping), Google OAuth (Authentication)

---

## 🚀 Key Features

| Feature | Description | Icon |
| :--- | :--- | :---: |
| **Adaptive Lead Mining** | Auto-discover prospects via Tavily, score them, and verify them against target ICP criteria. | 🔍 |
| **Deep Profile Enrichment**| Automatically enrich leads using Bright Data's headless LinkedIn scraping API. | 🕷️ |
| **Enrichment Cache** | Local SQLite caching layer that prevents duplicate API scraping calls to save costs. | 🗄️ |
| **LLM Gateway & Fallbacks**| Local LiteLLM proxy that routes to Byesu and automatically falls back to OpenRouter on failure. | 🧠 |
| **CRM Pipeline** | Visual Kanban board to drag-and-drop leads through your sales funnel. | 📋 |
| **Outreach Studio** | AI-generated, hyper-personalized email drafts based on lead profiles and intent. | ✉️ |
| **Local-First Speed** | Zero-latency UI with background syncing to a durable, local SQLite database. | ⚡ |

---

## 🚦 Getting Started

### Prerequisites

- **Node.js** (v24+ recommended for native SQLite support)
- **Python 3.12** (managed locally via `uv` under `.python/` for the LiteLLM proxy)
- API Keys for **Byesu**, **OpenRouter**, **Tavily**, and **Bright Data**

### Installation

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your Environment:**
   Copy the `.env.example` file to `.env` and fill in your credentials.

   ```env
   # Gateway Mode: "direct" or "litellm"
   LLM_GATEWAY_MODE="litellm"
   
   # API Keys
   OPENAI_API_KEY="your_byesu_key"
   LITELLM_MASTER_KEY="sk-local-litellm"
   BYESU_API_KEY="your_byesu_key"
   OPENROUTER_API_KEY="your_openrouter_key"
   TAVILY_API_KEY="your_tavily_key"
   BRIGHTDATA_API_TOKEN="your_brightdata_token"
   ```

3. **Start the Development Workspace:**
   ```bash
   npm run dev
   ```
   This single command will:
   - Start the **LiteLLM Proxy** on `http://localhost:4000` in the background (using a project-local virtual environment).
   - Start the **Apex CRM Dev Server** on `http://localhost:3000`.
   - **Note**: Stopping the dev server (`Ctrl+C`) will automatically kill the background LiteLLM proxy.

---

## 🔒 Privacy & Data

Apex CRM is designed to be **Local-First**. Your lead data is stored in a local SQLite file (`.apex-data/apex-crm.sqlite`) instead of the cloud, giving you complete control over your sales database. The database uses WAL (Write-Ahead Logging) mode for robust, transactional reliability.

---

<div align="center">
  <i>Built for the next generation of sales professionals.</i>
</div>
