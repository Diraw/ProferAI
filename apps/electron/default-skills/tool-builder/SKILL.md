---
name: tool-builder
description: Interactively create and manage custom HTTP tools for Chat mode. Use this skill when the user wants to create a new API tool, configure a Chat tool, add a custom tool, manage a custom tool, or says "help me create an XX tool". It also applies when debugging, fixing, or deleting an existing custom tool.
version: "1.0.2"
---
# Tool Builder

Help users create custom HTTP API tools that can be used in Chat mode through interactive conversation.

## Workflow

### 1. Gather requirements

Ask the user about:
- The tool's purpose (weather lookup, translation, exchange rates, etc.)
- The API endpoint URL and authentication method
- Which parameters are needed (name, type, whether required)
- The HTTP method (GET/POST)
- Which part of the response should be extracted

If the user is unsure which API to use, help recommend a suitable public API.

### 2. Build the configuration

Build the tool configuration JSON from the collected information. The configuration file is `~/.profer/chat-tools.json`.

#### Configuration file structure

```json
{
  "toolStates": {
    "memory": { "enabled": true },
    "web-search": { "enabled": false },
    "custom-weather": { "enabled": true }
  },
  "toolCredentials": {},
  "customTools": [
    {
      "id": "custom-weather",
      "name": "Weather Lookup",
      "description": "Look up the current weather information for a specified city",
      "params": [
        { "name": "city", "type": "string", "description": "City name", "required": true }
      ],
      "category": "custom",
      "executorType": "http",
      "httpConfig": {
        "urlTemplate": "https://wttr.in/{{city}}?format=j1",
        "method": "GET",
        "resultPath": "current_condition"
      }
    }
  ]
}
```

#### ChatToolMeta field reference

| Field | Required | Description |
|------|------|------|
| `id` | Yes | Unique identifier; must use the `custom-` prefix + slug format (for example, `custom-weather`) |
| `name` | Yes | Display name |
| `description` | Yes | Tool description; the AI uses it to decide when to call the tool |
| `params` | Yes | Parameter list; each item contains `name`/`type`/`description`/`required` |
| `category` | Yes | Fixed as `"custom"` |
| `executorType` | Yes | Fixed as `"http"` |
| `httpConfig` | Yes | HTTP request configuration |
| `icon` | No | Lucide icon name (for example, `"Cloud"` or `"Languages"`) |
| `systemPromptAppend` | No | System prompt injected when enabled |

#### httpConfig field reference

| Field | Required | Description |
|------|------|------|
| `urlTemplate` | Yes | URL template; `{{paramName}}` placeholders are replaced with parameter values (URL-encoded automatically) |
| `method` | Yes | `"GET"` or `"POST"` |
| `headers` | No | Request headers, commonly used for API key authentication: `{ "Authorization": "Bearer xxx" }` |
| `bodyTemplate` | No | JSON template for a POST request body; `{{paramName}}` placeholders are replaced (without encoding) |
| `resultPath` | No | Dot path that extracts a specific field from the response (for example, `"data.results"`) |

#### Parameter types

`params[].type` supports: `"string"` / `"number"` / `"boolean"`

You can optionally add an `enum` field to restrict the available values:
```json
{ "name": "unit", "type": "string", "description": "Temperature unit", "enum": ["celsius", "fahrenheit"] }
```

### 3. Write the configuration

Steps:
1. Read `~/.profer/chat-tools.json` (create it if it does not exist)
2. Append the new tool to the `customTools` array (deduplicate by `id`)
3. Add `{ "enabled": true }` to `toolStates` so it is enabled by default
4. Write the file back (preserve formatted JSON)

After writing, the application automatically detects the file change and refreshes the tool list.

### 4. Testing guidance

Tell the user:
- "The tool has been created and enabled. Switch to Chat mode to test it."
- "The new tool should appear in the tool picker at the lower left of the Chat input box."
- "Try asking a question that requires this tool."
- "If there is a problem, return to Agent mode and tell me; I can help debug it."

### 5. Debugging and fixes

Common causes when the user reports a problem:
- Incorrect URL template → fix `urlTemplate`
- Incorrect parameter mapping → adjust the `params` definition
- Response format changed → modify `resultPath`
- Authentication failure → check the API key in `headers`
- Timeout → check API reachability

After fixing, write `chat-tools.json` again; the application refreshes automatically.

### 6. Delete a tool

Remove the corresponding tool from the `customTools` array and delete its entry from `toolStates`.

## Complete example: weather lookup tool

```json
{
  "id": "custom-weather",
  "name": "Weather Lookup",
  "description": "Look up the current weather and temperature for a specified city. Call this when the user asks about the weather.",
  "params": [
    { "name": "city", "type": "string", "description": "City name (in English)", "required": true }
  ],
  "category": "custom",
  "executorType": "http",
  "httpConfig": {
    "urlTemplate": "https://wttr.in/{{city}}?format=j1",
    "method": "GET",
    "resultPath": "current_condition"
  }
}
```

## Complete example: translation tool (POST + API key)

```json
{
  "id": "custom-translate",
  "name": "Translation",
  "description": "Translate text into a target language. Call this when the user needs a translation.",
  "params": [
    { "name": "text", "type": "string", "description": "Text to translate", "required": true },
    { "name": "target_lang", "type": "string", "description": "Target language code", "required": true, "enum": ["EN", "ZH", "JA", "KO", "FR", "DE", "ES"] }
  ],
  "category": "custom",
  "executorType": "http",
  "httpConfig": {
    "urlTemplate": "https://api.example.com/translate",
    "method": "POST",
    "headers": { "Authorization": "Bearer YOUR_API_KEY" },
    "bodyTemplate": "{\"text\": \"{{text}}\", \"target_lang\": \"{{target_lang}}\"}",
    "resultPath": "translations.0.text"
  }
}
```
