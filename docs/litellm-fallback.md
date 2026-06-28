# Local LiteLLM Fallback Setup

This document describes how to run LiteLLM locally as a gateway/proxy for Apex CRM, enabling automatic fallback from Byesu to OpenRouter Gemma.

## Prerequisites

1. Install LiteLLM:
   ```bash
   pip install litellm
   ```

2. Make sure you have the following API keys ready:
   - `BYESU_API_KEY`: Your Byesu API key.
   - `OPENROUTER_API_KEY`: Your OpenRouter API key.

---

## Running the LiteLLM Proxy

Choose the command matching your shell/OS:

### Windows PowerShell
```powershell
$env:LITELLM_MASTER_KEY="sk-local-litellm"
$env:BYESU_API_KEY="your_byesu_key"
$env:OPENROUTER_API_KEY="your_openrouter_key"
litellm --config litellm.config.yaml --port 4000
```

### Windows Command Prompt (CMD)
```cmd
set LITELLM_MASTER_KEY=sk-local-litellm
set BYESU_API_KEY=your_byesu_key
set OPENROUTER_API_KEY=your_openrouter_key
litellm --config litellm.config.yaml --port 4000
```

### Linux / macOS / Git Bash
```bash
export LITELLM_MASTER_KEY=sk-local-litellm
export BYESU_API_KEY=your_byesu_key
export OPENROUTER_API_KEY=your_openrouter_key
litellm --config litellm.config.yaml --port 4000
```

---

## Running Apex CRM in LiteLLM Mode

Once the LiteLLM proxy is running on port `4000`, start Apex CRM with `LLM_GATEWAY_MODE` set to `litellm`.

### Windows PowerShell
```powershell
$env:LLM_GATEWAY_MODE="litellm"
$env:LITELLM_MASTER_KEY="sk-local-litellm"
npm run dev
```

### Windows Command Prompt (CMD)
```cmd
set LLM_GATEWAY_MODE=litellm
set LITELLM_MASTER_KEY=sk-local-litellm
npm run dev
```

### Linux / macOS / Git Bash
```bash
export LLM_GATEWAY_MODE=litellm
export LITELLM_MASTER_KEY=sk-local-litellm
npm run dev
```

---

## Verification

You can verify that the gateway is functioning by calling the health check endpoint:
```bash
curl http://localhost:3000/api/llm-health
```

Expected JSON response:
```json
{
  "mode": "litellm",
  "baseUrl": "http://localhost:4000/v1",
  "model": "apex-primary",
  "ok": true
}
```
