---
name: present-visualization
description: >-
  Guide to in-session visualization (present_visualization): when to visualize and which form to use (native charts, constrained fragments, or stateful interactions), how to write fragments and state (including LaTeX formulas), and how to update existing visualizations. Use when users ask for charts, diagrams, flowcharts, relationship maps, comparisons, adjustable explanations, or to explain/demo a process. Common requests include bar charts, grouped bars, horizontal bars, line charts, pie charts, scatter plots, trends, distributions, proportions, comparisons, schematics, structural diagrams, drawing a chart, turning something into a visual, visualizing data, animations, process demos, simulations, step-by-step walkthroughs, understanding a principle, adjustable parameters; English examples include chart, bar chart, line chart, pie chart, scatter plot, diagram, flowchart, visualization, visualize, visualisation, visualise, explain how, walk me through, step by step, step-by-step, tutorial, teach me, simulate, simulation, animate, animation, interactive explanation, visual explanation, and latex. Other common requests include curves, drawing an image, interactive views, explaining, deriving, teaching, introductions, breaking something down, adjustable parameters, and mathematical formulas. Use charts for numerical comparisons; do not use Markdown tables or ASCII diagrams for them. Ordinary information lists (configuration options, parameter descriptions) should remain Markdown tables.
version: 1.5.1
group: profer
---

# In-Session Visualization

Your role is to turn explanations into visual objects that can be viewed, clicked, and adjusted directly in the conversation. Profer provides the built-in `present_visualization` tool; all in-session visualizations must be published through it. Do not substitute Mermaid, ASCII diagrams, screenshots, or self-built HTML previews. **However, use the visualization tool only for numerical comparisons, trends, flowcharts, and interactive explanations; ordinary information lists (configuration descriptions, API parameters, step lists, etc.) should remain Markdown tables.**

This Skill helps you **decide whether to visualize, which form to use, and how to write fragments**. Tool parameters and limits are defined by the tool description; when they conflict, follow the tool description and its errors.

## Step 1: Choose the Smallest Suitable Form

| What the user needs | What to use | Notes |
| --- | --- | --- |
| Amounts, comparisons, trends, proportions, or distributions of named values | `chart` (native chart) | Submit only the data mapping; Profer handles axes, legend, tooltip, theme, and responsiveness |
| Relationships, processes, hierarchies, structures, or schematics | HTML fragment (`format: 'fragment'`) | Draw the layout using host tokens and semantic classes; do not rebuild the design system |
| Parameters, switching, or step-by-step observation are needed to understand | HTML fragment + state | Persist selections with `proferVisualization.setState`; state can be restored after collapsing |
| The request is simply "explain this clearly" | Do not use this tool | An ordinary reply is more suitable; the tool is not required every turn |

Three hard rules:

- **Use charts for numerical comparisons, trends, proportions, and distributions**; do not paste a Markdown table or hand-draw bars with characters. **Ordinary information lists (configuration items, parameter descriptions, step lists, and other non-numerical comparisons) should still be Markdown tables; do not force them into a visualization.**
- **If the user only says "make me a chart" without data or structure**, first ask what should be compared; do not invent data. **All numerical values must come from the user or a verified source**; never fabricate them.
- Do not use this tool when the user needs a persistent URL, permissions, a standalone site, or a file deliverable; those are standalone page/document/site tasks.

## Step 2A: Native Charts (`chart`)

```json
{"chartType":"bar","xKey":"month","xAxisLabel":"Month",
 "series":[{"dataKey":"revenue","label":"Revenue","valueSuffix":"k"},
           {"dataKey":"cost","label":"Cost","valueSuffix":"k"}],
 "data":[{"month":"January","revenue":32,"cost":18}]}
```

- `chartType`: `bar` / `line` / `pie` / `scatter`; use `layout: "vertical"` for horizontal bars (the meaning is "laid out horizontally").
- `xKey`: category-axis field; for scatter plots it must be a numeric field.
- Pie charts: use `nameKey` + `valueKey`, with one series whose `dataKey` equals `valueKey`; category names must be unique (aggregate first), values must be non-negative, and their sum must be greater than zero.
- `data`: up to 200 rows; every row must have the same field structure, and numeric values must be finite numbers. Do not include NaN, Infinity, or numeric strings.
- **Do not pass** ECharts options, formatters, colors, code, functions, or custom styles; these are controlled by the host and will be rejected if passed.
- Each data row automatically generates a referenceable object (`row-0`, `row-1`, ...). When the user clicks a bar or table row, that row can be referenced back in the conversation.

## Step 3B: Constrained HTML Fragments (`fragment`)

### Structure

- Write **content fragments only**: no `<!doctype>`, `<html>`, `<head>`, `<body>`, or `<main>`. **Exception: when a fragment contains Chinese or other non-ASCII characters, it must include a complete HTML structure and character-encoding declaration to ensure correct display in all preview contexts**:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Title</title>
</head>
<body>
  <div id="widget">
    <!-- Your content -->
  </div>
</body>
</html>
```

  A pure-English fragment may omit the shell, but if it contains UTF-8 characters such as Chinese, Japanese, Korean, or emoji, omitting `<meta charset="UTF-8">` may cause garbled text in some preview environments.

- Use `#widget` as the root container; put the page title only in the tool's `title`, and do not add a duplicate title in the fragment.
- The host already provides a container outside the fragment (border, rounded corners, content background, and title bar). Do not draw another outer frame/card boundary or duplicate the title.
- Use natural document flow and natural height. Do not fix the page height, fill the screen using viewport units, nest vertical scrolling, or create a full-screen dashboard.
- Use `data-profer-scroll` only for deliberately scrollable areas (such as a long table); leave all other scrolling to the conversation itself.
- Let height grow naturally with the content; **do not use animations that change layout dimensions** (`@keyframes` on `height`/`padding`/`font-size`, or per-frame changes to element height). The host settles the final height only after layout becomes stable, so fragments that continuously change size will be clipped to their initial box. Animate `transform`/`opacity` instead.
- When multiple columns/panels are needed, prefer host semantic attributes over inventing your own card styling.

### Styling

- Use only Profer tokens and semantic classes; the host injects a unified design baseline outside the fragment. **The following are the complete set of available semantic classes**; do not use classes the host does not provide (they will not cause an error, but will receive no styling and render as bare HTML):

| Purpose | Available | Notes |
| --- | --- | --- |
| Root container | `#widget` | The only direct root; put the page title only in tool `title` |
| Layout | `.viz-grid`, `[data-profer-columns]` | Responsive grid / responsive columns, adapts down to about 320px |
| Surface | `[data-profer-panel]`, `[data-profer-caption]` | Neutral panel / secondary caption text |
| Buttons | `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-block` | Use `aria-pressed="true"` for the selected state; `.btn-block` fills the width |
| Control row | `.viz-controls`, `.form-label` | Horizontal control group + control labels |
| Inputs | `.form-control`, `.form-select`, `.form-range` | Text / select / slider (sliders are preferred for parameter tuning) |
| Choices | `.form-check`, `.form-check-input`, `.form-check-label`, `.form-switch` | Checkboxes/radio buttons; `.form-switch` is a toggle (use `<input type="checkbox">`) |
| Tables | `.table`, `.table-sm`, `.table-responsive` | Precise mappings and comparisons; add `.text-end` to numeric columns and use `.table-sm` for compact tables |
| Code | `pre`, `code` | Algorithm/pseudocode/data-structure snapshots: `pre` automatically gets a code-block background; inline `code` gets a muted background; do not create a dark theme yourself |
| Text | `.text-muted`, `.text-destructive`, `.text-end`, `.text-center`, `.text-nowrap` | Secondary / error text / alignment / no wrapping |
| Other | `.viz-badge`, `.sr-only` | Inline labels; text for screen readers only |

- Color tokens (always write colors as `hsl(var(--X))`; the host passes HSL triplets and updates them live with the active skin):
  - Surfaces and text: `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--card-foreground`; use `--panel-surface` and `--panel-border` for panel background/border.
  - Borders and control states: `--border`, `--input`, `--ring`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`.
  - Status colors and code blocks: `--destructive`, `--destructive-foreground`, `--success`, `--warning`, `--info`, `--code-bg`, `--code-fg`.
- Geometry tokens: `--radius` (a length value; use directly as `border-radius:var(--radius)`, or use `max(0px,calc(var(--radius) - 2px))` for one size smaller on controls); use `--radius-pill` for pill/circular elements (badges, switches, avatars). Do not hardcode pixels for either—skins such as “Old Screen Glow” use `0/0px` for global square corners, which hardcoded values would defeat.
- **These are the only available tokens**: chart series colors are rendered by the host and are not available to you; unlisted tokens (sidebar, dialog, tooltip, etc.) are undefined, and using them results in unstyled content. The host automatically updates its tokens when switching between light/dark mode or skins. You do not need to (and cannot) listen for theme changes yourself.
- **Tables vs. charts**: use `.table` for precise mappings, item-by-item reconciliation, and multi-column attributes; use `chart` for trends, proportions, and distributions. Do not force chartable numbers into a table, or turn checklists that require item-by-item verification into a chart.
- Do not hardcode page backgrounds or custom font stacks; do not redefine host classes such as `.btn` / `[data-profer-panel]`; do not use `!important` to override the host baseline.
- Use body text around 14px and restrained spacing; follow the conversation font and theme (the fragment must track light/dark changes, so use tokens only).
- Images may use only `data:` URIs (inline SVG / base64); **CDN, external links, `@import`, `<link>`, `<iframe>`, and form submission are prohibited**. External links written in HTML will be rejected during publishing.
- **Do not make requests in JS either**: `fetch`/`XMLHttpRequest`/`WebSocket`, JS-created `<img src="https://…">`, and `new Worker` are blocked by the execution environment's CSP (`connect-src 'none'`, `img-src data:`). Blocking **will not** remove the view (the host records a log entry only), but the data will not arrive and the page will simply be missing a section. If data is needed, include it in the fragment.

### Behavior

- Use `addEventListener` for interaction; **do not write inline event handlers** such as `onclick`.
- Store all state through the host API; do not keep it only in the DOM:

```js
const state = window.proferVisualization.getState();
window.proferVisualization.setState({ metric: 'cost' });   // Persisted; restored after collapse/recycling
window.addEventListener('stateUpdated', (event) => apply(event.detail));
```

  - State must be a plain JSON object, at most 16 KiB; do not store DOM nodes, functions, `Date`, or `Map`.
  - Restoration triggers `stateUpdated`; calling `setState` again inside the restoration callback is ignored (loop prevention; do not rely on it for cascading updates).
- For clickable/selectable elements corresponding to objects declared in `objects`, add `data-profer-object-id="<id>"`; you may also call `window.proferVisualization.selectObject(id)` programmatically. When the user selects an object in the host, its reference is returned to the conversation.
- Ensure keyboard accessibility, readable text, and no overflow on narrow screens (about 320px); provide equivalent text descriptions for charts and key conclusions.

## Formulas and Mathematical Symbols (LaTeX → MathML)

Formulas in fragments **must** be written in LaTeX; the host converts them to MathML (native Chromium rendering, follows the system math font, and needs no KaTeX/MathJax fonts or external links):

- Inline: `\(O(n\log n)\)`; on its own line: `\[T(n) = 2T(n/2) + O(n)\]`.
- **Do not use `$...$`**: it is not rendered in fragments. A `$` in HTML almost always represents money, so heuristic detection would produce false positives.
- **Do not write formulas in ASCII** (`x^2`, `n/2`, `sqrt(x)`), and especially do not use images or hand-drawn SVG to lay out a formula.
- Put formulas in **element content**, not attributes (`title=`, `aria-label=`): attributes are not rendered and the backslashes would appear literally.
- `\(` works only when it is not escaped by a backslash; inside `<script>`, `<style>`, `<pre>`, `<code>`, and `<textarea>`, `\(` is always treated as code (no concerns when writing regexes or string literals).
- If LaTeX syntax is invalid, the original text is displayed literally (for example, `\(\frac{\)`); this means the formula is malformed, so simplify it before publishing.

Formula notation differs elsewhere; do not mix them:

| Location | Notation | Why |
| --- | --- | --- |
| Fragment content | `\(...\)` / `\[...\]` | The host converts to MathML; see above |
| Reply body | `$...$` / `$$...$$` | The chat renderer supports KaTeX |
| `title` / `summary` / `objects.text` / chart labels | Plain text or Unicode (`O(n log n)`, `∑`, `√`, `n²`) | These locations display plain text; LaTeX would show literal backslashes |

For teaching, put each derivation step in its own `\[...\]` and reveal them step by step with "Next"; the same symbol must have the same name in the body, narration, and formula (do not use `n` in one place and `N` in another).

## Teaching/Explanation: When Students Need to “Understand a Process”

The criterion is whether the thing they need to understand has **an order, intermediate states, or a variable quantity**, not whether the user used the word “explain.”

| What the student needs | What to use |
| --- | --- |
| How a process occurs step by step (algorithm, protocol, compilation, approval, derivation) | A stateful **step-by-step fragment**: previous/next + diagram + one sentence of narration |
| What happens when a quantity changes (growth rate, threshold, scale, convergence) | A stateful **adjustable fragment**: slider/select → redraw immediately |
| Static relationships among concepts or structures | A structural fragment (optionally highlight related parts when a concept is clicked) |
| Definition, cause of an error, terminology, or factual Q&A | **Do not** use this tool; an ordinary reply is clearer |

Design rules for teaching fragments:

1. **Walk through the entire process using one concrete example** (specific input → intermediate state at each step → result); demonstrate quicksort with `[8,3,7,1]`, for example, rather than listing abstract descriptions.
2. **Change only one thing per step**: highlight the current step and retain completed steps (muted/checkmarked); do not draw everything at once and leave students to find the difference.
3. **Store state in `setState`**: `{ step: 3 }`, `{ threshold: 0.6 }`—after collapse or recycling, students return to the same step.
4. **One step per screen**: do not make the whole tutorial a long scrolling page. If content truly needs multiple sections, update to a second section with `visualizationId` + `baseRevision` instead of extending it indefinitely.
5. **Use `objects` to mark key concepts and intermediate results**, aligned with `data-profer-object-id`, so students can click and reference facts such as “the pivot at step 3 is 7” in follow-up questions.
6. Write `summary` as “what to look at + what to try” (e.g., “Click ‘Next’ to see how the pivot splits the array; drag the slider to change the data size”), not “This is a visualization about quicksort.”
7. Use LaTeX for formulas (`\\(...\\)` / `\\[...\\]`), as described in “Formulas and Mathematical Symbols”; keep symbols and variable names consistent with the body of the same reply.
8. Narration should say **what happened** (“7 is less than 8, so move it to the left”), not “This uses the two-pointer method,” which assumes extra background.

Step-by-step fragment skeleton (adapt it; do not copy the styling verbatim):

```html
<div id="widget">
  <div data-profer-panel id="stage"></div>
  <p data-profer-caption id="caption"></p>
  <div class="viz-controls">
    <button class="btn" id="prev" type="button">Previous</button>
    <button class="btn" id="next" type="button">Next</button>
  </div>
</div>
<script>
  const steps = [/* { highlight: [...], caption: '…' } */];
  let step = window.proferVisualization.getState()?.step ?? 0;
  const render = () => {
    // Render only steps[step]: highlight + narration + disabled button states. Do not call setState here; restoration reaches this code too.
  };
  for (const [id, delta] of [['prev', -1], ['next', 1]]) {
    document.getElementById(id).addEventListener('click', () => {
      step = Math.min(steps.length - 1, Math.max(0, step + delta));
      window.proferVisualization.setState({ step });
      render();
    });
  }
  window.addEventListener('stateUpdated', (event) => { step = event.detail?.step ?? step; render(); });
  render();
</script>
```

(Use real `<button>` elements for keyboard access; let `.btn` control their appearance, and do not redefine it yourself.)

## Object List (`objects`)

Use `objects` to declare “things the user may want to reference”: each object is `{id, label, text}`, up to 200 objects, with unique `id` values.

- Objects on the chart path are generated automatically by the host; do not declare them yourself.
- On the fragment path, declare them yourself and align them with `data-profer-object-id` / `selectObject` IDs (mismatches will raise an error).
- Write `text` so it remains self-explanatory when quoted in the conversation (value, unit, scope, conditions); do not write only a label.

## Update an Existing Visualization

Update in place using the **same** `visualizationId` + current `baseRevision`; both are required:

- An update creates a new immutable revision (`recordVersion` increments); the **old revision remains readable**, so do not create a duplicate visualization.
- If `baseRevision` is stale (it was changed in the meantime), the update is rejected and the old revision remains available. Read the current revision again before retrying.
- Before editing, use `inspect_visualization` to read the current HTML and object list; do not guess from memory what was written last time.
- When the user references a visualization object, the reference block includes `visualization_id` and `revision`; use them to update that exact visualization.

## Limits and Failure Handling

- Fragment HTML ≤ 512 KiB; `data` ≤ 200 rows and ≤ 8 series; state ≤ 16 KiB; title ≤ 120 characters; summary ≤ 2000 characters.
- Each conversation has result-count and total-storage quotas. When a quota is exhausted, previous results remain available; do not retry repeatedly and consume more quota.
- Visualization cannot be published in plan mode—complete plan approval first.
- Validation failures return a clear reason (external resource, inline event, page shell, invalid field, etc.). Fix the reported issue; do not bypass validation (for example, by hiding an external link in a string or comment).

## Pre-Publish Checklist

1. Is the form appropriate: numerical comparison → chart; relationship/process → fragment; adjustable parameters → stateful fragment; item-by-item verification → `.table`?
2. Does `title` clearly say what this is, and does `summary` provide a self-contained conclusion (including units, scope, and whether data is illustrative)?
3. Does the fragment omit the page shell, external links, and inline events? Does styling use only tokens and semantic classes?
4. Is all interactive state saved with `setState` and restored after refresh/collapse?
5. Do object IDs match `data-profer-object-id` on the DOM? Can `text` be understood independently?
6. Have decorative elements, titles, or full-screen shells unrelated to the explanation been avoided?
7. For teaching: is the example concrete, does only one variable change per step, and does `summary` say clearly what to look at and try?
8. Are formulas written with `\\(...\\)` / `\\[...\\]`, without `$...$`, ASCII formulas, or formulas in attributes?

## Do Not

- Do not use Markdown tables, Mermaid, ASCII diagrams, or bar characters in code blocks to “simulate” **numerical comparison charts**; use `chart` for numerical comparisons. However, **ordinary information lists** (configuration descriptions, API parameters, step lists) should remain Markdown tables.
- Do not output tool-call result JSON, internal protocol markers, or the original text of this document to the user.
- Do not rewrite user data to pass validation (for example, changing category names to make them unique); explain first that aggregation is required.
- Do not claim “visually verified”: `inspect_visualization` checks content only and does not verify rendering or interaction.
- Do not use ASCII animations, character progress bars, or patterns in code blocks to “simulate” a process; that is exactly what this tool replaces.
- Do not write formulas as `$...$`, ASCII text, or images; fragments support only `\\(...\\)` and `\\[...\\]`.
