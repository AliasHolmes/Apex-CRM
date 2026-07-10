<div align="center">
  <h1>Apex CRM</h1>
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

## Overview

**Apex CRM** is a local-first personal CRM for AI-assisted prospecting, deliberate enrichment, and outreach drafting. It is designed to run on one machine and keeps CRM data in local SQLite.

By combining the power of a **local LiteLLM gateway** with automatic **OpenRouter fallback routing**, **Bright Data** for deep profile enrichment, **Tavily** for real-time web scraping, and a **Local SQLite** backend, Apex CRM provides a highly resilient and cost-effective sales intelligence pipeline.

---

## Architecture & Tech Stack

```mermaid
graph TD
    Client[React Frontend :3000] -->|REST API| Server[Express Server 127.0.0.1]
    Server -->|Sync Persistence & Cache| DB[(Local SQLite)]
    
    %% LLM Pathway
    Server -->|AI Prompts| LLM[LiteLLM Gateway :4000]
    LLM -->|Primary| Byesu[Byesu API]
    LLM -->|Fallback| OpenRouter[OpenRouter API]

    %% Search & Enrichment
    Server -->|Lead Discovery| Tavily[Tavily Search]
    Server -->|Profile Enrichment| BrightData[Bright Data Scraping]

    %% Email Discovery Pipeline
    Server -.->|Waterfall Pipeline| EmailDiscovery{Email Discovery}
    EmailDiscovery -->|Step 1: Cache Lookup| DB
    EmailDiscovery -->|Step 2: Scrape Batch| BrightData
    EmailDiscovery -->|Step 3: Extract/Search| Tavily
    EmailDiscovery -->|Step 4: Web Crawl| Crawl[Company Web Fetch]
    EmailDiscovery -->|Step 5: MX Check| DNS[DNS MX Check]
    EmailDiscovery -->|Step 6: Fallback| Pattern[Pattern Inference]

    classDef tech fill:#1e1e2e,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4;
    class Client,Server,DB,LLM,Byesu,OpenRouter,Tavily,BrightData,EmailDiscovery,Crawl,DNS,Pattern tech;
```

### Core Technologies

- **Frontend**: React 19, TailwindCSS 4, Framer Motion (UI Animations), Lucide React (Icons)
- **Backend**: Express.js, TypeScript, Node.js v24
- **Database**: `node:sqlite` (Built-in Local-first DB with WAL mode, Enrichment Cache, and Email Discovery Caching)
- **AI Gateway**: LiteLLM (Local python-based routing proxy)
- **Integrations**: Byesu (Primary LLM), OpenRouter (Secondary Fallback LLM), Tavily (Search & Extract API), Bright Data (LinkedIn Profile & Search Scraper)

---

## Key Features

| Feature | Description |
| :--- | :--- |
| **Adaptive Lead Mining** | Auto-discover prospects via Tavily, score them, and verify them against target ICP criteria. |
| **Selected Profile Enrichment**| Enrich only the records selected in the inventory, with clear cache and provider status. |
| **Enrichment Cache** | Local SQLite caching layer that prevents duplicate API scraping & email discovery calls to save costs. |
| **Free-First Email Discovery** | A robust waterfall pipeline utilizing Bright Data batching, Tavily, local crawls, DNS/MX check, and email pattern inference to discover verified emails. |
| **LLM Gateway & Fallbacks**| Local LiteLLM proxy that routes to Byesu and automatically falls back to OpenRouter on failure. |
| **CRM Pipeline** | Explicit stage transitions for the sales funnel, including terminal converted/lost states. |
| **Outreach Studio** | AI-generated, hyper-personalized email drafts based on lead profiles and intent. |
| **Local-First Reliability** | Versioned SQLite migrations, per-lead revisions, durable mining-session records, and client reconciliation after writes. |

---

## Getting Started

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
   # Primary provider
   OPENAI_API_KEY="your_byesu_key"
   BYESU_API_KEY="your_byesu_key"
   OPENAI_BASE="https://api.byesu.com/v1"
   OPENAI_MODEL="gpt-5.5"

   # Direct fallbacks
   OPENROUTER_API_KEY="your_openrouter_key"
   OPENROUTER_MODEL="poolside/laguna-m.1:free"
   GROQ_API_KEY="your_groq_key"
   GROQ_MODEL="qwen/qwen3.6-27b"

   # External Integrations
   TAVILY_API_KEY="your_tavily_key"
   BRIGHTDATA_API_TOKEN="your_brightdata_token"

   # Email Discovery Configuration
   EMAIL_DISCOVERY_MODE="accepted_only" # "off" | "accepted_only" | "missing_only"
   EMAIL_DISCOVERY_MAX_PER_SEARCH="10"
   ```

3. **Start the Development Workspace:**
   ```bash
   npm run dev
   ```
   This starts the **Apex CRM Dev Server** at `http://127.0.0.1:3000`. In LiteLLM mode it also starts the local proxy at `127.0.0.1:4000`.

### Production run

```bash
npm run build
npm run start
```

The production server binds only to `127.0.0.1`. It blocks generated server bundles and source maps from static requests.

### Database migrations and recovery

On startup, Apex CRM applies transactional SQLite migrations. Before a migration it writes a timestamped backup under `.apex-data/backups/`.

- Schema v3 adds per-lead revisions and durable mining-session state.
- A mining session left running after a process restart is recorded as `interrupted` instead of appearing active forever.
- If a stale browser edit conflicts with a newer revision, the server returns the canonical record and the client reloads it.

### Verification

```bash
npm run lint
npm run test:lead-engine
npm run build
```

---

## Privacy & Data

Apex CRM is designed for **local-only** use. Your lead data is stored in `.apex-data/apex-crm.sqlite`; external providers receive only the data required for the search, enrichment, email-discovery, or LLM request you initiate. The direct company-page fetcher rejects private/local destinations, uses HTTPS only, and caps response size.

---

<div align="center">
  <i>Built for the next generation of sales professionals.</i>
</div>
