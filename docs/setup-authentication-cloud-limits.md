# Setup, Authentication, and Cloud Limits

## 1. Installation and Setup

Letta Code can run with either a local backend or Letta Cloud.

To install the CLI:


```bash
npm install -g @letta-ai/letta-code
```

Start Letta Code:


```bash
letta
```

On the first launch, users can sign in with Letta or continue in local mode. The selected backend determines where agent state, including conversations and memory, is stored.

To change the backend later:


```bash
letta setup
```


Alternatively, use `letta backend cloud` or `letta backend local`.

```bash
letta backend cloud
letta backend local
```

## 2. Authentication

Interactive users can sign in through the Letta setup flow or use `/login` from the CLI.

Use `/connect` to configure external model-provider API keys.

For headless execution with Letta Cloud, set the `LETTA_API_KEY` environment variable. API keys are available from the Letta API Keys page.

Example:

```bash
export LETTA_API_KEY="your-api-key"
```

Do not commit API keys to source control or include them in shared screenshots, logs, or documentation.

If a headless Cloud run does not have the required key, Letta Code displays a `Missing LETTA_API_KEY` error.


## 3. Cloud Storage Limits

Letta Cloud memory repositories have plan-based storage limits:


| Plan | Memory storage limit |
|---|---:|
| Free | 5 MiB per repository |
| Pro | 50 MiB per repository |


The storage calculation uses files in the latest snapshot of each branch or tag. It does not count the complete Git history.

To manage storage, keep durable agent knowledge in memory and store large datasets, media, and archives elsewhere.

These figures describe memory-repository storage. They should not be interpreted as API request, model-token, or execution-time quotas. Check the current Letta account and official documentation for other plan restrictions, since service limits may change.


## 4. Additional Resources


- [Letta Quickstart](https://docs.letta.com/quickstart)
- [Letta Memory Documentation](https://docs.letta.com/configuration/memory)
- [Letta API Keys](https://chat.letta.com/preferences/api-keys)
