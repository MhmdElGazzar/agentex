# Test design conventions — <project name>

Project-specific conventions the **test-design** skill reads before designing test cases.
Fill every section; the skill asks about anything left blank. Keep this file in your project
at `.agentex/test-template.md`.

## Persona

The persona prefix used in every test case title (`<Persona> || Step[N] || <condition>`):

```
<e.g. SME User>
```

## Journey step map

Which journey step each story/feature belongs to (used for the `Step[N]` part of titles).
Add rows as the journey grows:

| Step | Story / feature |
|---|---|
| Step 1 | <story ID or feature name> |
| Step 2 | <story ID or feature name> |

## Standard setup steps

The ActionSteps every test case starts with (adjust prerequisites per step):

1. `Given the customer lands on the <app> homepage`
2. `When the customer clicks <entry CTA> and completes Steps <1..N-1>`

## Languages for text checks

Languages every "page text" test case must cover (e.g. `EN, AR`):

```
<languages>
```

## Project-specific condition categories

Elements that always get their own test case when a story includes them (in addition to the
skill's generic categories). Examples: a helper box Q&A, a read-only company-details panel.

| Element | Test case title | What to check |
|---|---|---|
| <e.g. helper box> | `user checks the helper box` | <Q&A text in every supported language> |
| <e.g. read-only info panel> | `user checks the <panel> section` | <data source correct; all fields read-only> |

## Design reference

Where the design link lives in stories (e.g. "story description, under 'Figma Design Link'"):

```
<location>
```
