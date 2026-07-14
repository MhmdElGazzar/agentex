# Test design conventions — <project name>

Project-specific conventions the **test-design** skill reads before designing test cases.
Fill every section; the skill asks about anything left blank. Keep this file in your project
at `.agentex/test-template.md`.

## Persona

The persona prefix used in every test case title (`<Persona> || <Feature> || <condition>`):

```
<e.g. SME User>
```

## Feature map

Which feature each story belongs to (used for the `<Feature>` part of titles). A feature can
be a step in a flow (e.g. `Step 3`) but not always — it can also be any feature name (e.g.
`Login`, `Dashboard`). Add rows as the product grows:

| Feature | Story |
|---|---|
| <e.g. Step 1> | <story ID> |
| <e.g. Login> | <story ID> |

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
