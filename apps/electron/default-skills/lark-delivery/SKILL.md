---
name: lark-delivery
description: >
  Lark cloud-delivery workflow. Trigger when the user asks to write or update long reports, proposals, meeting minutes, project documents, spreadsheets, Base tables, or calendar events in Lark;
  also applies to requests such as "sync to Lark," "create a Lark document," "update Base/multidimensional tables," "schedule an event," "check my calendar," or "give me a Lark link." First use the official Lark CLI/MCP `--help` or tool discovery to confirm available commands, then query the target, make the smallest required write, and return only an actual generated URL.
group: profer
version: "1.1.1"
---

# Lark Delivery

You reliably deliver content that the user explicitly wants to preserve in Lark to the cloud. Use the official Lark CLI or official Lark OpenAPI MCP configured in Profer. Do not reimplement the Lark OpenAPI, and do not treat the Bot message bridge as access to the user's cloud drive.

## Identity and Credential Boundaries

- The Lark Bot is only for sending and receiving messages, attachments, streaming cards, and replying to chat with the final summary/link; it does not grant the user's cloud-document permissions.
- Resources such as cloud documents, Base/multidimensional tables, Sheets, calendar events, and free/busy information must use the user's OAuth identity or a configured official MCP identity.
- Never read, ask the user to paste into chat, copy into logs/Skills/documents, or include in the final response any token, refresh token, App Secret, Cookie, or Authorization header.
- If the settings page or CLI diagnostics display "not logged in" or "reauthorization required," clearly tell the user to log in under "Lark cloud capabilities" in Profer settings; do not pretend access is available.

## Delivery Decisions

1. **Short results** (usually less than about one screen, with no user request to archive): reply directly in the current chat without creating an extra cloud document.
2. **Long results or content that needs a collaborative record** (reports, proposals, research, meeting minutes, tutorials, task lists): preferably create or update a Lark cloud document, then provide a brief summary and the real link in chat.
3. **Structured data** (multiple records, explicit fields, filtering, status tracking, ongoing collaboration): prefer Base/multidimensional tables; use Sheets only when the user explicitly prefers a spreadsheet or the data is inherently a two-dimensional calculation table.
4. **Existing target link/name**: query, resolve, and confirm the target first, then update it; do not create a same-named duplicate resource because a lookup failed.

## Operating Procedure

### 1. Discover Capabilities First; Do Not Guess Commands

- Prefer official Lark MCP tools already discovered in this session.
- When using the CLI, first run `lark-cli --help`, then run `--help` for the target subcommand. Commands, parameters, and output formats may vary between CLI versions.
- Use only commands and parameters confirmed by the help output; do not assemble write commands based on memory or snippets from the web.
- Confirm the user's OAuth status before writing. If a command fails, preserve a deliverable local Markdown/CSV/JSON result; do not pretend it was written to the cloud.

### 2. Query First, Then Minimize Writes

- For an existing document/Base/Sheet: first read or query its title, URL, ID, current content/fields, and confirm it matches the user's target.
- For calendar operations: first query the primary calendar and target time range. Before creating or updating an event, confirm the time zone, start/end time, recurrence rules, and participants to avoid duplicate bookings.
- When updating, modify only the paragraphs, records, or fields requested by the user; preserve unrelated content.
- For new resources: use a clear title and structured body/fields rather than pasting chat text without formatting.
- For Base, confirm the table and fields first; add only missing fields if needed. Before bulk writes, verify the record count to avoid duplicates.

### 3. Verify and Return

- On success, extract the resource URL from the **actual CLI/MCP response**; optionally read it once more to confirm that the resource is accessible.
- If there is no actual URL, clearly write "completed, but no verifiable link was obtained" and give a recoverable next step; never fabricate a `feishu.cn`/`larksuite.com` URL.
- Final-message format for long results: one-sentence summary + URL; continue replying directly for short results.
- The final reply in the Lark Bot channel must also retain the real URL so the existing Bridge can write it back verbatim.

## Failure and Recovery

- Not logged in / authorization expired: explain that authorization must be renewed in settings; do not try to bypass OAuth.
- Insufficient permissions: explain the resource permission or scope required for the target operation; do not repeatedly retry the write.
- Network, CLI/MCP, or remote-write failure: preserve the local content and report which local parts are complete and which step failed.
- If the cloud write succeeded but message delivery failed: do not create the resource again; save the real URL in the local result and wait for a recoverable delivery path.
- If a calendar event was written successfully but no verifiable event ID/link was returned, do not claim the booking is complete; retain the request parameters and error information for review before retrying.

## Artifact Convention

After successfully delivering a long result to Lark, include the following machine-readable marker in the final result. The URL must be the actual returned value and must not contain sensitive parameters:

```text
<profer_artifacts>
- type: lark_document | lark_base | lark_sheet | lark_calendar_event
  title: <resource title>
  url: <verified URL>
</profer_artifacts>
```

Do not output this marker if the cloud write did not succeed.
